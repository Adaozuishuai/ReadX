package latex

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const RtexVersion = "0.0.5"

type RealtimeRuntime struct {
	Version    string `json:"version"`
	Ready      bool   `json:"ready"`
	Installed  bool   `json:"installed"`
	CanInstall bool   `json:"canInstall"`
	Engine     string `json:"-"`
	Node       string `json:"-"`
	Bridge     string `json:"-"`
	LuaLaTeX   string `json:"-"`
	Reason     string `json:"reason,omitempty"`
}

func rtexInstallDir(dataRoot string) string {
	return filepath.Join(dataRoot, "app", "runtime", "rtex", RtexVersion)
}

func rtexAsset() (string, string) {
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "windows/amd64":
		return "rtex-x86_64-pc-windows-msvc.zip", "b81bd6c32506a649471f5ffaf0cc83a0659e7cc7d241a5bf0ff3f66977eedae5"
	case "darwin/arm64":
		return "rtex-aarch64-apple-darwin.tar.gz", "32aee0c610d1e130abb65109db6db340054b0b5eebc07885728113e714d8b1e3"
	case "darwin/amd64":
		return "rtex-x86_64-apple-darwin.tar.gz", "199529e9c01a6aefde869d5f98628763411f3db4c9d476f8e3e22d0dfdb26bf0"
	case "linux/amd64":
		return "rtex-x86_64-unknown-linux-gnu.tar.gz", "bfafbcf81b4e5a1bee370f36f6b455fe9656b858d7549fe97fc7966f804c42c9"
	case "linux/arm64":
		return "rtex-aarch64-unknown-linux-gnu.tar.gz", "931721f82079db29d0695380566308ebdf0231e55ec3a6e3004308f36dc8641f"
	}
	return "", ""
}

func DetectRealtime(ctx context.Context, dataRoot string) RealtimeRuntime {
	asset, _ := rtexAsset()
	r := RealtimeRuntime{Version: RtexVersion, CanInstall: asset != ""}
	exe := "rtex"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	candidates := []string{os.Getenv("READX_RTEX_BIN"), filepath.Join(rtexInstallDir(dataRoot), "bin", exe)}
	if p, err := exec.LookPath(exe); err == nil {
		candidates = append(candidates, p)
	}
	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			r.Engine = p
			break
		}
	}
	r.Installed = r.Engine != ""
	for _, base := range []string{os.Getenv("READX_RESOURCES_DIR"), filepath.Join(os.Getenv("READX_RESOURCES_DIR"), "resources"), filepath.Join(os.Getenv("READX_WORKSPACE_DIR"), "resources"), "resources", "../../resources"} {
		p := filepath.Join(base, "realtime-tex", "bridge.mjs")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			r.Bridge, _ = filepath.Abs(p)
			break
		}
	}
	r.Node = os.Getenv("CBCT_NODE_BIN")
	if r.Node == "" {
		r.Node, _ = exec.LookPath("node")
	}
	for _, tool := range DetectToolchains(ctx, false).Engines {
		if tool.Name == "lualatex" && tool.Usable {
			r.LuaLaTeX = tool.Path
			break
		}
	}
	switch {
	case r.Bridge == "":
		r.Reason = "缺少 ReadX 实时预览资源，请更新 ReadX。"
	case r.Node == "":
		r.Reason = "未找到 Node.js，请安装 Node.js 后重启 ReadX。"
	case r.LuaLaTeX == "":
		r.Reason = "需要本机 LuaLaTeX，请安装 MiKTeX 或 TeX Live 后重启 ReadX。"
	case !r.Installed:
		r.Reason = "首次使用需要下载 rtex 实时排版引擎（v" + RtexVersion + "）。"
	default:
		r.Ready = true
	}
	return r
}

var rtexInstallMu sync.Mutex

// InstallRealtime installs only the pinned upstream release, verified before extraction.
func InstallRealtime(ctx context.Context, dataRoot string) error {
	rtexInstallMu.Lock()
	defer rtexInstallMu.Unlock()
	name, checksum := rtexAsset()
	if name == "" {
		return fmt.Errorf("当前系统没有可用的 rtex 安装包")
	}
	dest := rtexInstallDir(dataRoot)
	if _, err := os.Stat(filepath.Join(dest, "share", "rtex", "tex")); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(filepath.Dir(dest), ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://github.com/HenryXiaoYang/realtime-tex/releases/download/v"+RtexVersion+"/"+name, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载 rtex 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("下载 rtex: HTTP %d", resp.StatusCode)
	}
	archive := filepath.Join(stage, name)
	f, err := os.Create(archive)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, hash), io.LimitReader(resp.Body, 128<<20))
	f.Close()
	if copyErr != nil {
		return copyErr
	}
	if n == 128<<20 || hex.EncodeToString(hash.Sum(nil)) != checksum {
		return fmt.Errorf("rtex 安装包 SHA-256 校验失败，请重试下载")
	}
	out := filepath.Join(stage, "runtime")
	write := func(raw string, reader io.Reader, mode os.FileMode) error {
		// Release archives have one top-level directory; links and paths outside it are rejected.
		parts := strings.SplitN(strings.ReplaceAll(raw, "\\", "/"), "/", 2)
		if len(parts) < 2 || parts[1] == "" {
			return nil
		}
		rel, e := NormalizeRelative(parts[1])
		if e != nil {
			return e
		}
		target := filepath.Join(out, filepath.FromSlash(rel))
		if e = os.MkdirAll(filepath.Dir(target), 0755); e != nil {
			return e
		}
		file, e := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_EXCL, mode.Perm())
		if e != nil {
			return e
		}
		_, e = io.Copy(file, io.LimitReader(reader, 64<<20))
		closeErr := file.Close()
		if e != nil {
			return e
		}
		return closeErr
	}
	if strings.HasSuffix(name, ".zip") {
		z, e := zip.OpenReader(archive)
		if e != nil {
			return e
		}
		defer z.Close()
		for _, entry := range z.File {
			if entry.FileInfo().IsDir() {
				continue
			}
			if entry.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("rtex 安装包包含链接")
			}
			rd, e := entry.Open()
			if e != nil {
				return e
			}
			e = write(entry.Name, rd, 0755)
			rd.Close()
			if e != nil {
				return e
			}
		}
	} else {
		file, e := os.Open(archive)
		if e != nil {
			return e
		}
		defer file.Close()
		gz, e := gzip.NewReader(file)
		if e != nil {
			return e
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			entry, e := tr.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return e
			}
			if entry.Typeflag == tar.TypeDir {
				continue
			}
			if entry.Typeflag != tar.TypeReg {
				return fmt.Errorf("rtex 安装包包含非常规文件")
			}
			if e = write(entry.Name, tr, os.FileMode(entry.Mode)); e != nil {
				return e
			}
		}
	}
	if _, err := os.Stat(filepath.Join(out, "share", "rtex", "tex")); err != nil {
		return fmt.Errorf("rtex 安装包缺少 TeX 支持文件: %w", err)
	}
	return os.Rename(out, dest)
}
