package httpapi

import (
	"encoding/json"
	"os"
	"testing"

	"net/http"

	"cbctv2/server/internal/legacy"
)

func TestOCRSettingsPersistWithoutLeakingToken(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	paths := legacy.NewPaths(bundle.cfg.DataRoot)
	seed := `{"provider":"openai","baseURL":"https://api.openai.com/v1","model":"gpt-4o-mini","apiKey":"sk-ai"}`
	if err := os.WriteFile(paths.ConfigFile(), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"token":"paddle-token","baseURL":"https://paddle.example.com","model":"PaddleOCR-VL-1.6"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存 OCR 配置失败: %d %v", res.StatusCode, payload)
	}
	if payload["configured"] != true {
		t.Fatalf("应标记为已配置: %v", payload)
	}
	if _, leaked := payload["token"]; leaked {
		t.Fatal("响应不得回传 OCR 令牌")
	}
	body, err := os.ReadFile(paths.ConfigFile())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	ocrSection, _ := raw["ocr"].(map[string]any)
	if ocrSection["token"] != "paddle-token" || ocrSection["baseURL"] != "https://paddle.example.com" {
		t.Fatalf("ocr 段未写入: %v", ocrSection)
	}
	// 保存 OCR 配置不能冲掉 AI 设置。
	if raw["apiKey"] != "sk-ai" || raw["model"] != "gpt-4o-mini" {
		t.Fatalf("AI 配置被覆盖: %v", raw)
	}

	_, payload = post(t, bundle, http.MethodGet, "/v1/ocr/settings", "")
	if payload["configured"] != true || payload["baseURL"] != "https://paddle.example.com" {
		t.Fatalf("读取 OCR 配置异常: %v", payload)
	}

	if res, _ := post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"clearToken":true}`); res.StatusCode != http.StatusOK {
		t.Fatal("清除令牌失败")
	}
	_, payload = post(t, bundle, http.MethodGet, "/v1/ocr/settings", "")
	if payload["configured"] != false {
		t.Fatalf("令牌应已清除: %v", payload)
	}
}
