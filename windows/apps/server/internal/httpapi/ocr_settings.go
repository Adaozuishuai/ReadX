// ocr_settings.go：PaddleOCR 接入配置（扫描版 PDF 的 OCR 阶段）。
//
// 密钥与 AI Key 一样只落在本机 app/config.json 的 ocr 段，不回传界面；读取时只
// 告诉前端「是否已配置」。RetainPDF 的 Paddle/MinerU 两条路同样是远程服务，
// 这里接入它的 Paddle 路线。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
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

// loadOCRConfig 读 app/config.json 的 ocr 段；文件不存在时返回默认值。
func (s *Server) loadOCRConfig() (ocrConfig, error) {
	config := defaultOCRConfig()
	body, err := os.ReadFile(legacy.NewPaths(s.cfg.DataRoot).ConfigFile())
	if errors.Is(err, os.ErrNotExist) {
		return config, nil
	}
	if err != nil {
		return config, fmt.Errorf("读取 OCR 配置失败: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return config, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
	}
	section, _ := raw["ocr"].(map[string]any)
	if section == nil {
		return config, nil
	}
	if value, _ := section["provider"].(string); strings.TrimSpace(value) != "" {
		config.Provider = strings.TrimSpace(value)
	}
	if value, _ := section["baseURL"].(string); strings.TrimSpace(value) != "" {
		config.BaseURL = strings.TrimSpace(value)
	}
	if value, _ := section["model"].(string); strings.TrimSpace(value) != "" {
		config.Model = strings.TrimSpace(value)
	}
	if value, _ := section["token"].(string); strings.TrimSpace(value) != "" {
		config.Token = strings.TrimSpace(value)
	}
	if config.Token == "" {
		config.Token = strings.TrimSpace(os.Getenv("RETAIN_PADDLE_API_TOKEN"))
	}
	return config, nil
}

func (s *Server) ocrClient() (*ocr.Client, error) {
	config, err := s.loadOCRConfig()
	if err != nil {
		return nil, err
	}
	if config.Token == "" {
		return nil, errors.New("尚未配置 PaddleOCR 令牌：请在“AI 助手设置”中填写")
	}
	return ocr.New(config.BaseURL, config.Token, config.Model), nil
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
			Token      string `json:"token"`
			ClearToken bool   `json:"clearToken"`
			BaseURL    string `json:"baseURL"`
			Model      string `json:"model"`
		}
		if err := decodeJSON(w, r, &body); err != nil {
			return
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
		if err := s.saveOCRConfig(config); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
	} else if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / PUT")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"provider":      config.Provider,
		"baseURL":       config.BaseURL,
		"model":         config.Model,
		"configured":    config.Token != "",
		"documentation": "PaddleOCR 文档解析服务；令牌只保存在本机 app/config.json。",
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
	raw["ocr"] = map[string]any{
		"provider": config.Provider,
		"baseURL":  config.BaseURL,
		"model":    config.Model,
		"token":    config.Token,
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
