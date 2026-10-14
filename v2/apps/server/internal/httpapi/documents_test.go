package httpapi

import (
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

	"cbctv2/server/internal/db"
	"cbctv2/server/internal/legacy"
)

// newImportServer 造一份「旧数据 + 空库」的环境，并跑一次导入，返回可用的测试服务。
func newImportServer(t *testing.T) (*httptestServerBundle, legacy.Paths) {
	t.Helper()
	root := t.TempDir()
	paths := legacy.NewPaths(root)
	for _, dir := range []string{paths.TextDir(), paths.ReadingsDir(), paths.LibraryDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(paths.QueueFile(), `{"papers":[
		{"arxiv":"2209.14540","title":"NAF: Neural Attenuation Fields","authors":["Ruyi Zha"],"venue":"ECCV 2022","year":"2022"},
		{"id":"intratomo-2021","title":"IntraTomo","authors":["Guangming Zang"],"venue":"ICCV 2021","year":"2021"}
	]}`)
	write(paths.TextCacheFile("2209.14540"), "=== Page 1 ===\nNAF abstract line.\n=== Page 2 ===\nWe train using 50 views.\n")
	write(paths.ReadingFile("2209.14540"), `{"key":"2209.14540","notes":"读到这里"}`)
	write(filepath.Join(paths.LibraryDir(), "2209.14540.pdf"), "%PDF-1.4\n%fake body bytes\n")
	write(paths.ProgressFile(), `{"intratomo-2021":{"step":2}}`)

	cfg := defaultTestConfig(root)
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	bundle := serve(t, cfg, handle)
	return bundle, paths
}

func get(t *testing.T, frontend *httptest.Server, path, token string) *http.Response {
	t.Helper()
	return do(t, frontend, http.MethodGet, path, token)
}

func post(t *testing.T, bundle *httptestServerBundle, method, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, bundle.frontend.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	res, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s 失败: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var payload map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("%s %s 响应不是 JSON（%d）: %s", method, path, res.StatusCode, string(raw))
		}
	}
	return res, payload
}

func TestImportEndpointIsTokenGuardedAndIdempotent(t *testing.T) {
	bundle, _ := newImportServer(t)

	req, _ := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/import", strings.NewReader("{}"))
	res, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("导入接口必须鉴权，实际 %d", res.StatusCode)
	}

	first, payload := post(t, bundle, http.MethodPost, "/v1/import", "")
	if first.StatusCode != http.StatusOK {
		t.Fatalf("导入应 200，实际 %d %v", first.StatusCode, payload)
	}
	if payload["documentsAdded"] != float64(2) {
		t.Fatalf("应导入 2 篇，实际 %v", payload["documentsAdded"])
	}
	if backup, _ := payload["backupDir"].(string); backup == "" {
		t.Fatal("首次导入必须备份旧数据")
	}

	second, payload := post(t, bundle, http.MethodPost, "/v1/import", "")
	if second.StatusCode != http.StatusOK {
		t.Fatalf("重复导入应仍可执行，实际 %d", second.StatusCode)
	}
	if payload["documentsAdded"] != float64(0) || payload["documentsUnchanged"] != float64(2) {
		t.Fatalf("重复导入必须幂等，实际 %v", payload)
	}
}

