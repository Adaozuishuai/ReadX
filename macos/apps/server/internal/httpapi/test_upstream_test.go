package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/legacy"
)

// Translation now runs after import commits. Assert its terminal stage instead
// of racing the worker or treating an imported source as a translated document.
func waitForTestJobStage(t *testing.T, bundle *httptestServerBundle, key, stageKey string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var last map[string]any
	for time.Now().Before(deadline) {
		res, payload := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/job", "")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("job unavailable: %d %v", res.StatusCode, payload)
		}
		job, _ := payload["job"].(map[string]any)
		stages, _ := job["stages"].([]any)
		for _, raw := range stages {
			stage, _ := raw.(map[string]any)
			if stage["key"] == stageKey {
				last = stage
				if stage["status"] == "done" || stage["status"] == "failed" || stage["status"] == "cancelled" {
					return stage
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job stage %s did not finish: %v", stageKey, last)
	return nil
}

// fakeUpstream 是测试用的 OpenAI 兼容端点：翻译请求从 items[].source_text 取段落，
// 其余（题录识别等）交给 reply 处理。与具体业务测试解耦，放在这里供各测试复用。
func fakeUpstream(t *testing.T, reply func(sources []string) (string, int)) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" {
			http.Error(w, "unexpected path", http.StatusNotFound)
			return
		}
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		user := ""
		for _, message := range body.Messages {
			if message.Role == "user" {
				user = message.Content
			}
		}
		// 翻译请求的 user 是 JSON（task + items）；从 items[].source_text 抠出段落。
		// 兼容旧版 "[i] 段落" 行（测试夹具与调试脚本仍可能这么发）。
		sources := []string{}
		plainTranslation := false
		// Lee's direct-Typst path requests one plain-text translation instead of
		// the Go batch JSON protocol. Keep the fake aligned with both callers.
		if start := strings.Index(user, "【当前原文开始】"); start >= 0 {
			text := user[start+len("【当前原文开始】"):]
			if end := strings.Index(text, "【当前原文结束】"); end >= 0 {
				sources = append(sources, strings.TrimSpace(text[:end]))
				plainTranslation = true
			}
		}
		var batch struct {
			Items []struct {
				Source string `json:"source_text"`
			} `json:"items"`
		}
		decoder := json.NewDecoder(strings.NewReader(user))
		if err := decoder.Decode(&batch); !plainTranslation && err == nil && len(batch.Items) > 0 {
			for _, item := range batch.Items {
				sources = append(sources, item.Source)
			}
		} else if !plainTranslation {
			for _, line := range strings.Split(user, "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "[") {
					if idx := strings.Index(line, "]"); idx > 0 {
						sources = append(sources, strings.TrimSpace(line[idx+1:]))
					}
				}
			}
		}
		content, status := reply(sources)
		if plainTranslation && status == http.StatusOK {
			var translated struct {
				Items []struct {
					Text string `json:"t"`
				} `json:"items"`
			}
			if err := json.Unmarshal([]byte(content), &translated); err == nil {
				content = ""
				if len(translated.Items) > 0 {
					content = translated.Items[0].Text
				}
			}
		}
		if status != http.StatusOK {
			http.Error(w, content, status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"content": content}}},
		})
	}))
	t.Cleanup(server.Close)
	return server
}

func writeAIConfig(t *testing.T, bundle *httptestServerBundle, baseURL string) {
	t.Helper()
	paths := legacy.NewPaths(bundle.cfg.DataRoot)
	if err := os.MkdirAll(paths.DataDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"baseURL":%q,"model":"test-model","apiKey":"sk-test"}`, baseURL)
	if err := os.WriteFile(paths.ConfigFile(), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// ensureTestOCR 给需要 PDF 导入的测试接一个本地假 PaddleOCR：导入已改为 OCR-only，
// 没有 OCR 配置会直接失败。测试若已显式配置 OCR 则保持原样。
func ensureTestOCR(t *testing.T, bundle *httptestServerBundle) {
	t.Helper()
	ensureTestOCRPages(t, bundle, 1)
}

func ensureTestOCRPages(t *testing.T, bundle *httptestServerBundle, pageCount int) {
	t.Helper()
	paths := legacy.NewPaths(bundle.cfg.DataRoot)
	config := map[string]any{}
	if raw, err := os.ReadFile(paths.ConfigFile()); err == nil {
		_ = json.Unmarshal(raw, &config)
	}
	if ocr, ok := config["ocr"].(map[string]any); ok {
		if token, _ := ocr["token"].(string); strings.TrimSpace(token) != "" {
			return
		}
	}
	if pageCount < 1 {
		pageCount = 1
	}
	var paddle *httptest.Server
	paddle = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/ocr/jobs":
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "data": map[string]any{"jobId": "test-job"}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/ocr/jobs/test-job":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"state": "done", "resultUrl": map[string]any{"jsonUrl": paddle.URL + "/result.jsonl"}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/result.jsonl":
			pages := make([]map[string]any, pageCount)
			for index := range pages {
				pages[index] = map[string]any{"prunedResult": map[string]any{
					"width": 595, "height": 842,
					"parsing_res_list": []any{map[string]any{
						"block_label":   "text",
						"block_content": fmt.Sprintf("Imported OCR paragraph %d.", index+1),
						"block_bbox":    []float64{72, 72, 500, 140},
					}},
				}}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": map[string]any{"layoutParsingResults": pages}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(paddle.Close)
	config["ocr"] = map[string]any{"provider": "paddle", "baseURL": paddle.URL, "model": "PaddleOCR-VL-1.6", "token": "test-token"}
	encoded, _ := json.Marshal(config)
	if err := os.MkdirAll(paths.DataDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ConfigFile(), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
