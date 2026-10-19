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
	"sync/atomic"
	"testing"
	"time"

	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
)

// LeePDF 负责生成译文文件；ReadX 的导出接口只校验处理记录并返回现成产物。
func TestTranslatedPDFReusesLeeArtifact(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	encoded, _ := json.Marshal(map[string]any{"pages": []any{map[string]any{"page": 1}}, "pageCount": 1})
	if err := os.WriteFile(filepath.Join(paths.LibraryDir(), "2209.14540-translated.pdf"), testPDF(t), 0o600); err != nil {
		t.Fatal(err)
	}
	tx, err := bundle.handle.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := saveLayoutTx(context.Background(), tx, "2209.14540", []layoutPage{{Page: 1, Width: 595, Height: 842, Blocks: []layoutBlock{{Kind: "text", Text: "source", Box: [4]float64{20, 20, 100, 60}}}}}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", string(encoded))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("复用 LeePDF 译文失败: %d %v", res.StatusCode, payload)
	}
	if payload["pages"] != float64(1) || payload["blocks"] == float64(0) {
		t.Fatalf("Lee 产物状态异常: %v", payload)
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

// TestImportRunsPaddleOCRAndStoresLayout 验证「导入那一步就换成 Lee 的翻译链」：
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

	bundle, paths := newImportServer(t)
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
	// Lee 本身不做题录识别；导入后应先用 OCR 首页文本补回标题。
	if title, _ := document["title"].(string); title != "OCR Import Paper" {
		t.Fatalf("导入后题名未识别: %q", title)
	}

	// 1) 版式数据在导入时写入。
	res, layout := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/layout", "")
	if res.StatusCode != http.StatusOK || layout["available"] != true || layout["pages"] != float64(1) {
		t.Fatalf("OCR 版式状态异常: %d %v", res.StatusCode, layout)
	}
	// 1b) 阅读器段落识别直接读 Lee 段落块。
	res, paragraphs := post(t, bundle, http.MethodGet, "/v1/documents/"+key+"/pages/1/paragraphs", "")
	if res.StatusCode != http.StatusOK || paragraphs["available"] != true {
		t.Fatalf("Lee 段落接口异常: %d %v", res.StatusCode, paragraphs)
	}
	blocks, _ := paragraphs["blocks"].([]any)
	if len(blocks) == 0 {
		t.Fatalf("Lee 没有返回段落块: %v", paragraphs)
	}
	found := false
	for _, raw := range blocks {
		block, _ := raw.(map[string]any)
		if strings.Contains(fmt.Sprint(block["text"]), "Scanned import paragraph") {
			found = true
		}
	}
	if !found {
		t.Fatalf("Lee 段落缺少正文块: %v", blocks)
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

	// 3) 导入已由 LeePDF 生成整本译文，导出接口直接复用该 PDF。
	paddle.Close()
	response, payload := post(t, bundle, http.MethodPost, "/v1/documents/"+key+"/translated-pdf", `{"pageCount":1}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("复用 LeePDF 成品失败: %d %v", response.StatusCode, payload)
	}
	translated, err := os.ReadFile(filepath.Join(paths.LibraryDir(), key+"-translated.pdf"))
	if err != nil || !bytes.HasPrefix(translated, []byte("%PDF")) {
		t.Fatalf("LeePDF 成品无效: %v", err)
	}

	// 4) 阅读器按页取译文必须复用导入缓存：模型端点已关闭，仍应成功。
	upstream.Close()
	request, err := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/documents/"+key+"/pages/1/translated-page", strings.NewReader(`{"width":595,"height":842}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+bundle.token)
	request.Header.Set("Content-Type", "application/json")
	response, err = bundle.frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("阅读器没有复用导入译文: %d %s", response.StatusCode, body)
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

func TestTranslatedPDFRequiresLeeArtifact(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	body := `{"pages":[{"page":2,"width":595,"height":842,"blocks":[]}]}`
	res, payload := post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", body)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("没有 LeePDF 产物时应要求重新导入，实际 %d %v", res.StatusCode, payload)
	}
}

// Exporting a legacy paper must not silently run the old ReadX Paddle/translation pipeline.
func TestTranslatedPDFDoesNotRunLegacyOCRFallback(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	var calls atomic.Int32
	ocr := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "legacy OCR must not run", http.StatusInternalServerError)
	}))
	defer ocr.Close()
	res, payload := post(t, bundle, http.MethodPut, "/v1/ocr/settings", fmt.Sprintf(`{"token":"test-token","baseURL":%q}`, ocr.URL))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存 OCR 配置失败: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodPost, "/v1/documents/2209.14540/translated-pdf", `{"pageCount":1}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("旧文档无 LeePDF 成品时应要求重新导入，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 0 {
		t.Fatalf("导出接口不应触发 ReadX 的 OCR 回退，调用 %d 次", calls.Load())
	}
}
