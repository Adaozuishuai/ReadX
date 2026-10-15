package httpapi

import (
	"encoding/json"
	"net/http"
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
			response, payload := post(t, bundle, http.MethodPost, "/v1/ai/generate", `{"key":"k1","kind":"`+kind+`"}`)
			if response.StatusCode != 200 || payload["saved"] != true || payload["validationError"] != nil || payload["attempts"] != float64(1) {
				t.Fatalf("generation failed: %d %v", response.StatusCode, payload)
			}
		})
	}
	response := do(t, bundle.frontend, "GET", "/v1/readings/k1", bundle.token)
	payload := decode(t, response)
	entries := payload["entries"].(map[string]any)
	for _, kind := range []string{"motivation", "method", "reproduction"} {
		if entries[kind] == nil {
			t.Fatalf("missing saved step %s", kind)
		}
	}
	response, payload = post(t, bundle, http.MethodPost, "/v1/reproduction/k1/analyze", `{"value":`+quoteJSON(string(raw))+`}`)
	if response.StatusCode != 200 || payload["revision"] == nil {
		t.Fatalf("checklist save failed: %d %v", response.StatusCode, payload)
	}
}

func quoteJSON(value string) string { raw, _ := json.Marshal(value); return string(raw) }
