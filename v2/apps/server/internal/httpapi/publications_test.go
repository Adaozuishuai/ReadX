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
func uploadPublication(t *testing.T, b *httptestServerBundle, name string, data []byte, hints ...publicationMetadataHint) map[string]any {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("files", name)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(data)
	if len(hints) > 0 {
		raw, _ := json.Marshal(hints)
		_ = form.WriteField("metadata", string(raw))
	}
	_ = form.Close()
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
func TestPDFFileAuthenticationAndRectangles(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	b := &httptestServerBundle{front, cfg.Token, cfg, handle}
	data := []byte("%PDF-1.4\nfixture")
	result := uploadPublication(t, b, "sample.pdf", data)
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
	_, handle, cfg := newTestServer(t, nil)
	for _, failure := range []bool{true, false} {
		server := New(cfg, handle)
		server.downloadPublication = func(_ context.Context, raw string, _ int64, progress func(int64, int64)) ([]byte, string, error) {
			progress(4, 16)
			if failure {
				return nil, "", io.ErrUnexpectedEOF
			}
			return []byte("%PDF-1.4\nfixture"), raw, nil
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
