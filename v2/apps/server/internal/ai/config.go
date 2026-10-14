// Package ai 是 v2 的 AI 助教客户端：OpenAI 兼容接口、SSE 流式、
// 结构化生成 + 自动修正重试 + 终局降级轮（四层兜底的前两层）。
//
// API Key 只存在于本进程：渲染进程永远拿不到它，也拿不到 config.json 的原文。
package ai

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	BaseURL string `json:"baseURL"`
	Model   string `json:"model"`
	APIKey  string `json:"apiKey"`
}

// PlaceholderMarker 与旧版一致：配置文件里留的中文占位符不算已配置。
const PlaceholderMarker = "在这里填入"

// LoadConfig 读取 app/config.json。文件缺失/损坏不 panic，而是返回错误让接口如实回答「未配置」。
func LoadConfig(path string) (Config, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, fmt.Errorf("还没配置 AI 助教：编辑 app/config.json 填入 Key，保存即生效。")
		}
		return Config{}, fmt.Errorf("读取配置文件失败: %w", err)
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		return Config{}, fmt.Errorf("app/config.json 不是合法 JSON: %w", err)
	}
	return cfg, nil
}

// Endpoint 校验并返回 chat/completions 的完整地址。
func (c Config) Endpoint() (string, error) {
	if !c.Ready() {
		return "", fmt.Errorf("还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
	}
	parsed, err := url.Parse(strings.TrimSuffix(c.BaseURL, "/") + "/chat/completions")
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("API 地址无效，请在配置文件中填写完整的 http/https 地址。")
	}
	return parsed.String(), nil
}

// Ready 判断是否真的可用（有 key、有地址、不是占位符）。
func (c Config) Ready() bool {
	return c.APIKey != "" && !strings.Contains(c.APIKey, PlaceholderMarker) && c.BaseURL != ""
}

// ModelName 兜底默认模型，与旧版 generate/askStream 的默认值一致。
func (c Config) ModelName() string {
	if c.Model == "" {
		return "glm-4.6"
	}
	return c.Model
}

// Redacted 是给界面看的配置状态：只有「是否配置 + 模型 + 地址主机」，永不含 key。
type Redacted struct {
	Configured bool   `json:"configured"`
	Model      string `json:"model"`
	Host       string `json:"host"`
	Error      string `json:"error,omitempty"`
}

func (c Config) Redact() Redacted {
	if !c.Ready() {
		return Redacted{Configured: false, Error: "未配置：编辑 app/config.json 填入 API Key"}
	}
	host := c.BaseURL
	if idx := strings.Index(host, "://"); idx >= 0 {
		host = host[idx+3:]
	}
	if idx := strings.Index(host, "/"); idx >= 0 {
		host = host[:idx]
	}
	return Redacted{Configured: true, Model: c.ModelName(), Host: host}
}
