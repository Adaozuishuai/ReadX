// ocr_settings.go：PaddleOCR / MinerU 接入配置。
//
// 密钥与 AI Key 一样只落在本机 app/config.json 的 ocr 段，不回传界面；读取时只
// 告诉前端「是否已配置」。各服务独立保存配置与令牌。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/securefile"
)

type ocrConfig struct {
	Provider string `json:"provider"`
	BaseURL  string `json:"baseURL"`
	Model    string `json:"model"`
	Token    string `json:"token"`
}

func defaultOCRConfig() ocrConfig {
	return ocrConfig{Provider: "paddle", BaseURL: ocr.DefaultBaseURL, Model: ocr.DefaultModel}
}

func (config ocrConfig) label() string {
	if config.Provider == "mineru" {
		return "MinerU"
	}
	return "PaddleOCR"
}

func (config ocrConfig) tokenEnvironment() string {
	if config.Provider == "mineru" {
		return "RETAIN_MINERU_API_TOKEN"
	}
	return "RETAIN_PADDLE_API_TOKEN"
}

func (config ocrConfig) leeStageOptions() map[string]any {
	options := map[string]any{
		"provider": config.Provider, "credential_ref": "env:" + config.tokenEnvironment(),
		"language": "ch", "disable_formula": false, "disable_table": false,
		"is_ocr": true, "poll_interval": 5, "poll_timeout": 1800,
	}
	if config.Provider == "mineru" {
		options["model_version"] = config.Model
	} else {
		options["paddle_api_url"], options["paddle_model"] = config.BaseURL, config.Model
	}
	return options
}

func parseOCRProfiles(section map[string]any) (string, map[string]ocrConfig, error) {
	profiles := map[string]ocrConfig{
		"paddle": defaultOCRConfig(),
		"mineru": {Provider: "mineru", BaseURL: ocr.MinerUBaseURL, Model: ocr.MinerUDefaultModel},
	}
	active, _ := section["provider"].(string)
	active = strings.TrimSpace(active)
	if active == "" {
		active = "paddle"
	}
	if _, ok := profiles[active]; !ok {
		return "", nil, fmt.Errorf("不支持的 OCR 服务：%s", active)
	}
	stored, _ := section["providers"].(map[string]any)
	for provider, defaults := range profiles {
		profile, _ := stored[provider].(map[string]any)
		if provider == active {
			// Top-level fields retain compatibility with existing configurations.
			profile = section
		}
		for field, target := range map[string]*string{"baseURL": &defaults.BaseURL, "model": &defaults.Model, "token": &defaults.Token} {
			if value, ok := profile[field].(string); ok && (field == "token" || strings.TrimSpace(value) != "") {
				*target = strings.TrimSpace(value)
			}
		}
		profiles[provider] = defaults
	}
	return active, profiles, nil
}

func readOCRProfiles(dataRoot string) (string, map[string]ocrConfig, error) {
	section := map[string]any{}
	body, err := os.ReadFile(legacy.NewPaths(dataRoot).ConfigFile())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", nil, fmt.Errorf("读取 OCR 配置失败: %w", err)
	}
	if err == nil {
		var raw map[string]any
		if err := json.Unmarshal(body, &raw); err != nil {
			return "", nil, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
		}
		section, _ = raw["ocr"].(map[string]any)
	}
	return parseOCRProfiles(section)
}

func withOCRTokenEnvironment(config ocrConfig) ocrConfig {
	if config.Token == "" {
		if config.Provider == "mineru" {
			config.Token = strings.TrimSpace(os.Getenv("RETAIN_MINERU_API_TOKEN"))
			if config.Token == "" {
				config.Token = strings.TrimSpace(os.Getenv("MINERU_API_TOKEN"))
			}
		} else {
			config.Token = strings.TrimSpace(os.Getenv("RETAIN_PADDLE_API_TOKEN"))
		}
	}
	return config
}

// loadOCRConfig 读 app/config.json 的 ocr 段；文件不存在时返回默认值。
func (s *Server) loadOCRConfig() (ocrConfig, error) {
	return loadOCRConfigForRoot(s.cfg.DataRoot)
}

func loadOCRConfigForRoot(dataRoot string) (ocrConfig, error) {
	active, profiles, err := readOCRProfiles(dataRoot)
	if err != nil {
		return ocrConfig{}, err
	}
	return withOCRTokenEnvironment(profiles[active]), nil
}

func (s *Server) ocrClient() (*ocr.Client, error) {
	config, err := s.loadOCRConfig()
	if err != nil {
		return nil, err
	}
	if config.Token == "" {
		return nil, fmt.Errorf("尚未配置 %s 令牌：请在“AI 助手设置”中填写", config.label())
	}
	if config.Provider == "mineru" {
		return ocr.NewMinerU(config.BaseURL, config.Token, config.Model), nil
	}
	return ocr.New(config.BaseURL, config.Token, config.Model), nil
}

