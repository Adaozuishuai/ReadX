package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"cbctv2/server/internal/legacy"
)

func writeAIConfigFile(t *testing.T, dataRoot, content string) {
	t.Helper()
	path := legacy.NewPaths(dataRoot).ConfigFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	// 立刻读回来核对：这一步能区分「没写成功」与「服务端读的不是这个路径」。
	written, err := os.ReadFile(path)
	if err != nil || string(written) != content {
		t.Fatalf("写入后读回失败: %v（路径 %s，写入 %d 字节，读回 %d 字节）", err, path, len(content), len(written))
	}
	t.Logf("已写入配置: %s（%d 字节）", path, len(content))
}

func readAIConfigRaw(t *testing.T, dataRoot string) map[string]any {
	t.Helper()
	body, err := os.ReadFile(legacy.NewPaths(dataRoot).ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func latexSettingsView(t *testing.T, bundle *httptestServerBundle) map[string]any {
	t.Helper()
	res, payload := post(t, bundle, http.MethodGet, "/v1/ai/latex-settings", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("读取 LaTeX 模型设置失败: %d %v", res.StatusCode, payload)
	}
	return payload
}

// 默认跟随全局：全局是什么，LaTeX 就用什么。
func TestLatexSettingsFollowGlobalByDefault(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai",
	  "baseURL": "https://global.example.com/v1",
	  "model": "global-model",
	  "apiKey": "global-key",
	  "connections": {"openai|https://global.example.com/v1": "global-key"}
	}`)

	view := latexSettingsView(t, bundle)
	if view["followGlobal"] != true {
		t.Fatalf("初始状态应当是「跟随全局」: %v", view)
	}
	if view["model"] != "global-model" || view["keyConfigured"] != true {
		t.Fatalf("跟随全局时应当显示全局的模型与可用性: %v", view)
	}
	// 注：不在这里断言 /v1/ai/settings 响应里的 latex 段——那个接口会顺带探测 Codex 与
	// WorkBuddy，在没有真实环境的测试里会长时间等待。这条接线由浏览器 E2E 覆盖。
}

// 单独指定渠道后：LaTeX 用自己的渠道与自己的 Key，全局一个字段都不动。
func TestLatexSettingsOverrideIsolatesKeysAndKeepsGlobal(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai",
	  "baseURL": "https://global.example.com/v1",
	  "model": "global-model",
	  "apiKey": "global-key",
	  "connections": {"openai|https://global.example.com/v1": "global-key"}
	}`)
	before := readAIConfigRaw(t, bundle.cfg.DataRoot)

	res, view := post(t, bundle, http.MethodPut, "/v1/ai/latex-settings", `{
	  "followGlobal": false,
	  "provider": "openai",
	  "baseURL": "https://latex.example.com/v1",
	  "model": "latex-model",
	  "reasoningEffort": "medium",
	  "apiKey": "latex-key"
	}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存 LaTeX 渠道失败: %d %v", res.StatusCode, view)
	}
	if view["followGlobal"] != false || view["provider"] != "openai" || view["model"] != "latex-model" {
		t.Fatalf("保存后的状态不对: %v", view)
	}
	if view["keyConfigured"] != true {
		t.Fatalf("填了 Key 就该显示已配置: %v", view)
	}

	after := readAIConfigRaw(t, bundle.cfg.DataRoot)
	if after["provider"] != before["provider"] || after["model"] != before["model"] {
		t.Fatalf("全局设置绝不能被 LaTeX 的单独设置改动: %v → %v", before["provider"], after["provider"])
	}
	connections, _ := after["connections"].(map[string]any)
	if connections["openai|https://global.example.com/v1"] != "global-key" {
		t.Fatalf("全局渠道的 Key 不该被动: %v", connections)
	}
	if connections["openai|https://latex.example.com/v1"] != "latex-key" {
		t.Fatalf("LaTeX 渠道的 Key 应当按「渠道|地址」保存: %v", connections)
	}
	latexSection, _ := after["latexAI"].(map[string]any)
	if latexSection == nil || latexSection["model"] != "latex-model" {
		t.Fatalf("应当写入 latexAI 段: %v", after["latexAI"])
	}

	// 再读一次：设置是持久的。
	view = latexSettingsView(t, bundle)
	if view["model"] != "latex-model" || view["keyConfigured"] != true {
		t.Fatalf("重新读取应当保持: %v", view)
	}
}

// 绝不借用别的地址的 Key：换成一条没填 Key 的渠道后，必须显示未配置。
func TestLatexSettingsNeverBorrowsAnotherChannelKey(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai",
	  "baseURL": "https://global.example.com/v1",
	  "model": "global-model",
	  "apiKey": "global-key",
	  "connections": {"openai|https://global.example.com/v1": "global-key"}
	}`)
	res, view := post(t, bundle, http.MethodPut, "/v1/ai/latex-settings", `{
	  "followGlobal": false,
	  "provider": "openai",
	  "baseURL": "https://no-key.example.com/v1",
	  "model": "m"
	}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存失败: %d %v", res.StatusCode, view)
	}
	if view["keyConfigured"] != false {
		t.Fatalf("这条渠道没有 Key，必须如实显示未配置（不能拿全局那条的 Key）: %v", view)
	}
	status, _ := view["status"].(map[string]any)
	if status["configured"] != false {
		t.Fatalf("状态里也不该说已配置: %v", status)
	}
}

// 回到「跟随全局」会删掉这段设置，而不是留一份看似生效的配置。
func TestLatexSettingsFollowGlobalRemovesOverride(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{
	  "provider": "openai", "baseURL": "https://global.example.com/v1", "model": "g", "apiKey": "k",
	  "connections": {"openai|https://global.example.com/v1": "k"}
	}`)
	if _, view := post(t, bundle, http.MethodPut, "/v1/ai/latex-settings", `{
	  "followGlobal": false, "provider": "openai", "baseURL": "https://latex.example.com/v1", "model": "l", "apiKey": "lk"
	}`); view["keyConfigured"] != true {
		t.Fatalf("先设置好 LaTeX 渠道: %v", view)
	}
	res, view := post(t, bundle, http.MethodPut, "/v1/ai/latex-settings", `{"followGlobal": true}`)
	if res.StatusCode != http.StatusOK || view["followGlobal"] != true {
		t.Fatalf("回到跟随全局失败: %d %v", res.StatusCode, view)
	}
	raw := readAIConfigRaw(t, bundle.cfg.DataRoot)
	if _, exists := raw["latexAI"]; exists {
		t.Fatalf("不该还留着 latexAI 段: %v", raw["latexAI"])
	}
	if raw["model"] != "g" {
		t.Fatalf("全局配置应当保持不变: %v", raw["model"])
	}
	// LaTeX 渠道那格 Key 留着无妨（用户可能还会切回去），但不能再被当成生效渠道。
	view = latexSettingsView(t, bundle)
	if view["model"] != "g" {
		t.Fatalf("跟随全局后应当显示全局模型: %v", view)
	}
}