func TestDocumentListFilters(t *testing.T) {
	bundle, _ := newImportServer(t)
	if _, payload := post(t, bundle, http.MethodPost, "/v1/import", ""); payload["documentsAdded"] != float64(2) {
		t.Fatal("前置导入失败")
	}

	all := decode(t, get(t, bundle.frontend, "/v1/documents", bundle.token))
	if all["total"] != float64(2) {
		t.Fatalf("应有 2 篇，实际 %v", all["total"])
	}
	// intratomo 有进度 → reading 排在前；NAF 无精读记录也无进度 → queue。
	first := all["documents"].([]any)[0].(map[string]any)
	if first["id"] != "intratomo-2021" || first["status"] != "reading" {
		t.Fatalf("reading 应排最前，实际 %v", first)
	}

	reading := decode(t, get(t, bundle.frontend, "/v1/documents?status=reading", bundle.token))
	if reading["total"] != float64(1) {
		t.Fatalf("status 筛选失效，实际 %v", reading)
	}
	search := decode(t, get(t, bundle.frontend, "/v1/documents?q=intra", bundle.token))
	if search["total"] != float64(1) {
		t.Fatalf("只有 IntraTomo 标题含 intra，实际 %v", search)
	}
	// venue 也进检索：ECCV 2022 与 ICCV 2021 都含 "202"。
	if both := decode(t, get(t, bundle.frontend, "/v1/documents?q=202", bundle.token)); both["total"] != float64(2) {
		t.Fatalf("按 venue 检索失效，实际 %v", both)
	}
	if none := decode(t, get(t, bundle.frontend, "/v1/documents?q=zzz-not-a-paper", bundle.token)); none["total"] != float64(0) {
		t.Fatalf("无匹配时应返回空数组，实际 %v", none)
	}
	search = decode(t, get(t, bundle.frontend, "/v1/documents?q=Attenuation", bundle.token))
	docs := search["documents"].([]any)
	if len(docs) != 1 || docs[0].(map[string]any)["id"] != "2209.14540" {
		t.Fatalf("按标题检索错误，实际 %v", search)
	}
	res := get(t, bundle.frontend, "/v1/documents?status=nope", bundle.token)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知 status 应 400，实际 %d", res.StatusCode)
	}
}

func TestDocumentDetailPagesAndReading(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")

	detail := decode(t, get(t, bundle.frontend, "/v1/documents/2209.14540", bundle.token))
	document := detail["document"].(map[string]any)
	if document["title"] != "NAF: Neural Attenuation Fields" {
		t.Fatalf("详情文档错误: %v", document)
	}
	if detail["hasText"] != true || detail["hasPdf"] != true {
		t.Fatalf("应识别到正文与 PDF: %v", detail)
	}
	pages := detail["pages"].([]any)
	if len(pages) != 2 {
		t.Fatalf("详情应带 2 页索引，实际 %v", pages)
	}
	if pages[0].(map[string]any)["chars"] == nil {
		t.Fatal("页索引应含字数")
	}
	reading, ok := detail["reading"].(map[string]any)
	if !ok || reading["notes"] != "读到这里" {
		t.Fatalf("精读记录未随详情返回: %v", detail["reading"])
	}

	page := decode(t, get(t, bundle.frontend, "/v1/documents/2209.14540/pages/2", bundle.token))
	if !strings.Contains(fmt.Sprint(page["text"]), "50 views") {
		t.Fatalf("第 2 页正文错误: %v", page)
	}
	if res := get(t, bundle.frontend, "/v1/documents/2209.14540/pages/9", bundle.token); res.StatusCode != http.StatusNotFound {
		t.Fatalf("缺页应 404，实际 %d", res.StatusCode)
	}
	if res := get(t, bundle.frontend, "/v1/documents/nope/pages/1", bundle.token); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
}

func TestUnsafeKeysRejectedOnEveryRoute(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	for _, path := range []string{
		"/v1/documents/..%2F..%2Fetc%2Fpasswd",
		"/v1/documents/%2E%2E/pages",
		"/v1/documents/..%5Cwindows/pages/1",
	} {
		req, err := http.NewRequest(http.MethodGet, bundle.frontend.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+bundle.token)
		res, err := bundle.frontend.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			t.Fatalf("%s 不得返回 200：%s", path, body)
		}
	}
	// 空键与超长键同样被拒。
	if res := get(t, bundle.frontend, "/v1/documents/"+strings.Repeat("a", 400)+"/pages", bundle.token); res.StatusCode == http.StatusOK {
		t.Fatal("超长键必须被拒绝")
	}
}

