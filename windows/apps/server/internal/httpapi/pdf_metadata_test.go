package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFullTranslationIsCommittedWithImportAndRestoredWithoutModel(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	calls := 0
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		calls++
		var count int
		if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
			t.Error(err)
		}
		if count != 0 {
			t.Error("entry created before full translation")
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
	result := uploadPublication(t, bundle, "random.pdf", []byte("%PDF-1.4\nfull"), publicationMetadataHint{
		FirstPage: "Real paper title", Pages: []publicationPageHint{{Page: 1, Text: "First paragraph.\nSecond paragraph.", Segments: []string{"First paragraph.", "Second paragraph."}}},
	})
	if result["error"] != nil {
		t.Fatal(result)
	}
	key := result["document"].(map[string]any)["key"].(string)
	// 导入已改为 OCR-only：模型调用应包含题录识别 + OCR 段落翻译，且译文随文档入库。
	if calls < 2 {
		t.Fatalf("模型调用次数异常: %d", calls)
	}
	var translated int
	if err := handle.QueryRow(`SELECT count(*) FROM translations WHERE document_id=?`, key).Scan(&translated); err != nil {
		t.Fatal(err)
	}
	if translated == 0 {
		t.Fatal("OCR 段落的译文没有随导入入库")
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
	result := uploadPublication(t, bundle, "downloaded.pdf", []byte("%PDF-1.4\nhint"), publicationMetadataHint{
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
	if document["title"] != "Recognized Paper Title" {
		t.Errorf("title = %v, want 模型识别结果优先", document["title"])
	}
}

func TestMalformedFullTranslationDoesNotBlockPaperImport(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"Real paper title","translatedTitle":"真实论文标题"}`, 200
		}
		return `{"items":[]}`, 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "filename.pdf", []byte("%PDF-1.4\nfailed-full"), publicationMetadataHint{
		FirstPage: "Real paper title", Pages: []publicationPageHint{{Page: 1, Text: "Original paragraph.", Segments: []string{"Original paragraph."}}},
	})
	if result["error"] != nil {
		t.Fatalf("格式异常的段落不能中止论文导入：%v", result["error"])
	}
	if warning, _ := result["warning"].(string); !strings.Contains(warning, "1 段文本") {
		t.Fatalf("应提示有译文未完成：%v", result["warning"])
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
	if err := handle.QueryRow(`SELECT count(*) FROM document_pages WHERE document_id=?`, key).Scan(&pageCount); err != nil {
		t.Fatal(err)
	}
	if err := handle.QueryRow(`SELECT count(*) FROM translations WHERE document_id=?`, key).Scan(&translationCount); err != nil {
		t.Fatal(err)
	}
	if pageCount != 1 || translationCount != 0 {
		t.Fatalf("应保留原文页且不保存无效译文：pages=%d translations=%d", pageCount, translationCount)
	}
}

func TestAIRecognizesBeforeImportAndPreservesTitleWithSlash(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(_ []string) (string, int) {
		var count int
		if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
			t.Error(err)
		}
		if count != 0 {
			t.Error("library entry was created before AI recognition completed")
		}
		return `{"title":"CBCT reconstruction with sparse/full views","translatedTitle":"稀疏与全视角的 CBCT 重建","authors":["Ada Lovelace","Alan Turing"],"venue":"MICCAI","year":2025,"doi":"10.1234/example"}`, 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	result := uploadPublication(t, bundle, "random-download-name.pdf", []byte("%PDF-1.4\nfixture"), publicationMetadataHint{FirstPage: "CBCT reconstruction with sparse/full views\nAda Lovelace, Alan Turing\nMICCAI 2025"})
	if result["error"] != nil {
		t.Fatal(result)
	}
	doc := result["document"].(map[string]any)
	if doc["title"] != "CBCT reconstruction with sparse/full views" || doc["translatedTitle"] != "稀疏与全视角的 CBCT 重建" || doc["venue"] != "MICCAI" || doc["year"] != float64(2025) || len(doc["authors"].([]any)) != 2 {
		t.Fatalf("incorrect metadata: %v", doc)
	}
	req, _ := http.NewRequest("GET", front.URL+"/v1/documents?q=稀疏", nil)
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

func TestRecognitionFailureDoesNotCreateFilenameEntry(t *testing.T) {
	for _, reply := range []string{"not JSON", `{"title":"Paper","translatedTitle":""}`} {
		t.Run(reply, func(t *testing.T) {
			front, handle, cfg := newTestServer(t, nil)
			bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
			upstream := fakeUpstream(t, func(_ []string) (string, int) { return reply, 200 })
			writeAIConfig(t, bundle, upstream.URL)
			result := uploadPublication(t, bundle, "filename.pdf", []byte("%PDF-1.4\nfixture"), publicationMetadataHint{FirstPage: "Readable paper title and author"})
			if result["error"] == nil {
				t.Fatal("expected explicit recognition error")
			}
			var count int
			if err := handle.QueryRow(`SELECT count(*) FROM documents`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatal("recognition failure must leave library unchanged")
			}
		})
	}
}

func TestDownloadForRecognitionDoesNotImport(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	server.downloadPublication = func(_ context.Context, raw string, _ int64, _ func(int64, int64)) ([]byte, string, error) {
		return []byte("%PDF-1.4\nfixture"), raw, nil
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
