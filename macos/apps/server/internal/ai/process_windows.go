package ai

import (
	"net/url"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

func configureCLIProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Cancel = func() error { return terminateCLIProcess(cmd) }
}

// Native Codex does not inherit WinINet's proxy settings. Honor explicit proxy
// environment variables first, then use the user's existing Windows proxy.
func configureCLIEnvironment(cmd *exec.Cmd) {
	existing := map[string]bool{}
	for _, value := range cmd.Env {
		key, value, _ := strings.Cut(value, "=")
		if value != "" {
			existing[strings.ToUpper(key)] = true
		}
	}
	if existing["ALL_PROXY"] {
		return
	}
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	enabled, _, err := key.GetIntegerValue("ProxyEnable")
	if err != nil || enabled != 1 {
		return
	}
	server, _, err := key.GetStringValue("ProxyServer")
	if err != nil {
		return
	}
	for _, scheme := range []string{"http", "https"} {
		envKey := strings.ToUpper(scheme) + "_PROXY"
		if existing[envKey] {
			continue
		}
		proxy := strings.TrimSpace(server)
		if strings.Contains(proxy, "=") {
			proxy = ""
			for _, entry := range strings.Split(server, ";") {
				kind, address, ok := strings.Cut(entry, "=")
				if ok && strings.EqualFold(strings.TrimSpace(kind), scheme) {
					proxy = strings.TrimSpace(address)
				}
			}
		}
		if proxy == "" {
			continue
		}
		if !strings.Contains(proxy, "://") {
			proxy = "http://" + proxy
		}
		parsed, err := url.Parse(proxy)
		if err == nil && parsed.Hostname() != "" && (parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "socks5") {
			cmd.Env = append(cmd.Env, envKey+"="+proxy)
		}
	}
}

func terminateCLIProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	kill := exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return kill.Run()
}