func (s *Server) publicationByteLimit() int64 {
	config, err := s.loadOCRConfig()
	if err == nil && config.Provider == "mineru" {
		return ocr.MinerUMaxPDFBytes
	}
	return ocr.MaxPDFBytes
}

func (s *Server) handleOCRSettings(w http.ResponseWriter, r *http.Request) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
	config, err := s.loadOCRConfig()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if r.Method == http.MethodPut {
		var body struct {
			Provider   string `json:"provider"`
			Token      string `json:"token"`
			ClearToken bool   `json:"clearToken"`
			BaseURL    string `json:"baseURL"`
			Model      string `json:"model"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			return
		}
		if body.Provider != "" && body.Provider != config.Provider {
			_, profiles, err := readOCRProfiles(s.cfg.DataRoot)
			if err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			selected, ok := profiles[body.Provider]
			if !ok {
				writeError(w, http.StatusBadRequest, "OCR 服务只支持 PaddleOCR 或 MinerU")
				return
			}
			config = withOCRTokenEnvironment(selected)
		}
		if strings.TrimSpace(body.BaseURL) != "" {
			config.BaseURL = strings.TrimRight(strings.TrimSpace(body.BaseURL), "/")
		}
		if strings.TrimSpace(body.Model) != "" {
			config.Model = strings.TrimSpace(body.Model)
		}
		if body.ClearToken {
			config.Token = ""
		} else if strings.TrimSpace(body.Token) != "" {
			config.Token = strings.TrimSpace(body.Token)
		}
		endpoint, parseErr := url.Parse(config.BaseURL)
		if parseErr != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") {
			writeError(w, http.StatusBadRequest, "OCR 服务地址必须是有效的 HTTP 或 HTTPS 地址")
			return
		}
		if config.Provider == "mineru" && config.Model != "vlm" && config.Model != "pipeline" {
			writeError(w, http.StatusBadRequest, "MinerU PDF 模型只支持 vlm 或 pipeline")
			return
		}
		if err := s.saveOCRConfig(config); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / PUT")
		return
	}
	_, profiles, err := readOCRProfiles(s.cfg.DataRoot)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	publicProfiles := map[string]any{}
	for provider, profile := range profiles {
		profile = withOCRTokenEnvironment(profile)
		publicProfiles[provider] = map[string]any{"baseURL": profile.BaseURL, "model": profile.Model, "configured": profile.Token != ""}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"provider":      config.Provider,
		"baseURL":       config.BaseURL,
		"model":         config.Model,
		"configured":    config.Token != "",
		"providers":     publicProfiles,
		"documentation": config.label() + " 文档解析服务；各服务令牌只保存在本机 app/config.json。",
	})
}

// saveOCRConfig 只更新 app/config.json 的 ocr 段，保留 AI 设置等其它字段。
func (s *Server) saveOCRConfig(config ocrConfig) error {
	path := legacy.NewPaths(s.cfg.DataRoot).ConfigFile()
	raw := map[string]any{}
	prior, err := os.ReadFile(path)
	if err == nil {
		if json.Unmarshal(prior, &raw) != nil {
			return errors.New("原配置损坏，已拒绝覆盖")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("读取配置失败: %w", err)
	}
	section, _ := raw["ocr"].(map[string]any)
	_, profiles, err := parseOCRProfiles(section)
	if err != nil {
		return err
	}
	profiles[config.Provider] = config
	raw["ocr"] = map[string]any{
		"provider":  config.Provider,
		"baseURL":   config.BaseURL,
		"model":     config.Model,
		"token":     config.Token,
		"providers": profiles,
	}
	encoded, err := json.MarshalIndent(raw, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".ocr-config-*")
	if err != nil {
		return fmt.Errorf("保存 OCR 配置失败: %w", err)
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	_ = file.Chmod(0o600)
	_, writeErr := file.Write(encoded)
	closeErr := file.Close()
	if writeErr == nil {
		writeErr = closeErr
	}
	if writeErr == nil {
		writeErr = os.Rename(temporary, path)
	}
	if writeErr != nil {
		return fmt.Errorf("保存 OCR 配置失败: %w", writeErr)
	}
	if err := securefile.RestrictToCurrentUser(filepath.Dir(path)); err != nil {
		log.Printf("收紧配置目录权限失败（不影响保存）: %v", err)
	}
	if err := securefile.RestrictToCurrentUser(path); err != nil {
		log.Printf("收紧配置文件权限失败（不影响保存）: %v", err)
	}
	return nil
}

// ocrAvailable 供渲染接口判断能否对扫描件执行 OCR。
func (s *Server) ocrAvailable(ctx context.Context) error {
	_, err := s.ocrClient()
	return err
}
