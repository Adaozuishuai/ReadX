package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
)

// LaTeX 工作区可以单独指定模型渠道，不影响全局 AI 助手设置。
//
// 为什么需要它：全局默认可能是一个只适合阅读/翻译的渠道（例如 Codex 桥），
// 而那个渠道在后台服务进程里未必可用；让 LaTeX 单独指向一个 HTTP 渠道，
// 既能让写作助手真的能用，又不会把阅读链路的模型换掉。
//
// 密钥不在这里另存一份：仍然放在 connections 的「渠道|地址」命名空间下（见 ai_settings.go），
// 所以「绝不把别的地址的 Key 发到当前地址」这条规则对 LaTeX 同样成立。
type latexAISettings struct {
	Provider        string `json:"provider"`
	BaseURL         string `json:"baseURL"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoningEffort"`
}

// latexSupportedProviders 只允许 HTTP 渠道。
//
// CLI 渠道（codex/claude/kimi）靠拉起本机命令行进程，在后台服务里经常拿不到桌面版上下文
// （实际就发生过「Codex 模型目录未响应」）；与其让用户在那里绕，不如在设置入口就说清楚。
func latexSupportedProviders(provider string) bool {
	return provider == "openai" || provider == "anthropic"
}

// readLatexAISettings 读 app/config.json 里的 latexAI 段（不存在时返回零值与 false）。
func (s *Server) readLatexAISettings() (latexAISettings, bool, error) {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return latexAISettings{}, false, nil
		}
		return latexAISettings{}, false, fmt.Errorf("读取配置失败: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return latexAISettings{}, false, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
	}
	section, ok := raw["latexAI"].(map[string]any)
	if !ok {
		return latexAISettings{}, false, nil
	}
	var settings latexAISettings
	settings.Provider, _ = section["provider"].(string)
	settings.BaseURL, _ = section["baseURL"].(string)
	settings.Model, _ = section["model"].(string)
	settings.ReasoningEffort, _ = section["reasoningEffort"].(string)
	settings.Provider = strings.TrimSpace(settings.Provider)
	settings.BaseURL = strings.TrimSpace(settings.BaseURL)
	if settings.Provider == "" || settings.BaseURL == "" {
		return latexAISettings{}, false, nil
	}
	return settings, true, nil
}

// connectionKey 取某个「渠道|地址」下保存的 Key。
//
// 与全局设置的规则完全一致：Key 属于它被填进去时的那一对渠道与地址。
func (s *Server) connectionKey(provider, baseURL string) string {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	body, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ""
	}
	connections, _ := raw["connections"].(map[string]any)
	key, _ := connections[provider+"|"+strings.TrimRight(baseURL, "/")].(string)
	return key
}

// latexAIConfig 返回 LaTeX 工作区实际使用的 AI 配置：有单独设置就用它，否则跟随全局。
func (s *Server) latexAIConfig() (ai.Config, error) {
	global, err := s.aiConfig()
	if err != nil {
		// 全局配置读不出来（例如文件缺失）时，若 LaTeX 有单独设置照样应该能用。
		settings, ok, settingsErr := s.readLatexAISettings()
		if settingsErr != nil || !ok {
			return ai.Config{}, err
		}
		return ai.Config{}.WithChannel(settings.Provider, settings.BaseURL, settings.Model,
			s.connectionKey(settings.Provider, settings.BaseURL), settings.ReasoningEffort), nil
	}
	settings, ok, settingsErr := s.readLatexAISettings()
	if settingsErr != nil || !ok {
		return global, nil
	}
	return global.WithChannel(settings.Provider, settings.BaseURL, settings.Model,
		s.connectionKey(settings.Provider, settings.BaseURL), settings.ReasoningEffort), nil
}

// latexAISettingsView 是给界面看的 LaTeX 渠道状态（永不含 Key）。
func (s *Server) latexAISettingsView(global ai.Config) map[string]any {
	settings, hasOverride, _ := s.readLatexAISettings()
	// 「跟随全局」= 没有单独设置。别把 hasOverride 直接当成这个字段用（写反过一次，
	// 界面上会显示成「单独设置」却空着一片）。
	followGlobal := !hasOverride
	effective := global
	if followGlobal {
		settings = latexAISettings{
			Provider:        global.ProviderName(),
			BaseURL:         global.PublicBaseURL(),
			Model:           global.ModelName(),
			ReasoningEffort: global.ReasoningEffort,
		}
	} else {
		effective = global.WithChannel(settings.Provider, settings.BaseURL, settings.Model,
			s.connectionKey(settings.Provider, settings.BaseURL), settings.ReasoningEffort)
	}
	view := map[string]any{
		"followGlobal":    followGlobal,
		"provider":        settings.Provider,
		"baseURL":         settings.BaseURL,
		"model":           settings.Model,
		"reasoningEffort": settings.ReasoningEffort,
		"keyConfigured":   effective.APIKey != "" && strings.TrimSpace(effective.APIKey) != "",
		"status":          effective.Redact(),
	}
	return view
}

