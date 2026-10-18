package ocr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestExtractMapsPaddleResultAndScalesToPDF(t *testing.T) {
	resultLines := []string{
		`{"result":{"layoutParsingResults":[{"prunedResult":{"width":1200,"height":1600,"parsing_res_list":[{"block_label":"doc_title","block_content":"Paper title","block_bbox":[80,40,1120,120]},{"block_label":"text","block_content":"正文段落。","block_bbox":[80,220,550,390]},{"block_label":"display_formula","block_content":"E=mc^2","block_bbox":[80,400,550,460]}]}}]}}`,
	}
	var submitted bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/ocr/jobs":
			submitted = true
			if !strings.HasPrefix(r.Header.Get("Authorization"), "bearer ") {
				t.Errorf("缺少 bearer token: %q", r.Header.Get("Authorization"))
			}
			if err := r.ParseMultipartForm(32 << 20); err != nil {
				t.Errorf("上传不是 multipart: %v", err)
			}
			if r.FormValue("model") == "" || r.FormValue("optionalPayload") == "" {
				t.Errorf("缺少 model/optionalPayload")
			}
			_, _ = w.Write([]byte(`{"errorCode":0,"data":{"jobId":"job-1"}}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/ocr/jobs/job-1":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "bearer ") {
				t.Errorf("轮询任务缺少 bearer token: %q", r.Header.Get("Authorization"))
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"state": "done", "resultUrl": map[string]any{"jsonUrl": serverURL(r) + "/result.jsonl"}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/result.jsonl":
			if got := r.Header.Get("Authorization"); got != "" {
				t.Errorf("BOS 结果下载不应携带 Paddle token: %q", got)
			}
			_, _ = w.Write([]byte(strings.Join(resultLines, "\n")))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := New(server.URL, "token-1", "model-1")
	client.PollInterval = time.Millisecond

	pages, err := client.Extract(context.Background(), []byte("%PDF-1.4\n"), "paper.pdf", []Size{{Width: 595, Height: 842}})
	if err != nil {
		t.Fatal(err)
	}
	if !submitted {
		t.Fatal("没有提交 OCR 任务")
	}
	if len(pages) != 1 || pages[0].Width != 595 || pages[0].Height != 842 {
		t.Fatalf("页尺寸没有换算成 PDF 点：%+v", pages)
	}
	if len(pages[0].Blocks) != 3 {
		t.Fatalf("块数 = %d", len(pages[0].Blocks))
	}
	text := pages[0].Blocks[1]
	if !text.Translatable || text.Text != "正文段落。" {
		t.Fatalf("正文块映射错误: %+v", text)
	}
	// 1200x1600 -> 595x842：x 缩放 0.4958，y 缩放 0.5263。
	if text.Box[0] < 39 || text.Box[0] > 40 || text.Box[2] < 272 || text.Box[2] > 273 {
		t.Fatalf("x 坐标缩放错误: %v", text.Box)
	}
	if pages[0].Blocks[2].Translatable {
		t.Fatal("公式块不应翻译")
	}
}

func TestMapLayoutsRejectsPageCountMismatch(t *testing.T) {
	raw := []json.RawMessage{json.RawMessage(`{"prunedResult":{"width":1200,"height":1600,"parsing_res_list":[]}}`)}
	sizes := []Size{{Width: 595, Height: 842}, {Width: 595, Height: 842}}
	_, err := MapLayouts(raw, sizes)
	if err == nil || !strings.Contains(err.Error(), "无法可靠对齐页面") {
		t.Fatalf("页数不匹配时应拒绝生成错位结果，实际错误：%v", err)
	}
}

func TestMapLayoutsAcceptsNumericAndStringBlockIDs(t *testing.T) {
	raw := []json.RawMessage{json.RawMessage(`{"prunedResult":{"width":600,"height":800,"parsing_res_list":[{"block_id":37,"block_label":"text","block_content":"numeric id","block_bbox":[10,10,200,50]},{"block_id":"block-a","block_label":"text","block_content":"string id","block_bbox":[10,60,200,100]}]}}`)}
	pages, err := MapLayouts(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || len(pages[0].Blocks) != 2 {
		t.Fatalf("unexpected OCR blocks: %+v", pages)
	}
	if got := pages[0].Blocks[0].ProviderBlockID; got != "37" {
		t.Fatalf("numeric block_id should be preserved as text, got %q", got)
	}
	if got := pages[0].Blocks[1].ProviderBlockID; got != "block-a" {
		t.Fatalf("string block_id should remain unchanged, got %q", got)
	}
}

func TestLayoutsRejectsPDFOverPaddleUploadLimitBeforeRequest(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	client := New(server.URL, "token", "model")
	_, err := client.Layouts(context.Background(), make([]byte, MaxPDFBytes+1), "large.pdf")
	if err == nil || !strings.Contains(err.Error(), "50 MB") {
		t.Fatalf("超限文件应被拒绝，实际错误：%v", err)
	}
	if called {
		t.Fatal("超限文件不应发往 PaddleOCR")
	}
}

func TestLabelPolicyMatchesRetainPDF(t *testing.T) {
	// 与上游 provider_adapters/paddle/{label_catalog,roles,translation_policy}.py 对齐：
	// 正文/标题/摘要/目录/图注翻译；公式、表格、图片、页眉页脚、页码、脚注、参考文献保留。
	cases := []struct {
		label     string
		kind      string
		translate bool
	}{
		{"text", "body", true},
		{"vertical_text", "body", true},
		{"paragraph_title", "heading", true},
		{"doc_title", "title", true},
		{"abstract", "abstract", true},
		{"content", "toc", true},
		{"figure_title", "figure_caption", true},
		{"vision_footnote", "vision_footnote", true},
		{"reference_content", "reference_entry", false},
		{"footnote", "footnote", false},
		{"header", "metadata", false},
		{"footer", "metadata", false},
		{"number", "metadata", false},
		{"display_formula", "formula", false},
		{"inline_formula", "formula", false},
		{"table", "table", false},
		{"image", "image", false},
		{"chart", "image", false},
		{"algorithm", "code", false},
	}
	for _, item := range cases {
		if kind := KindForLabel(item.label); kind != item.kind {
			t.Errorf("%s 应映射为 %s，实际 %s", item.label, item.kind, kind)
		}
		if got := translatable(item.label); got != item.translate {
			t.Errorf("%s 的翻译策略应为 %v，实际 %v", item.label, item.translate, got)
		}
	}
}

func TestSubmitErrorEnvelopeIsReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"errorCode":1001,"errorMsg":"bad token"}`))
	}))
	defer server.Close()
	client := New(server.URL, "bad", "")
	_, err := client.Extract(context.Background(), []byte("%PDF"), "x.pdf", []Size{{Width: 595, Height: 842}})
	if err == nil || !strings.Contains(err.Error(), "bad token") {
		t.Fatalf("应报告服务端错误，实际 %v", err)
	}
}

func serverURL(r *http.Request) string {
	return "http://" + r.Host
}
