package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestFullTranslationIsSavedAfterBackgroundImport(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	var calls atomic.Int64
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		calls.Add(1)
		// Background translation starts only after the source has committed.
		if len(sources) > 0 {
			var count int
			if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
				t.Error(err)
			}
			if count != 1 {
				t.Error("source must be committed before background translation")
			}
		}
		if len(sources) == 0 {
			return `{"title":"Real paper title","translatedTitle":"真实论文标题","authors":[],"year":0}`, 200
		}
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "random.pdf", testPDF(t), publicationMetadataHint{
		FirstPage: "Real paper title", Pages: []publicationPageHint{{Page: 1, Text: "First paragraph.\nSecond paragraph.", Segments: []string{"First paragraph.", "Second paragraph."}}},
	})
	if result["error"] != nil {
		t.Fatal(result)
	}
	key := result["document"].(map[string]any)["key"].(string)
	if stage := waitForTestJobStage(t, bundle, key, "translate"); stage["status"] != "done" {
		t.Fatalf("background translation failed: %v", stage)
	}
	if calls.Load() < 1 {
		t.Fatalf("模型调用次数异常: %d", calls.Load())
	}
	var translated int
	if err := handle.QueryRow(`SELECT count(*) FROM translations WHERE document_id=?`, key).Scan(&translated); err != nil {
		t.Fatal(err)
	}
	if translated == 0 {
		t.Fatal("后台完成后没有保存 OCR 段落译文")
	}
	var source, target string
	if err := handle.QueryRow(`SELECT source,target FROM translations WHERE document_id=? LIMIT 1`, key).Scan(&source, &target); err != nil {
		t.Fatal(err)
	}
	if target != "译文："+source {
		t.Fatalf("模型协议或元数据被当作译文保存: source=%q target=%q", source, target)
	}
	var pageCount int
	if err := handle.QueryRow(`SELECT count(*) FROM document_pages WHERE document_id=?`, key).Scan(&pageCount); err != nil {
		t.Fatal(err)
	}
	if pageCount != 1 {
		t.Fatal("source page missing from import transaction")
	}
}

// 每日推荐卡片在导入前已经拿到 OpenAlex 的 DOI/作者：模型没识别出来的字段不能被写空。
func TestKnownMetadataHintsSurviveModelGaps(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"Recognized Paper Title","translatedTitle":"识别出的标题","authors":[],"doi":"","year":0}`, 200
		}
		return `{"items":[{"i":0,"t":"第一段译文"}]}`, 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "downloaded.pdf", testPDF(t), publicationMetadataHint{
		Title:     "Seeded Title From Daily Card",
		Author:    "Ada Lovelace",
		DOI:       "10.1234/seeded.doi",
		FirstPage: "Seeded Title From Daily Card\nAda Lovelace\nMICCAI 2026",
		Pages:     []publicationPageHint{{Page: 1, Text: "First paragraph.", Segments: []string{"First paragraph."}}},
	})
	if result["error"] != nil {
		t.Fatal(result)
	}
	document := result["document"].(map[string]any)
	if document["doi"] != "10.1234/seeded.doi" {
		t.Errorf("doi = %v, want 10.1234/seeded.doi（模型没给 DOI 时应保留卡片已知值）", document["doi"])
	}
	authors, _ := document["authors"].([]any)
	if len(authors) != 1 || authors[0] != "Ada Lovelace" {
		t.Errorf("authors = %v, want [Ada Lovelace]", document["authors"])
	}
	if document["title"] != "Seeded Title From Daily Card" {
		t.Errorf("title = %v, want preserve the provided metadata hint", document["title"])
	}
}

func TestLeeTranslationFailurePreservesImportedSource(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"Real paper title","translatedTitle":"真实论文标题"}`, 200
		}
		return `{"items":[]}`, 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "filename.pdf", testPDF(t), publicationMetadataHint{
		FirstPage: "Real paper title", Pages: []publicationPageHint{{Page: 1, Text: "Original paragraph.", Segments: []string{"Original paragraph."}}},
	})
	if result["error"] != nil {
		t.Fatalf("格式异常的段落不能中止论文导入：%v", result["error"])
	}
	var count int
	if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("论文应完整入库，实际文档数 %d", count)
	}
	var pageCount, translationCount int
	key := result["document"].(map[string]any)["key"].(string)
	if stage := waitForTestJobStage(t, bundle, key, "translate"); stage["status"] != "failed" {
		t.Fatalf("invalid translation must report failure: %v", stage)
	}
	if err := handle.QueryRow(`SELECT count(*) FROM document_pages WHERE document_id=?`, key).Scan(&pageCount); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT count(*) FROM translations WHERE document_id=?`, key).Scan(&translationCount); err != nil {
		t.Fatal(err)
	}
	if pageCount == 0 || translationCount != 0 {
		t.Fatalf("翻译失败必须保留原文且不保存无效译文：pages=%d translations=%d", pageCount, translationCount)
	}
}

func TestImportPreservesProvidedTitleAuthorAndDOI(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "random-download-name.pdf", testPDF(t), publicationMetadataHint{
		Title: "CBCT reconstruction with sparse/full views", Author: "Ada Lovelace", DOI: "10.1234/example",
	})
	if result["error"] != nil {
		t.Fatal(result)
	}
	doc := result["document"].(map[string]any)
	if doc["title"] != "CBCT reconstruction with sparse/full views" || doc["doi"] != "10.1234/example" || len(doc["authors"].([]any)) != 1 || doc["authors"].([]any)[0] != "Ada Lovelace" {
		t.Fatalf("incorrect metadata: %v", doc)
	}
	req, _ := http.NewRequest("GET", front.URL+"/v1/documents?q=CBCT", nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	response, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if payload := decode(t, response); payload["total"] != float64(1) {
		t.Fatal(payload)
	}
}

func TestPDFImportDoesNotRequireSeparateMetadataRecognition(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		items := make([]map[string]any, len(sources))
		for index, source := range sources {
			items[index] = map[string]any{"i": index, "t": "译文：" + source}
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	ensureTestOCR(t, bundle)
	result := uploadPublication(t, bundle, "filename.pdf", testPDF(t), publicationMetadataHint{})
	if result["error"] != nil {
		t.Fatalf("Lee processing should not depend on separate metadata recognition: %v", result["error"])
	}
	if _, err := handle.Exec(`SELECT 1 FROM documents WHERE id=?`, result["document"].(map[string]any)["id"]); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadForRecognitionDoesNotImport(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	server.downloadPublication = func(_ context.Context, raw string, _ int64, _ func(int64, int64)) ([]byte, string, error) {
		return testPDF(t), raw, nil
	}
	front := httptest.NewServer(server.Handler())
	defer front.Close()
	req, _ := http.NewRequest("POST", front.URL+"/v1/import/url", strings.NewReader(`{"value":"https://example.org/paper.pdf","downloadOnly":true}`))
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	response, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !strings.HasPrefix(string(data), "%PDF-") {
		t.Fatalf("download failed: %d %s", response.StatusCode, data)
	}
	var count int
	if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("download-only must not import")
	}
}
