package httpapi

import (
	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) handleAISettings(w http.ResponseWriter, r *http.Request) {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	if r.Method != "PUT" {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
	}
	if r.Method == "PUT" {
		s.settingsMu.Lock()
		defer s.settingsMu.Unlock()
		var body struct {
			Provider string `json:"provider"`
			BaseURL  string `json:"baseURL"`
			Model    string `json:"model"`
			APIKey   string `json:"apiKey"`
			ClearKey bool   `json:"clearKey"`
		}
		if decodeJSON(w, r, &body) != nil {
			return
		}
		if body.Provider != "openai" && body.Provider != "anthropic" && body.Provider != "codex" && body.Provider != "claude" && body.Provider != "kimi" {
			writeError(w, 400, "不支持的 AI 接入方式")
			return
		}
		raw := map[string]any{}
		prior, err := os.ReadFile(path)
		if err == nil {
			if json.Unmarshal(prior, &raw) != nil {
				writeError(w, 422, "原配置损坏，已拒绝覆盖")
				return
			}
		} else if !os.IsNotExist(err) {
			writeError(w, 500, "读取配置失败")
			return
		}
		// Keep credentials per provider AND endpoint. Switching destinations must never
		// forward a key that belonged to a different service.
		connections, _ := raw["connections"].(map[string]any)
		if connections == nil {
			connections = map[string]any{}
		}
		previousProvider, _ := raw["provider"].(string)
		if previousProvider == "" {
			previousProvider = "openai"
		}
		previousURL, _ := raw["baseURL"].(string)
		previousKey, _ := raw["apiKey"].(string)
		connections[previousProvider+"|"+strings.TrimRight(previousURL, "/")] = previousKey
		destination := body.Provider + "|" + strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
		savedKey, _ := connections[destination].(string)
		if body.ClearKey {
			savedKey = ""
		} else if strings.TrimSpace(body.APIKey) != "" {
			savedKey = strings.TrimSpace(body.APIKey)
		}
		connections[destination] = savedKey
		raw["connections"] = connections
		raw["provider"] = body.Provider
		raw["baseURL"] = strings.TrimSpace(body.BaseURL)
		raw["model"] = strings.TrimSpace(body.Model)
		raw["apiKey"] = savedKey
		encoded, _ := json.MarshalIndent(raw, "", "  ")
		var cfg ai.Config
		_ = json.Unmarshal(encoded, &cfg)
		if !cfg.IsCLI() {
			check := cfg
			check.APIKey = "validate"
			if _, err := check.Endpoint(); err != nil {
				writeError(w, 400, "请输入完整 API 地址，例如 https://api.openai.com/v1")
				return
			}
		}
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			writeError(w, 500, "创建配置目录失败")
			return
		}
		f, err := os.CreateTemp(filepath.Dir(path), ".ai-config-*")
		if err != nil {
			writeError(w, 500, "保存配置失败")
			return
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		_ = f.Chmod(0600)
		_, err = f.Write(encoded)
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Rename(tmp, path)
		}
		if err != nil {
			writeError(w, 500, "保存配置失败")
			return
		}
	}
	cfg, _ := ai.LoadConfig(path)
	writeJSON(w, 200, map[string]any{"provider": cfg.ProviderName(), "baseURL": cfg.PublicBaseURL(), "model": cfg.Model, "keyConfigured": cfg.APIKey != "", "status": cfg.Redact(), "cli": map[string]bool{"codex": ai.CLIAvailable("codex"), "claude": ai.CLIAvailable("claude"), "kimi": ai.CLIAvailable("kimi")}})
}
func (s *Server) handleAIProbe(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.aiConfig()
	if err != nil || !cfg.Ready() {
		writeError(w, 409, "请先保存可用的 AI 设置；CLI 需先安装并登录")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	answer, err := ai.NewClient(cfg).Generate(ctx, "仅回复 OK，不使用工具。", "连接测试", 0)
	if err != nil {
		writeError(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "answer": answer})
}
