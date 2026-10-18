package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
)

// TestTranslatedPDFRendersWithEmbeddedEngine 是渲染链的端到端冒烟：
// 真 PDF -> rpr 输入 -> Node 渲染引擎 -> pdf-lib 叠回 -> 下载。
// 缺少资源（未 npm install / 没装 Node）时跳过，不影响普通单测。
func TestTranslatedPDFRendersWithEmbeddedEngine(t *testing.T) {
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	engineDir := filepath.Join(root, "windows", "resources", "rendering-engine")
	fontDir := filepath.Join(root, "windows", "resources", "fonts")
	script := filepath.Join(root, "windows", "scripts", "render-translated-pdf.cjs")
	t.Setenv("CBCT_RENDER_ENGINE_DIR", engineDir)
	t.Setenv("CBCT_TRANSLATED_PDF_FONT_DIR", fontDir)
	t.Setenv("CBCT_RENDER_SCRIPT", script)
	t.Setenv("CBCT_NODE_BIN", "")

	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	if err := render.New(bundle.cfg.DataRoot).Available(); err != nil {
		t.Skipf("跳过渲染集成测试：%v", err)
	}
	fixture, err := os.ReadFile("testdata/translated-source.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.LibraryDir(), "2209.14540.pdf"), fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)
	ensureTestOCR(t, bundle)
	body := map[string]any{
		"pages": []any{map[string]any{
			"page": 1, "width": 595, "height": 842, "blocks": []any{},
		}},
		"ocr": true,
	}
	encoded, _ := json.Marshal(body)
	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", string(encoded))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("生成译文 PDF 失败: %d %v", res.StatusCode, payload)
	}
	if payload["pages"] != float64(1) || payload["blocks"] == float64(0) {
		t.Fatalf("渲染计数异常: %v", payload)
	}
	output, err := os.ReadFile(filepath.Join(paths.LibraryDir(), "2209.14540-translated.pdf"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(output, []byte("%PDF")) {
		t.Fatalf("产物不是 PDF: %q", output[:8])
	}

	request, _ := http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/documents/2209.14540/translated-pdf", nil)
	request.Header.Set("Authorization", "Bearer "+bundle.token)
	response, err := bundle.frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	downloaded, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !bytes.HasPrefix(downloaded, []byte("%PDF")) {
		t.Fatalf("下载译文 PDF 失败: %d", response.StatusCode)
	}
	if disposition := response.Header.Get("Content-Disposition"); disposition == "" {
		t.Fatal("下载响应缺少 Content-Disposition")
	}
}

// TestTranslatedPageOCRReturnsSinglePagePDF 覆盖阅读器的按页排版译文：
// PaddleOCR 识别段落 -> 翻译 -> rpr 只重排这一页 -> 直接回 PDF。
func TestTranslatedPageOCRReturnsSinglePagePDF(t *testing.T) {
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CBCT_RENDER_ENGINE_DIR", filepath.Join(root, "windows", "resources", "rendering-engine"))
	t.Setenv("CBCT_TRANSLATED_PDF_FONT_DIR", filepath.Join(root, "windows", "resources", "fonts"))
	t.Setenv("CBCT_RENDER_SCRIPT", filepath.Join(root, "windows", "scripts", "render-translated-pdf.cjs"))

	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	if err := render.New(bundle.cfg.DataRoot).Available(); err != nil {
		t.Skipf("跳过 OCR 单页渲染测试：%v", err)
	}
	fixture, err := os.ReadFile("testdata/translated-source.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.LibraryDir(), "2209.14540.pdf"), fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "单页 OCR 译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	var paddle *httptest.Server
	paddle = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/ocr/jobs":
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "data": map[string]any{"jobId": "job-page"}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/ocr/jobs/job-page":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"state": "done", "resultUrl": map[string]any{"jsonUrl": paddle.URL + "/result.jsonl"}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/result.jsonl":
			_, _ = w.Write([]byte(`{"result":{"layoutParsingResults":[{"prunedResult":{"width":595,"height":842,"parsing_res_list":[{"block_label":"text","block_content":"Scanned body paragraph.","block_bbox":[72,72,500,140]},{"block_label":"header","block_content":"JOURNAL HEADER","block_bbox":[72,20,500,40]},{"block_label":"display_formula","block_content":"E=mc^2","block_bbox":[72,160,300,220]}]}}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer paddle.Close()
	if res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", fmt.Sprintf(`{"token":"test-token","baseURL":%q}`, paddle.URL)); res.StatusCode != http.StatusOK {
		t.Fatalf("保存 OCR 配置失败: %d %v", res.StatusCode, payload)
	}

	requestPage := func(force bool) *http.Response {
		body := fmt.Sprintf(`{"width":595,"height":842,"force":%t}`, force)
		req, err := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/documents/2209.14540/pages/1/translated-page", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+bundle.token)
		req.Header.Set("Content-Type", "application/json")
		res, err := bundle.frontend.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}

	first := requestPage(false)
	if first.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(first.Body)
		t.Fatalf("单页排版译文失败: %d %s", first.StatusCode, detail)
	}
	if got := first.Header.Get("Content-Type"); got != "application/pdf" {
		t.Fatalf("应返回 PDF，实际 %q", got)
	}
	if first.Header.Get("X-CBCT-Page-Cached") != "false" {
		t.Fatalf("首次生成不应命中缓存: %q", first.Header.Get("X-CBCT-Page-Cached"))
	}
	pdfBytes, _ := io.ReadAll(first.Body)
	if !bytes.HasPrefix(pdfBytes, []byte("%PDF")) {
		t.Fatalf("产物不是 PDF: %q", pdfBytes[:8])
	}

	second := requestPage(false)
	if second.StatusCode != http.StatusOK || second.Header.Get("X-CBCT-Page-Cached") != "true" {
		t.Fatalf("第二次应命中缓存: %d %q", second.StatusCode, second.Header.Get("X-CBCT-Page-Cached"))
	}
	forced := requestPage(true)
	if forced.StatusCode != http.StatusOK || forced.Header.Get("X-CBCT-Page-Cached") != "false" {
		t.Fatalf("force 应绕过缓存: %d %q", forced.StatusCode, forced.Header.Get("X-CBCT-Page-Cached"))
	}
}

// TestImportRunsPaddleOCRAndStoresLayout 验证「导入那一步就换成 Retain 的翻译链」：
// 配置 OCR 后，导入用 PaddleOCR 识别段落、按策略翻译，并把每页块坐标写入 app_state；
// 阅读器随后按页渲染时不再调用 OCR。
func TestImportRunsPaddleOCRAndStoresLayout(t *testing.T) {
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CBCT_RENDER_ENGINE_DIR", filepath.Join(root, "windows", "resources", "rendering-engine"))
	t.Setenv("CBCT_TRANSLATED_PDF_FONT_DIR", filepath.Join(root, "windows", "resources", "fonts"))
	t.Setenv("CBCT_RENDER_SCRIPT", filepath.Join(root, "windows", "scripts", "render-translated-pdf.cjs"))

	bundle, _ := newImportServer(t)
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"OCR Import Paper","translatedTitle":"OCR 导入论文","authors":["Ada"]}`, http.StatusOK
		}
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "导入译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	var paddle *httptest.Server
	paddle = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/ocr/jobs":
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "data": map[string]any{"jobId": "job-import"}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/ocr/jobs/job-import":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"state": "done", "resultUrl": map[string]any{"jsonUrl": paddle.URL + "/result.jsonl"}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/result.jsonl":
			_, _ = w.Write([]byte(`{"result":{"layoutParsingResults":[{"prunedResult":{"width":595,"height":842,"parsing_res_list":[{"block_label":"header","block_content":"JOURNAL HEADER","block_bbox":[72,20,500,40]},{"block_label":"text","block_content":"Scanned import paragraph.","block_bbox":[72,72,500,140]},{"block_label":"display_formula","block_content":"E=mc^2","block_bbox":[72,160,300,220]}]}}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	if res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", fmt.Sprintf(`{"token":"test-token","baseURL":%q}`, paddle.URL)); res.StatusCode != http.StatusOK {
		t.Fatalf("保存 OCR 配置失败: %d %v", res.StatusCode, payload)
	}

	fixture, err := os.ReadFile("testdata/translated-source.pdf")
	if err != nil {
		t.Fatal(err)
	}
	payload := uploadPublication(t, bundle, "scanned.pdf", fixture,
		publicationMetadataHint{
			FirstPage: "Scanned import paragraph.",
			Pages: []publicationPageHint{{
				Page: 1, Width: 595, Height: 842,
				Text: "Scanned import paragraph.", Segments: []string{"Scanned import paragraph."},
			}},
		})
	entry := payload
	if results, ok := payload["results"].([]any); ok {
		if len(results) != 1 {
			t.Fatalf("导入结果异常: %v", payload)
		}
		entry, _ = results[0].(map[string]any)
	}
	if errText, _ := entry["error"].(string); errText != "" {
		t.Fatalf("导入失败: %s", errText)
	}
	document, _ := entry["document"].(map[string]any)
	key, _ := document["key"].(string)
	if key == "" {
		t.Fatalf("没有返回文档 key: %v", entry)
	}

	// 1) 版式数据在导入时写入。
	res, layout := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/layout", "")
	if res.StatusCode != http.StatusOK || layout["available"] != true || layout["pages"] != float64(1) {
		t.Fatalf("OCR 版式状态异常: %d %v", res.StatusCode, layout)
	}
	// 2) OCR 段落的译文已随导入入库（按段落哈希）。
	var rows int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM translations WHERE document_id = ?`, key).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("应保存 1 条 OCR 段落译文，实际 %d", rows)
	}
	// 2) 导入任务记录了 OCR / 翻译 / 渲染 三个阶段。
	res, jobPayload := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/job", "")
	if res.StatusCode != http.StatusOK || jobPayload["available"] != true {
		t.Fatalf("任务状态不可用: %d %v", res.StatusCode, jobPayload)
	}
	job, _ := jobPayload["job"].(map[string]any)
	stages, _ := job["stages"].([]any)
	if len(stages) != 3 {
		t.Fatalf("应有 3 个阶段，实际 %v", job["stages"])
	}
	stageStatus := func(name string) string {
		for _, raw := range stages {
			stage, _ := raw.(map[string]any)
			if stage["key"] == name {
				status, _ := stage["status"].(string)
				return status
			}
		}
		return ""
	}
	if stageStatus("ocr") != "done" || stageStatus("translate") != "done" {
		t.Fatalf("OCR/翻译阶段应已完成: %v", stages)
	}
	// 渲染在导入响应之后后台进行：等它收尾（测试环境用真实 rpr，通常 < 2s）。
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		_, current := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/job", "")
		entry, _ := current["job"].(map[string]any)
		if entry["status"] == "done" {
			job = entry
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if job["status"] != "done" {
		t.Fatalf("任务未在 20s 内完成: %v", job)
	}

	// 3) 关掉 Paddle 后再请求渲染：命中导入时保存的版式，不应再访问 OCR。
	paddle.Close()
	if err := render.New(bundle.cfg.DataRoot).Available(); err != nil {
		t.Skipf("跳过渲染验证：%v", err)
	}
	req, err := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/documents/"+key+"/pages/1/translated-page", strings.NewReader(`{"width":595,"height":842}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	pdfBytes, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !bytes.HasPrefix(pdfBytes, []byte("%PDF")) {
		t.Fatalf("按导入版式渲染失败: %d %s", response.StatusCode, pdfBytes)
	}
	if got := response.Header.Get("X-CBCT-Page-Blocks"); got != "1" {
		t.Fatalf("页眉/公式不应被翻译，应只有 1 个可译块，实际 header=%q", got)
	}
}

// TestTranslatedPageWithoutBodyReturnsOriginalPage：整页没有可译正文（公式/表格/图片页）
// 不应让渲染任务失败，而是原样返回这一页，阅读器显示「已保留原页」。
func TestTranslatedPageWithoutBodyReturnsOriginalPage(t *testing.T) {
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CBCT_RENDER_ENGINE_DIR", filepath.Join(root, "windows", "resources", "rendering-engine"))
	t.Setenv("CBCT_TRANSLATED_PDF_FONT_DIR", filepath.Join(root, "windows", "resources", "fonts"))
	t.Setenv("CBCT_RENDER_SCRIPT", filepath.Join(root, "windows", "scripts", "render-translated-pdf.cjs"))
	bundle, _ := newImportServer(t)
	if err := render.New(bundle.cfg.DataRoot).Available(); err != nil {
		t.Skipf("跳过渲染集成测试：%v", err)
	}
	source, err := os.ReadFile("testdata/translated-source.pdf")
	if err != nil {
		t.Fatal(err)
	}
	server := New(bundle.cfg, bundle.handle)
	page := ocr.Page{Index: 0, Width: 595, Height: 842}
	stats, pdf, err := server.renderTranslatedPage(context.Background(), "doc-test", source, 1, page, nil, nil, true, render.New(bundle.cfg.DataRoot))
	if err != nil {
		t.Fatalf("空正文页不应报错: %v", err)
	}
	if !stats.Extracted {
		t.Fatal("应标记为提取原页")
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF")) {
		t.Fatalf("应返回合法 PDF: %q", pdf[:8])
	}
}

func TestTranslatedPageRejectsMissingSize(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/pages/1/translated-page", `{}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺少页面尺寸应 400，实际 %d %v", res.StatusCode, payload)
	}
}

func TestTranslatedPDFRejectsNonContiguousPages(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	body := `{"pages":[{"page":2,"width":595,"height":842,"blocks":[]}]}`
	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", body)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("页码不连续应 400，实际 %d %v", res.StatusCode, payload)
	}
}

// TestTranslatedPDFOCRRunsPaddleThenRender 覆盖扫描件路径：PaddleOCR -> 翻译 -> rpr 渲染。
// Paddle 服务与模型都用本地假端点，不访问外网、不花额度。
func TestTranslatedPDFOCRRunsPaddleThenRender(t *testing.T) {
	root, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CBCT_RENDER_ENGINE_DIR", filepath.Join(root, "windows", "resources", "rendering-engine"))
	t.Setenv("CBCT_TRANSLATED_PDF_FONT_DIR", filepath.Join(root, "windows", "resources", "fonts"))
	t.Setenv("CBCT_RENDER_SCRIPT", filepath.Join(root, "windows", "scripts", "render-translated-pdf.cjs"))

	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	if err := render.New(bundle.cfg.DataRoot).Available(); err != nil {
		t.Skipf("跳过 OCR 渲染集成测试：%v", err)
	}
	fixture, err := os.ReadFile("testdata/translated-source.pdf")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(paths.LibraryDir(), "2209.14540.pdf"), fixture, 0o600); err != nil {
		t.Fatal(err)
	}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "OCR 翻译：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	var paddle *httptest.Server
	paddle = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v2/ocr/jobs":
			_ = json.NewEncoder(w).Encode(map[string]any{"errorCode": 0, "data": map[string]any{"jobId": "job-ocr"}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v2/ocr/jobs/job-ocr":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"errorCode": 0,
				"data":      map[string]any{"state": "done", "resultUrl": map[string]any{"jsonUrl": paddle.URL + "/result.jsonl"}},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/result.jsonl":
			_, _ = w.Write([]byte(`{"result":{"layoutParsingResults":[{"prunedResult":{"width":595,"height":842,"parsing_res_list":[{"block_label":"text","block_content":"Scanned paragraph.","block_bbox":[72,72,500,140]},{"block_label":"display_formula","block_content":"E=mc^2","block_bbox":[72,160,300,220]}]}}]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer paddle.Close()

	res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", fmt.Sprintf(`{"token":"test-token","baseURL":%q}`, paddle.URL))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存 OCR 配置失败: %d %v", res.StatusCode, payload)
	}
	body := `{"pages":[{"page":1,"width":595,"height":842,"blocks":[]}],"ocr":true}`
	res, payload = post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("OCR 译文 PDF 失败: %d %v", res.StatusCode, payload)
	}
	if payload["pages"] != float64(1) {
		t.Fatalf("应渲染 1 页: %v", payload)
	}
	if _, err := os.Stat(filepath.Join(paths.LibraryDir(), "2209.14540-translated.pdf")); err != nil {
		t.Fatalf("译文 PDF 未落盘: %v", err)
	}
}
