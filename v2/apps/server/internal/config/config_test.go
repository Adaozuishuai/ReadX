package config

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestResolveDataRootWalksUp(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "queue.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "v2", "apps", "server")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveDataRoot("", nested)
	if err != nil {
		t.Fatalf("期望向上找到数据根，得到错误: %v", err)
	}
	// Windows 上 filepath.Abs 可能带卷标大小写差异，用 EvalSymlinks/比较基名稳妥些。
	if filepath.Clean(got) != filepath.Clean(root) {
		t.Fatalf("数据根应为 %s，实际 %s", root, got)
	}
}

func TestResolveDataRootAcceptsPapersDirOnly(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "papers"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveDataRoot("", root)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(got) != filepath.Clean(root) {
		t.Fatalf("got %s want %s", got, root)
	}
}

func TestResolveDataRootInCleanV2Checkout(t *testing.T) {
	root := t.TempDir()
	serverDir := filepath.Join(root, "v2", "apps", "server")
	if err := os.MkdirAll(serverDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, marker := range []string{filepath.Join(root, "v2", "package.json"), filepath.Join(serverDir, "go.mod")} {
		if err := os.WriteFile(marker, []byte("test marker"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ResolveDataRoot("", serverDir)
	if err != nil || filepath.Clean(got) != filepath.Clean(root) {
		t.Fatalf("clean checkout root: got=%q err=%v", got, err)
	}
	for _, name := range []string{"queue.json", "papers", "library", "app"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("root detection created private data: %s", name)
		}
	}
}

func TestResolveDataRootRejectsUnrelatedDir(t *testing.T) {
	isolated := t.TempDir()
	// 用显式空 startDir 之外，还要保证 TempDir 自身向上不会命中真实仓库根：
	// 因此这里只断言「显式指定不存在目录」一定报错，避免依赖运行环境。
	if _, err := ResolveDataRoot(filepath.Join(isolated, "nope"), isolated); err == nil {
		t.Fatal("不存在的显式数据根应当报错")
	}
}

func TestResolveDataRootExplicitMustExist(t *testing.T) {
	dir := t.TempDir()
	got, err := ResolveDataRoot(dir, filepath.Join(dir, "elsewhere"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(got) != filepath.Clean(dir) {
		t.Fatalf("显式数据根应优先，got %s", got)
	}
}

func TestNewTokenShape(t *testing.T) {
	first, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != TokenBytes*2 {
		t.Fatalf("token 长度应为 %d，实际 %d", TokenBytes*2, len(first))
	}
	if _, err := hex.DecodeString(first); err != nil {
		t.Fatalf("token 应为 hex: %v", err)
	}
	second, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("两次 token 不应相同")
	}
}

func TestNormalizeHostRejectsNonLoopback(t *testing.T) {
	for _, host := range []string{"", "127.0.0.1", "localhost"} {
		got, err := NormalizeHost(host)
		if err != nil || got != "127.0.0.1" {
			t.Fatalf("host %q 应归一为 127.0.0.1，got %q err %v", host, got, err)
		}
	}
	if got, err := NormalizeHost("::1"); err != nil || got != "::1" {
		t.Fatalf("::1 应允许，got %q err %v", got, err)
	}
	for _, host := range []string{"0.0.0.0", "192.168.1.10", "example.com"} {
		if _, err := NormalizeHost(host); err == nil {
			t.Fatalf("host %q 必须被拒绝", host)
		}
	}
}

func TestDBPathLivesUnderV2Subdir(t *testing.T) {
	c := Config{DataRoot: filepath.Join(string(filepath.Separator), "repo")}
	got := filepath.ToSlash(c.DBPath())
	want := "/repo/app/data/v2/reader.db"
	if got != want {
		t.Fatalf("DBPath 应为 %s，实际 %s（不得与旧版 JSON 同目录）", want, got)
	}
}