// 只支持 HTTP 渠道：CLI 渠道在后台服务里通常不可用，要在入口就说清楚。
func TestLatexSettingsRejectsCLIProvidersAndBadURL(t *testing.T) {
	bundle := newLatexBundle(t)
	writeAIConfigFile(t, bundle.cfg.DataRoot, `{"provider": "openai", "baseURL": "https://g/v1", "model": "g", "apiKey": "k"}`)
	for _, body := range []string{
		`{"followGlobal": false, "provider": "codex", "baseURL": "", "model": "x"}`,
		`{"followGlobal": false, "provider": "claude", "baseURL": "https://api.anthropic.com", "model": "x"}`,
		`{"followGlobal": false, "provider": "openai", "baseURL": "", "model": "x"}`,
		`{"followGlobal": false, "provider": "openai", "baseURL": "not-a-url", "model": "x"}`,
	} {
		res, payload := post(t, bundle, http.MethodPut, "/v1/ai/latex-settings", body)
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("非法设置应当 400：%s → %d %v", body, res.StatusCode, payload)
		}
	}
	// 被拒绝的请求不能改动配置。
	raw := readAIConfigRaw(t, bundle.cfg.DataRoot)
	if _, exists := raw["latexAI"]; exists {
		t.Fatalf("被拒绝的请求不该写入设置: %v", raw["latexAI"])
	}
}
