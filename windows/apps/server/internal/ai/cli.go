package ai

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// Resolve the desktop bundle on every launch: its version directory changes
// after app updates, and Explorer shortcuts do not inherit Codex's PATH.
func resolveCLI(name string) (executable, source string, err error) {
	if name == "codex" {
		if explicit := os.Getenv("CBCT_CODEX_PATH"); explicit != "" {
			if info, statErr := os.Stat(explicit); statErr == nil && !info.IsDir() {
				return explicit, "override", nil
			}
			return "", "", fmt.Errorf("CBCT_CODEX_PATH 未指向可用的 Codex 程序")
		}
		if runtime.GOOS == "windows" {
			local := os.Getenv("LOCALAPPDATA")
			if local == "" {
				if home, homeErr := os.UserHomeDir(); homeErr == nil {
					local = filepath.Join(home, "AppData", "Local")
				}
			}
			if local != "" {
				files, _ := filepath.Glob(filepath.Join(local, "OpenAI", "Codex", "bin", "*", "codex.exe"))
				var newest time.Time
				for _, file := range files {
					info, statErr := os.Stat(file)
					if statErr == nil && !info.IsDir() && (executable == "" || info.ModTime().After(newest)) {
						executable, newest = file, info.ModTime()
					}
				}
				if executable != "" {
					return executable, "desktop", nil
				}
			}
		}
	}
	executable, err = exec.LookPath(name)
	if err != nil {
		if name == "codex" {
			return "", "", fmt.Errorf("未找到 Codex Desktop 或 CLI，请先安装并登录 Codex")
		}
		return "", "", fmt.Errorf("未找到 %s CLI，请先安装并在终端登录", name)
	}
	return executable, "cli", nil
}

func CLIAvailable(name string) bool {
	_, _, err := resolveCLI(name)
	return err == nil
}

type CodexConnection struct {
	Available     bool   `json:"available"`
	Authenticated bool   `json:"authenticated"`
	Source        string `json:"source"`
	Message       string `json:"message"`
}

// Ask Codex itself about authentication; never read or copy its token files.
func CodexStatus(ctx context.Context) CodexConnection {
	_, source, err := resolveCLI("codex")
	if err != nil {
		return CodexConnection{Message: err.Error()}
	}
	status := CodexConnection{Available: true, Source: source}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd, err := cliCommand(ctx, "codex", []string{"login", "status"})
	if err == nil {
		cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
		err = cmd.Run()
	}
	status.Authenticated = err == nil
	if status.Authenticated {
		status.Message = "已检测到 Codex 登录，可直接使用，无需填写 API Key"
	} else if ctx.Err() != nil {
		status.Message = "Codex 登录检测超时，请打开 Codex Desktop 确认登录后重试"
	} else {
		status.Message = "已找到 Codex，但未确认登录；请在 Codex Desktop 登录后重新打开设置"
	}
	return status
}