// handleLatexAISettings 读写 LaTeX 工作区的模型渠道设置。
func (s *Server) handleLatexAISettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		global, err := s.aiConfig()
		if err != nil {
			// 全局未配置也要能把 LaTeX 的独立设置读出来，否则用户改不回来。
			writeJSON(w, http.StatusOK, s.latexAISettingsView(ai.Config{}))
			return
		}
		writeJSON(w, http.StatusOK, s.latexAISettingsView(global))
		return
	}

	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	var body struct {
		FollowGlobal    bool   `json:"followGlobal"`
		Provider        string `json:"provider"`
		BaseURL         string `json:"baseURL"`
		Model           string `json:"model"`
		APIKey          string `json:"apiKey"`
		ReasoningEffort string `json:"reasoningEffort"`
	}
	if decodeJSON(w, r, &body) != nil {
		return
	}
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	raw := map[string]any{}
	if prior, err := os.ReadFile(path); err == nil {
		if json.Unmarshal(prior, &raw) != nil {
			writeError(w, http.StatusUnprocessableEntity, "原配置损坏，已拒绝覆盖")
			return
		}
	} else if !os.IsNotExist(err) {
		writeError(w, http.StatusInternalServerError, "读取配置失败")
		return
	}
	connections, _ := raw["connections"].(map[string]any)
	if connections == nil {
		connections = map[string]any{}
	}

	if body.FollowGlobal {
		// 跟随全局：删掉独立设置，而不是留一份「看似生效其实没用」的配置。
		delete(raw, "latexAI")
	} else {
		provider := strings.TrimSpace(body.Provider)
		baseURL := strings.TrimSpace(body.BaseURL)
		if !latexSupportedProviders(provider) {
			writeError(w, http.StatusBadRequest, "LaTeX 的 AI 助手只支持 HTTP 渠道（openai / anthropic）；CLI 渠道在后台服务里通常不可用")
			return
		}
		if baseURL == "" {
			writeError(w, http.StatusBadRequest, "请填写完整的 API 地址，例如 https://api.example.com/v1")
			return
		}
		destination := provider + "|" + strings.TrimRight(baseURL, "/")
		// Key 的写入规则与全局设置一致：只写当前渠道那一格，输入为空则沿用已存的。
		if strings.TrimSpace(body.APIKey) != "" {
			connections[destination] = strings.TrimSpace(body.APIKey)
		} else if _, exists := connections[destination]; !exists {
			connections[destination] = ""
		}
		raw["connections"] = connections
		raw["latexAI"] = map[string]any{
			"provider":        provider,
			"baseURL":         baseURL,
			"model":           strings.TrimSpace(body.Model),
			"reasoningEffort": strings.TrimSpace(body.ReasoningEffort),
		}
		// 校验地址形态（与全局同一套规则），但用「占位 Key」检查，避免把真 Key 写进错误信息。
		check := ai.Config{}.WithChannel(provider, baseURL, strings.TrimSpace(body.Model), "validate", "")
		if _, err := check.Endpoint(); err != nil {
			writeError(w, http.StatusBadRequest, "请输入完整 API 地址，例如 https://api.openai.com/v1")
			return
		}
	}
	encoded, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		writeError(w, http.StatusInternalServerError, "创建配置目录失败")
		return
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".latex-ai-config-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	temp := file.Name()
	defer os.Remove(temp)
	_ = file.Chmod(0o600)
	_, writeErr := file.Write(encoded)
	closeErr := file.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr == nil {
		writeErr = os.Rename(temp, path)
	}
	if writeErr != nil {
		writeError(w, http.StatusInternalServerError, "保存配置失败")
		return
	}
	// 这里不能用 s.aiConfig()：它会再锁一次 settingsMu，而本函数已经持有该锁
	// （Go 的 mutex 不可重入，会直接死锁——真发生过，表现为接口永不返回）。
	global, loadErr := ai.LoadConfig(path)
	if loadErr != nil {
		global = ai.Config{}
	}
	writeJSON(w, http.StatusOK, s.latexAISettingsView(global))
}
