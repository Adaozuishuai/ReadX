package httpapi

import (
	"archive/zip"
	"bytes"
	"cbctv2/server/internal/legacy"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func epubFixture(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	files := map[string][]byte{
		"META-INF/container.xml": []byte(`<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>`),
		"book.opf":               []byte(`<package><metadata><title>Fixture EPUB</title><creator>Ada</creator></metadata><manifest><item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>`),
		"chapter.xhtml":          []byte(`<html><body><h1>Chapter title</h1><p>Original chapter text.</p><img src="picture.png"/><script>malicious()</script></body></html>`),
		"picture.png":            {137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0}}
	for name, data := range files {
		f, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// normalizePDFHints 给测试补齐 OCR-only 导入所需的页面尺寸（缺省按 A4）。
func normalizePDFHints(hints []publicationMetadataHint) []publicationMetadataHint {
	out := append([]publicationMetadataHint(nil), hints...)
	if len(out) == 0 {
		out = append(out, publicationMetadataHint{})
	}
	for index := range out {
		if len(out[index].Pages) == 0 {
			out[index].Pages = []publicationPageHint{{Page: 1, Width: 595, Height: 842}}
		}
		for page := range out[index].Pages {
			if out[index].Pages[page].Width <= 0 {
				out[index].Pages[page].Width = 595
			}
			if out[index].Pages[page].Height <= 0 {
				out[index].Pages[page].Height = 842
			}
		}
	}
	return out
}

func uploadPublication(t *testing.T, b *httptestServerBundle, name string, data []byte, hints ...publicationMetadataHint) map[string]any {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("files", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	effectiveHints := hints
	if strings.HasSuffix(strings.ToLower(name), ".pdf") {
		// OCR-only 导入需要页面尺寸：老测试没有带，这里补成单页 A4。
		effectiveHints = normalizePDFHints(hints)
	}
	if len(effectiveHints) > 0 {
		raw, _ := json.Marshal(effectiveHints)
		_ = form.WriteField("metadata", string(raw))
	}
	_ = form.Close()
	// PDF 导入现在必须走 OCR：测试默认接一个假 PaddleOCR（未显式配置时）。
	if strings.HasSuffix(strings.ToLower(name), ".pdf") {
		ensureTestOCR(t, b)
	}
	req, _ := http.NewRequest("POST", b.frontend.URL+"/v1/import/files", &body)
	req.Header.Set("Authorization", "Bearer "+b.token)
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := b.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	payload := decode(t, res)
	if res.StatusCode != 200 {
		t.Fatalf("upload failed %d: %v", res.StatusCode, payload)
	}
	return payload["results"].([]any)[0].(map[string]any)
}
func TestEPUBUploadReadAnnotateLocateAndDedupe(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	b := &httptestServerBundle{front, cfg.Token, cfg, handle}
	data := epubFixture(t)
	result := uploadPublication(t, b, "fixture.epub", data)
	if result["error"] != nil {
		t.Fatal(result)
	}
	doc := result["document"].(map[string]any)
	key := doc["key"].(string)
	if doc["format"] != "epub" || doc["title"] != "Fixture EPUB" {
		t.Fatal(doc)
	}
	detail := decode(t, get(t, front, "/v1/documents/"+key, b.token))
	if len(detail["sections"].([]any)) != 1 || detail["hasText"] != true || detail["hasPdf"] != false {
		t.Fatal(detail)
	}
	section := decode(t, get(t, front, "/v1/documents/"+key+"/sections/1", b.token))
	if strings.Contains(section["text"].(string), "malicious") {
		t.Fatal("active content leaked")
	}
	res, annotation := post(t, b, "POST", "/v1/annotations/"+key, `{"page":null,"quote":"Original chapter text.","kind":"underline","locator":{"kind":"epub","href":"chapter.xhtml","blockStart":1,"blockEnd":1,"startOffset":0,"endOffset":22}}`)
	if res.StatusCode != 201 {
		t.Fatal(annotation)
	}
	listed := decode(t, get(t, front, "/v1/annotations/"+key, b.token))
	if listed["annotations"].([]any)[0].(map[string]any)["locator"].(map[string]any)["href"] != "chapter.xhtml" {
		t.Fatal(listed)
	}
	res, location := post(t, b, "PUT", "/v1/documents/"+key+"/location", `{"kind":"epub","href":"chapter.xhtml","index":1}`)
	if res.StatusCode != 200 {
		t.Fatal(location)
	}
	location = decode(t, get(t, front, "/v1/documents/"+key+"/location", b.token))
	if location["location"].(map[string]any)["kind"] != "epub" {
		t.Fatal(location)
	}
	res = get(t, front, "/v1/documents/"+key+"/resource?path=picture.png", b.token)
	if res.StatusCode != 200 || res.Header.Get("Content-Type") != "image/png" {
		t.Fatal(res.Status)
	}
	res.Body.Close()
	res = get(t, front, "/v1/documents/"+key+"/resource?path=chapter.xhtml", b.token)
	if res.StatusCode != 415 {
		t.Fatal("active resource should not be served")
	}
	res.Body.Close()
	again := uploadPublication(t, b, "renamed.epub", data)
	if again["existing"] != true {
		t.Fatal(again)
	}
	var count int
	_ = handle.QueryRow(`SELECT COUNT(*) FROM annotations WHERE document_id=?`, key).Scan(&count)
	if count != 1 {
		t.Fatal("dedupe destroyed notes")
	}
	system, _, _, unit, err := New(cfg, handle).chatContext(context.Background(), key, "question", "", "")
	if err != nil || unit != "章" || !strings.Contains(system, "Chapter 1") {
		t.Fatalf("EPUB is not grounded to chapters: %s %v", system, err)
	}
}

// TestImportRequiresOCRAndAI 锁定「没有 OCR 和 AI 一律导入失败」：不再有文本层回退。
func TestImportRequiresOCRAndAI(t *testing.T) {
	bundle, _ := newImportServer(t)
	server := New(bundle.cfg, bundle.handle)
	pages := []publicationPageHint{{Page: 1, Width: 595, Height: 842, Text: "Some text."}}
	metadata := recognizedPaperMetadata{}
	if err := server.prepareImportTranslations(context.Background(), []byte("%PDF-1.4\nfixture"), pages, &metadata); err == nil || !strings.Contains(err.Error(), "AI") {
		t.Fatalf("未配置 AI 时应报错: %v", err)
	}
	writeAIConfig(t, bundle, "http://127.0.0.1:1/v1")
	metadata = recognizedPaperMetadata{}
	if err := server.prepareImportTranslations(context.Background(), []byte("%PDF-1.4\nfixture"), pages, &metadata); err == nil || !strings.Contains(err.Error(), "PaddleOCR") {
		t.Fatalf("未配置 OCR 时应报错: %v", err)
	}
}

func TestPDFFileAuthenticationAndRectangles(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	b := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"Sample PDF","translatedTitle":"示例 PDF","authors":[]}`, http.StatusOK
		}
		return `{"items":[{"i":0,"t":"译文"}]}`, http.StatusOK
	})
	writeAIConfig(t, b, upstream.URL)
	data := testPDF(t)
	result := uploadPublication(t, b, "sample.pdf", data)
	if result["error"] != nil {
		t.Fatalf("PDF 导入失败: %v", result)
	}
	key := result["document"].(map[string]any)["key"].(string)
	res := get(t, front, "/v1/documents/"+key+"/file", "")
	if res.StatusCode != 401 {
		t.Fatal("file bypassed token")
	}
	res.Body.Close()
	res = get(t, front, "/v1/documents/"+key+"/file", b.token)
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Equal(got, data) {
		t.Fatal("file bytes changed")
	}
	for _, width := range []float64{.2, 2} {
		res, payload := post(t, b, "POST", "/v1/annotations/"+key, fmt.Sprintf(`{"page":1,"quote":"fixture","locator":{"kind":"pdf","rects":[{"x":0.1,"y":0.2,"width":%f,"height":0.03}]}}`, width))
		if (res.StatusCode == 201) != (width < 1) {
			t.Fatalf("rectangle accepted incorrectly: %d %v", res.StatusCode, payload)
		}
	}
	res, payload := post(t, b, "PUT", "/v1/documents/"+key+"/location", `{"kind":"epub","href":"fake.xhtml","index":1}`)
	if res.StatusCode != 400 {
		t.Fatal(payload)
	}
	invalid := uploadPublication(t, b, "fake.pdf", []byte("<html>Not a document</html>"))
	if invalid["error"] == nil {
		t.Fatal("HTML accepted as PDF")
	}
}
func TestImportDoesNotFetchPrivateServices(t *testing.T) {
	for _, value := range []string{"http://127.0.0.1:1/secrets", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd"} {
		if _, _, err := fetchPublic(context.Background(), value, 1024); err == nil {
			t.Fatal("private URL accepted")
		}
	}
	for _, value := range []string{"2209.14540", "https://arxiv.org/abs/2209.14540v2"} {
		resolved, err := remotePublicationURL(value)
		if err != nil || !strings.HasPrefix(resolved, "https://arxiv.org/pdf/") {
			t.Fatalf("arxiv resolution: %s %v", resolved, err)
		}
	}
}
func TestAISettingsKeepKeysPrivateAndSeparateByDestination(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	b := &httptestServerBundle{front, cfg.Token, cfg, handle}
	file := legacy.NewPaths(cfg.DataRoot).ConfigFile()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(file, []byte(`{"baseURL":"https://first.test/v1","apiKey":"first-secret","model":"m","researchProfile":{"topic":"CBCT"}}`), 0600)
	getBody := decode(t, get(t, front, "/v1/ai/settings", b.token))
	encoded, _ := json.Marshal(getBody)
	if bytes.Contains(encoded, []byte("first-secret")) {
		t.Fatal("settings exposed key")
	}
	for _, base := range []string{"https://other.test/v1", "https://first.test/v1"} {
		res, payload := post(t, b, "PUT", "/v1/ai/settings", `{"provider":"openai","baseURL":"`+base+`","model":"m"}`)
		if res.StatusCode != 200 {
			t.Fatal(payload)
		}
		raw, _ := os.ReadFile(file)
		var config map[string]any
		_ = json.Unmarshal(raw, &config)
		expected := ""
		if strings.Contains(base, "first") {
			expected = "first-secret"
		}
		if config["apiKey"] != expected || config["researchProfile"] == nil {
			t.Fatal("credential crossed destination or unrelated config lost")
		}
	}
	_ = os.WriteFile(file, []byte("{broken"), 0600)
	res, _ := post(t, b, "PUT", "/v1/ai/settings", `{"provider":"openai","baseURL":"https://first.test/v1","model":"m"}`)
	if res.StatusCode != 422 {
		t.Fatal("damaged settings overwritten")
	}
}
func TestCrossrefMetadataCandidates(t *testing.T) {
	raw := []byte(`{"message":{"items":[{"title":["Research title"],"DOI":"10.1234/test","author":[{"given":"Ada","family":"Lovelace"}],"link":[{"URL":"https://example.org/paper.pdf","content-type":"application/pdf"}]}]}}`)
	items, err := crossrefCandidates(raw, false)
	if err != nil || len(items) != 1 || items[0].Authors[0] != "Ada Lovelace" {
		t.Fatalf("bad metadata: %+v %v", items, err)
	}
	u, _ := url.Parse(items[0].URL)
	if validateRemoteURL(u) != nil {
		t.Fatal("valid link rejected")
	}
}

type failedDownloadReader struct{}

func (failedDownloadReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func TestDownloadProgressAndIncompleteBodies(t *testing.T) {
	source := strings.Repeat("x", 150000)
	var received int64
	data, err := readPublicationDownload(strings.NewReader(source), 200000, int64(len(source)), func(n, total int64) {
		received = n
		if total != 150000 {
			t.Fatal(total)
		}
	})
	if err != nil || len(data) != len(source) || received != int64(len(source)) {
		t.Fatalf("download/progress lost: %d %d %v", len(data), received, err)
	}
	if _, err = readPublicationDownload(strings.NewReader(source), 100000, 150000, nil); err == nil {
		t.Fatal("oversized download accepted")
	}
	if data, err = readPublicationDownload(io.MultiReader(strings.NewReader("partial"), failedDownloadReader{}), 100, 100, nil); err == nil || data != nil {
		t.Fatal("partial document returned as complete")
	}
}
func TestOnlineImportStreamsProgressAndCommitsOnlyCompletedFiles(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
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
	for _, failure := range []bool{true, false} {
		server := New(cfg, handle)
		server.downloadPublication = func(_ context.Context, raw string, _ int64, progress func(int64, int64)) ([]byte, string, error) {
			progress(4, 16)
			if failure {
				return nil, "", io.ErrUnexpectedEOF
			}
			return testPDF(t), raw, nil
		}
		req := httptest.NewRequest("POST", "http://127.0.0.1/v1/import/url", strings.NewReader(`{"value":"https://public.test/paper.pdf"}`))
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		req.Header.Set("Accept", "text/event-stream")
		recorder := httptest.NewRecorder()
		server.Handler().ServeHTTP(recorder, req)
		body := recorder.Body.String()
		if !strings.Contains(body, `"received":4`) || recorder.Header().Get("Content-Type") != "text/event-stream" {
			t.Fatal(body)
		}
		if strings.Contains(body, `"result"`) == failure {
			t.Fatalf("completion incorrectly reported: %s", body)
		}
		var count int
		_ = handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count)
		if failure && count != 0 {
			t.Fatal("partial download committed")
		}
		if !failure && count != 1 {
			t.Fatal("complete download missing")
		}
	}
}

func TestAttachArxivPDFToExistingBookEntry(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{token: cfg.Token, cfg: cfg, handle: handle}
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
	key := "saved-title-only-paper"
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,authors,format) VALUES(?,?,?,?,?)`, key, key, "A Paper With An Exact Title", `[]`, "pdf"); err != nil {
		t.Fatal(err)
	}
	server := New(cfg, handle)
	server.downloadPublication = func(_ context.Context, raw string, _ int64, progress func(int64, int64)) ([]byte, string, error) {
		if raw != "https://arxiv.org/pdf/2209.14540v2" {
			t.Fatalf("unexpected arXiv URL: %s", raw)
		}
		progress(8, 16)
		return testPDF(t), raw, nil
	}
	frontend := httptest.NewServer(server.Handler())
	defer frontend.Close()
	req, err := http.NewRequest(http.MethodPost, frontend.URL+"/v1/documents/"+key+"/arxiv-pdf", strings.NewReader(`{"arxiv":"2209.14540v2"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	res, err := frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if readErr != nil || res.StatusCode != http.StatusOK || !strings.Contains(string(body), `"received":8`) || !strings.Contains(string(body), `"result"`) {
		t.Fatalf("download stream failed (%d): %s (%v)", res.StatusCode, body, readErr)
	}
	if _, err := os.Stat(filepath.Join(legacy.NewPaths(cfg.DataRoot).LibraryDir(), key+".pdf")); err != nil {
		t.Fatalf("PDF was not saved into the existing book: %v", err)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM documents WHERE key=?`, key).Scan(&count); err != nil || count != 1 {
		t.Fatalf("existing entry was duplicated: count=%d err=%v", count, err)
	}
}

// 并发补 PDF 时，后到的请求只能清理自己创建的孤儿文件；已经被别的行引用的
// 文件绝不能删（否则 documents.pdf_path 会指向不存在的路径）。
func TestRemoveUnreferencedLibraryFileKeepsReferencedTarget(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	server := New(bundle.cfg, bundle.handle)

	target := filepath.Join(paths.LibraryDir(), "doc-concurrent.pdf")
	if err := os.WriteFile(target, []byte("%PDF-1.4\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := bundle.handle.Exec(
		`INSERT INTO documents(id,key,pdf_path) VALUES(?,?,?)`, "doc-concurrent", "doc-concurrent", target); err != nil {
		t.Fatal(err)
	}

	server.removeUnreferencedLibraryFile(context.Background(), target)
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("仍被 documents.pdf_path 引用的文件不得删除: %v", err)
	}

	if _, err := bundle.handle.Exec(`UPDATE documents SET pdf_path='' WHERE id=?`, "doc-concurrent"); err != nil {
		t.Fatal(err)
	}
	server.removeUnreferencedLibraryFile(context.Background(), target)
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("无人引用的孤儿文件应被清理，实际 err=%v", err)
	}
}

// 「清除 Key」必须清掉所有历史渠道：切换过服务商后旧 Key 仍留在 connections 里，
// 用户以为删干净了，磁盘上却还是明文。
func TestAISettingsClearKeyRemovesAllConnections(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	file := paths.ConfigFile()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	seed := `{"provider":"openai","baseURL":"https://third.test/v1","apiKey":"third-secret","model":"m","connections":{` +
		`"openai|https://first.test/v1":"first-secret",` +
		`"openai|https://second.test/v1":"second-secret",` +
		`"openai|https://third.test/v1":"third-secret"}}`
	if err := os.WriteFile(file, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	res, payload := post(t, bundle, "PUT", "/v1/ai/settings",
		`{"provider":"openai","baseURL":"https://third.test/v1","model":"m","clearKey":true}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存设置失败: %d %v", res.StatusCode, payload)
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		APIKey      string            `json:"apiKey"`
		Connections map[string]string `json:"connections"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatalf("配置不是合法 JSON: %v", err)
	}
	if config.APIKey != "" {
		t.Fatalf("顶层 apiKey 未清空: %q", config.APIKey)
	}
	for destination, key := range config.Connections {
		if key != "" {
			t.Fatalf("历史渠道 %s 仍保留 Key", destination)
		}
	}
}
