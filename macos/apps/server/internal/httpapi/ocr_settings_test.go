package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"strings"
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

func TestOCRProviderSwitchKeepsCredentialsSeparate(t *testing.T) {
	bundle, _ := newImportServer(t)
	for _, body := range []string{
		`{"provider":"paddle","token":"paddle-private","baseURL":"https://paddle.example.com","model":"paddle-custom"}`,
		`{"provider":"mineru"}`,
	} {
		res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", body)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("save failed: %d %v", res.StatusCode, payload)
		}
	}
	_, payload := post(t, bundle, http.MethodGet, "/v1/ocr/settings", "")
	if payload["configured"] != false || payload["model"] != "vlm" || payload["baseURL"] != "https://mineru.net" {
		t.Fatalf("Paddle credentials/config leaked into MinerU: %v", payload)
	}
	res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"provider":"mineru","token":"mineru-private","model":"pipeline"}`)
	if res.StatusCode != http.StatusOK || payload["configured"] != true {
		t.Fatalf("MinerU save failed: %v", payload)
	}
	for _, provider := range []string{"paddle", "mineru"} {
		res, payload = post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"provider":"`+provider+`"}`)
		if res.StatusCode != http.StatusOK || payload["configured"] != true {
			t.Fatalf("saved profile lost: %v", payload)
		}
		encoded, _ := json.Marshal(payload)
		if strings.Contains(string(encoded), "private") {
			t.Fatalf("OCR response leaked a token: %s", encoded)
		}
	}
	if res, _ := post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"clearToken":true}`); res.StatusCode != http.StatusOK {
		t.Fatal(res.StatusCode)
	}
	_, payload = post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"provider":"paddle"}`)
	if payload["configured"] != true || payload["model"] != "paddle-custom" || payload["baseURL"] != "https://paddle.example.com" {
		t.Fatalf("clearing MinerU changed Paddle profile: %v", payload)
	}
	_, payload = post(t, bundle, http.MethodPut, "/v1/ocr/settings", `{"provider":"mineru"}`)
	if payload["configured"] != false || payload["model"] != "pipeline" {
		t.Fatalf("MinerU clear was not retained: %v", payload)
	}
	for _, body := range []string{`{"provider":"unknown"}`, `{"model":"invalid"}`, `{"baseURL":"not-a-url"}`} {
		if res, _ := post(t, bundle, http.MethodPut, "/v1/ocr/settings", body); res.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid settings accepted: %s", body)
		}
	}
}

func TestMinerUEnvironmentAndLimits(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	t.Setenv("RETAIN_PADDLE_API_TOKEN", "paddle-env")
	t.Setenv("MINERU_API_TOKEN", "mineru-env")
	if err := s.saveOCRConfig(ocrConfig{Provider: "mineru", BaseURL: "https://mineru.net", Model: "vlm"}); err != nil {
		t.Fatal(err)
	}
	client, err := s.ocrClient()
	if err != nil || client.Provider != "mineru" || client.Token != "mineru-env" {
		t.Fatalf("wrong MinerU environment: %v %+v", err, client)
	}
	if s.publicationByteLimit() != 200<<20 {
		t.Fatal("MinerU upload still uses Paddle's 50 MB limit")
	}
	err = s.prepareImportTranslations(context.Background(), []byte("%PDF"), make([]publicationPageHint, 201), &recognizedPaperMetadata{})
	if err == nil || !strings.Contains(err.Error(), "MinerU") || !strings.Contains(err.Error(), "200 页") {
		t.Fatalf("missing MinerU page limit: %v", err)
	}
}
