// Package config 负责 v2 server 的启动配置：数据根、监听地址、本地 token。
//
// 与旧版 windows/ 的约定保持一致：数据根就是仓库根目录（queue.json / papers/ /
// library/ / app/data 所在处），Windows 版不复制数据，只在其下新建 app/data/v2/。
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ReadyPrefix 是 server 打印到 stdout 的就绪标记前缀，desktop 壳按行匹配它。
// 格式：CBCT_V2_READY {"port":45321,"token":"...","dataRoot":"..."}
const ReadyPrefix = "CBCT_V2_READY "

// TokenBytes 决定 token 长度；32 字节 = 64 个 hex 字符。
const TokenBytes = 32

type Config struct {
	DataRoot  string
	Host      string
	Port      int
	Token     string
	StaticDir string
	// DevInfoPath 非空时，就绪信息同时写入该 JSON 文件，供 Vite dev proxy 读取。
	DevInfoPath string
	// ExitOnStdinEOF：stdin 关闭（desktop 壳退出）即优雅停机，防止孤儿进程。
	ExitOnStdinEOF bool
}

func (c Config) Addr() string { return fmt.Sprintf("%s:%d", c.Host, c.Port) }

// DBPath 是 v2 权威存储位置；与旧版 JSON 同根但不同目录，互不覆盖。
func (c Config) DBPath() string {
	return filepath.Join(c.DataRoot, "app", "data", "v2", "reader.db")
}

// NewToken 生成一次性本地 bearer token。每次启动都不同：渲染进程只能从父进程拿，
// 同机其他进程即使能连 127.0.0.1 也没有凭据。
func NewToken() (string, error) {
	buf := make([]byte, TokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成 token 失败: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// NormalizeHost 只允许回环地址。非回环一律拒绝——server 会读论文全文、持有 AI key，
// 绝不允许暴露到局域网。
func NormalizeHost(host string) (string, error) {
	switch host {
	case "", "127.0.0.1", "localhost":
		return "127.0.0.1", nil
	case "::1":
		return "::1", nil
	default:
		return "", fmt.Errorf("拒绝绑定非回环地址 %q（server 只允许 127.0.0.1 或 ::1）", host)
	}
}

// ResolveDataRoot 定位数据根。explicit 非空则直接使用（必须存在且是目录）；
// 否则从 startDir 逐级向上找第一个像数据根的目录。
func ResolveDataRoot(explicit, startDir string) (string, error) {
	if explicit != "" {
		abs, err := filepath.Abs(explicit)
		if err != nil {
			return "", err
		}
		fi, err := os.Stat(abs)
		if err != nil || !fi.IsDir() {
			return "", fmt.Errorf("数据根目录不存在或不是目录：%s", abs)
		}
		return abs, nil
	}
	dir, err := filepath.Abs(startDir)
	if err != nil {
		return "", err
	}
	for {
		if looksLikeDataRoot(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("未能自动定位数据根目录，请从 Windows 版目录启动或用 --data-root 指定")
}

func looksLikeDataRoot(dir string) bool {
	if fi, err := os.Stat(filepath.Join(dir, "queue.json")); err == nil && !fi.IsDir() {
		return true
	}
	if fi, err := os.Stat(filepath.Join(dir, "papers")); err == nil && fi.IsDir() {
		return true
	}
	// A clean v2 checkout has no legacy queue or private library. Its repository
	// root is the default data root; runtime files are created only when needed.
	for _, marker := range []string{filepath.Join("windows", "package.json"), filepath.Join("windows", "apps", "server", "go.mod")} {
		if fi, err := os.Stat(filepath.Join(dir, marker)); err != nil || fi.IsDir() {
			return false
		}
	}
	return true
}
