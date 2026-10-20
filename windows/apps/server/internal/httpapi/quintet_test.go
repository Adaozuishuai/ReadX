package httpapi

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestQuintetGenerationValidatesAndPreservesEachStep(t *testing.T) {
	bundle, _ := newReadingsServer(t)
	notes := `{"sections":[{"title":"原文依据","fields":[{"k":"设置","v":"使用 Walnut","page":1,"excerpt":"We train using 50 views and report PSNR of 33.05 dB on the Walnut dataset."}]}]}`
	plan := map[string]any{}
	for _, group := range []string{"resources", "environment", "cost", "missing", "risks"} {
		plan[group] = []any{map[string]any{"finding": map[string]any{"k": group, "v": "论文未说明", "page": nil, "excerpt": nil}, "assessment": "仍需核对", "action": "核对原文及仓库文档"}}
	}
	raw, _ := json.Marshal(plan)
	for _, kind := range []string{"motivation", "method", "reproduction"} {
		t.Run(kind, func(t *testing.T) {
			upstream := fakeUpstream(t, func(_ []string) (string, int) {
				if kind == "reproduction" {
					return string(raw), 200
				}
				return notes, 200
			})
			writeAIConfig(t, bundle, upstream.URL)
			request, err := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/ai/generate", strings.NewReader(`{"key":"k1","kind":"`+kind+`"}`))
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Authorization", "Bearer "+bundle.token)
			request.Header.Set("Content-Type", "application/json")
			response, err := bundle.frontend.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			payload := map[string]any{}
			progressEvents := 0
			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if !strings.HasPrefix(line, "data:") {
					continue
				}
				var event map[string]any
				if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event); err != nil {
					t.Fatal(err)
				}
				if event["progress"] != nil {
					progressEvents++
				}
				if result, ok := event["result"].(map[string]any); ok {
					payload = result
				}
			}
			if err := scanner.Err(); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 200 || payload["validationError"] != nil {
				t.Fatalf("generation failed: %d %v", response.StatusCode, payload)
			}
			if kind == "reproduction" {
				if payload["skipped"] != true {
					t.Fatalf("expected reproduction to be skipped without a repository link: %v", payload)
				}
				return
			}
			if progressEvents < 3 || payload["saved"] != true || payload["attempts"] != float64(1) {
				t.Fatalf("expected generated section to be saved: %v", payload)
			}
		})
	}
	response := do(t, bundle.frontend, "GET", "/v1/readings/k1", bundle.token)
	payload := decode(t, response)
	entries := payload["entries"].(map[string]any)
	for _, kind := range []string{"motivation", "method"} {
		if entries[kind] == nil {
			t.Fatalf("missing saved step %s", kind)
		}
	}
	if entries["reproduction"] != nil {
		t.Fatal("reproduction should not be saved when the abstract has no repository link")
	}
	response, payload = post(t, bundle, http.MethodPost, "/v1/reproduction/k1/analyze", `{"value":`+quoteJSON(string(raw))+`}`)
	if response.StatusCode != 200 || payload["revision"] == nil {
		t.Fatalf("checklist save failed: %d %v", response.StatusCode, payload)
	}
}

func quoteJSON(value string) string { raw, _ := json.Marshal(value); return string(raw) }