func TestPageUploadRoundTrip(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")

	res, payload := post(t, bundle, http.MethodPut, "/v1/documents/intratomo-2021/pages/1", `{"text":"新抽取的第一页正文"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("上传应 200，实际 %d %v", res.StatusCode, payload)
	}
	if payload["chars"] != float64(len([]rune("新抽取的第一页正文"))) {
		t.Fatalf("字数应按 rune 计，实际 %v", payload["chars"])
	}
	page := decode(t, get(t, bundle.frontend, "/v1/documents/intratomo-2021/pages/1", bundle.token))
	if page["text"] != "新抽取的第一页正文" {
		t.Fatalf("回读不一致: %v", page)
	}

	if res, _ := post(t, bundle, http.MethodPut, "/v1/documents/intratomo-2021/pages/2", `{"text":"   "}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空正文应被拒，实际 %d", res.StatusCode)
	}
	if res, _ := post(t, bundle, http.MethodPut, "/v1/documents/intratomo-2021/pages/0", `{"text":"x"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("页码 0 应被拒，实际 %d", res.StatusCode)
	}
	if res, _ := post(t, bundle, http.MethodPut, "/v1/documents/nope/pages/1", `{"text":"x"}`); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
	oversized := `{"text":"` + strings.Repeat("a", maxPageBody+16) + `"}`
	if res, _ := post(t, bundle, http.MethodPut, "/v1/documents/intratomo-2021/pages/3", oversized); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("超过 1 MiB 应 413，实际 %d", res.StatusCode)
	}
	// 覆盖写：同页二次上传应替换而不是追加。
	post(t, bundle, http.MethodPut, "/v1/documents/intratomo-2021/pages/1", `{"text":"改过的正文"}`)
	page = decode(t, get(t, bundle.frontend, "/v1/documents/intratomo-2021/pages/1", bundle.token))
	if page["text"] != "改过的正文" {
		t.Fatalf("同页应覆盖，实际 %v", page["text"])
	}
}

func TestStatusPatchSurvivesReimport(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")

	res, payload := post(t, bundle, http.MethodPatch, "/v1/documents/2209.14540/status", `{"status":"done"}`)
	if res.StatusCode != http.StatusOK || payload["status"] != "done" {
		t.Fatalf("改状态应成功，实际 %d %v", res.StatusCode, payload)
	}
	if _, payload := post(t, bundle, http.MethodPost, "/v1/import", ""); payload["documentsUpdated"] == float64(0) {
		_ = payload // 元数据未变时可能整批 unchanged，这里只关心状态是否被冲掉
	}
	detail := decode(t, get(t, bundle.frontend, "/v1/documents/2209.14540", bundle.token))
	if status := detail["document"].(map[string]any)["status"]; status != "done" {
		t.Fatalf("重跑导入不得冲掉用户手改状态，实际 %v", status)
	}
	if res, _ := post(t, bundle, http.MethodPatch, "/v1/documents/2209.14540/status", `{"status":"bogus"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法状态应 400，实际 %d", res.StatusCode)
	}
}

func TestPDFStreamingAndRange(t *testing.T) {
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")

	req, _ := http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/documents/2209.14540/pdf", nil)
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Range", "bytes=0-7")
	res, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusPartialContent {
		t.Fatalf("PDF 应支持 Range（pdf.js 依赖它），实际 %d", res.StatusCode)
	}
	if got := string(body); got != "%PDF-1.4" {
		t.Fatalf("Range 内容错误: %q", got)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/pdf" {
		t.Fatalf("Content-Type 应为 application/pdf，实际 %q", ct)
	}
	if res := get(t, bundle.frontend, "/v1/documents/intratomo-2021/pdf", bundle.token); res.StatusCode != http.StatusNotFound {
		t.Fatalf("没有本地 PDF 应 404，实际 %d", res.StatusCode)
	}
}

func TestImportFailureReturnsActionableStatus(t *testing.T) {
	bundle, paths := newImportServer(t)
	if err := os.WriteFile(paths.QueueFile(), []byte(`{"papers":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	res, payload := post(t, bundle, http.MethodPost, "/v1/import", "")
	if res.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("数据本身有问题应 422，实际 %d %v", res.StatusCode, payload)
	}
	if !strings.Contains(fmt.Sprint(payload["error"]), "queue.json") {
		t.Fatalf("错误信息要指出是哪个文件，实际 %v", payload["error"])
	}
}

var _ = time.Second
