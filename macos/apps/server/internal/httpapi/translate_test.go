package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"cbctv2/server/internal/legacy"
)

// fakeUpstream 是一个最小 OpenAI 兼容端点：按预设的回复函数返回 chat/completions。
// 用它来验证翻译链的「段数对应」纪律，而不真的花额度。
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
		// 从 "[i] 段落" 里把段落抠出来，模拟模型逐段处理。
		sources := []string{}
		for _, line := range strings.Split(user, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "[") {
				if idx := strings.Index(line, "]"); idx > 0 {
					sources = append(sources, strings.TrimSpace(line[idx+1:]))
				}
			}
		}
		content, status := reply(sources)
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

func translate(t *testing.T, bundle *httptestServerBundle, key, body string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodPost, "/v1/translations/"+key, body)
}

func TestTranslateRequiresConfiguration(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	// 未写 config.json：必须明确回 503 而不是空译文。
	res, payload := translate(t, bundle, "2209.14540", `{"segments":["We train using 50 views."]}`)
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("未配置应 503，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "config.json") {
		t.Fatalf("错误应指向配置文件，实际 %v", payload["error"])
	}
}

func TestTranslateUsesCacheWithoutCallingModel(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	// 故意指向一个不存在的上游：只要命中缓存，就根本不该发请求。
	writeAIConfig(t, bundle, "http://127.0.0.1:1/v1")

	source := "We train using 50 views."
	hash := paraHash(source)
	if _, err := bundle.handle.Exec(
		`INSERT INTO translations(document_id, para_hash, source, target, updated_at) VALUES(?,?,?,?,?)`,
		"2209.14540", hash, source, "我们使用 50 个视角训练。", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}

	res, payload := translate(t, bundle, "2209.14540", fmt.Sprintf(`{"segments":[%q]}`, source))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("命中缓存应 200，实际 %d %v", res.StatusCode, payload)
	}
	items := payload["items"].([]any)
	first := items[0].(map[string]any)
	if first["target"] != "我们使用 50 个视角训练。" {
		t.Fatalf("译文应来自缓存: %v", first)
	}
	if payload["cached"] != float64(1) || payload["newly"] != float64(0) {
		t.Fatalf("缓存命中计数异常: %v", payload)
	}
}

func TestTranslateCallsModelAndPersists(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "译:" + source}
		}
		payload, _ := json.Marshal(map[string]any{"items": items})
		return string(payload), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := translate(t, bundle, "2209.14540", `{"segments":["Paragraph one text.","Paragraph two text."]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("应 200，实际 %d %v", res.StatusCode, payload)
	}
	items := payload["items"].([]any)
	if len(items) != 2 {
		t.Fatalf("应回 2 段，实际 %d", len(items))
	}
	if items[0].(map[string]any)["target"] != "译:Paragraph one text." {
		t.Fatalf("译文异常: %v", items[0])
	}
	if payload["newly"] != float64(2) {
		t.Fatalf("首次应全部新翻: %v", payload)
	}

	// 第二次同样请求：应全部命中缓存，不再调模型。
	res, payload = translate(t, bundle, "2209.14540", `{"segments":["Paragraph one text.","Paragraph two text."]}`)
	if res.StatusCode != http.StatusOK || payload["cached"] != float64(2) || payload["newly"] != float64(0) {
		t.Fatalf("重复请求应全命中缓存: %d %v", res.StatusCode, payload)
	}
}

func TestTranslateRejectsMismatchedSegmentCount(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	// 模型持续返回空数组；缩小到单段后仍缺失，交互翻译必须失败且不能错位落库。
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		return `{"items":[]}`, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := translate(t, bundle, "2209.14540", `{"segments":["One.","Two."]}`)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("段数不符应 502，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "段数") {
		t.Fatalf("错误应点明段数不符: %v", payload["error"])
	}
	var count int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM translations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("失败批次不得落库，实际写入 %d 条", count)
	}
}

func TestTranslateDedupesRepeatedParagraphs(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	var seen int
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		seen = len(sources)
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "T:" + source}
		}
		payload, _ := json.Marshal(map[string]any{"items": items})
		return string(payload), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	// 同一段出现两次（页眉复读）：只应发给模型一次。
	res, payload := translate(t, bundle, "2209.14540", `{"segments":["Repeated header.","Body line.","Repeated header."]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("应 200，实际 %d %v", res.StatusCode, payload)
	}
	if payload["distinct"] != float64(2) || payload["newly"] != float64(2) {
		t.Fatalf("重复段应去重: %v", payload)
	}
	if seen != 2 {
		// seen 是最后一次上游请求里的段数：去重后应只有 2 段（重复的页眉只发一次）。
		t.Fatalf("发给模型的段数应为 2，实际 %d", seen)
	}
	items := payload["items"].([]any)
	if len(items) != 3 || items[0].(map[string]any)["target"] != items[2].(map[string]any)["target"] {
		t.Fatalf("重复段应共享同一译文: %v", items)
	}
}

func TestTranslateGuards(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	upstream := fakeUpstream(t, func(sources []string) (string, int) { return `{"items":[]}`, http.StatusOK })
	writeAIConfig(t, bundle, upstream.URL)

	if res, _ := translate(t, bundle, "2209.14540", `{"segments":[]}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空 segments 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := translate(t, bundle, "2209.14540", `{oops`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("坏 JSON 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := translate(t, bundle, "no-such-doc", `{"segments":["x"]}`); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
	if res, _ := translate(t, bundle, "..%2F..%2Fetc", `{"segments":["x"]}`); res.StatusCode == http.StatusOK {
		t.Fatal("非法键不得返回 200")
	}
}

func TestTranslatePropagatesUpstreamFailure(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		return "upstream boom", http.StatusInternalServerError
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := translate(t, bundle, "2209.14540", `{"segments":["Some text."]}`)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("上游失败应 502，实际 %d %v", res.StatusCode, payload)
	}
}

func TestParaHashIgnoresSurroundingWhitespace(t *testing.T) {
	if paraHash("  hello  ") != paraHash("hello") {
		t.Fatal("首尾空白不应影响段落指纹")
	}
	if paraHash("hello") == paraHash("hello world") {
		t.Fatal("不同段落应得到不同指纹")
	}
}
