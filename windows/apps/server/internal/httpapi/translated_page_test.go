package httpapi

import (
	"testing"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
)

// Reader 从 ocr-layout 还原页面后，翻译身份必须与导入时一致；否则会绕过
// Retain 导入生成的译文，重新调用一次 Go 翻译引擎。
func TestLayoutRoundTripKeepsTranslationCacheIdentity(t *testing.T) {
	page := ocr.Page{Index: 0, Width: 595, Height: 842, Blocks: []ocr.Block{{
		Kind: "text", Text: "We reconstruct attenuation with a learned field.", Translatable: true,
		Box:               [4]float64{72, 72, 500, 140},
		LineTexts:         []string{"We reconstruct attenuation", "with a learned field."},
		Segments:          []ocr.Segment{{Type: "formula", Text: "E=mc^2"}},
		ContinuationGroup: "group-1", ContinuationSignature: "signature-1",
	}}}
	layout := layoutDoc{Pages: []layoutPage{{
		Page: 1, Width: 595, Height: 842,
		Blocks: []layoutBlock{{
			Kind: "text", Text: page.Blocks[0].Text, Box: page.Blocks[0].Box,
			LineTexts: page.Blocks[0].LineTexts, Segments: page.Blocks[0].Segments,
			ContinuationGroup: "group-1", ContinuationSignature: "signature-1",
		}},
	}}}
	original, _, _ := pageTranslationItems(page, nil, nil)
	restored, _, _ := pageTranslationItems(layoutOCRPages(layout)[0], nil, nil)
	if len(original) != 1 || len(restored) != 1 {
		t.Fatalf("段落条目数量异常: %d / %d", len(original), len(restored))
	}
	config := &ai.Config{Provider: "openai", BaseURL: "http://127.0.0.1:1/v1", Model: "test-model"}
	if translationCacheHash(original[0], config) != translationCacheHash(restored[0], config) {
		t.Fatal("版式往返后翻译缓存身份变了：阅读器会重复翻译")
	}
}

func TestPageRenderCacheIsScopedToDocumentAndSource(t *testing.T) {
	blocks := []render.Block{{Text: "translated", Box: [4]float64{10, 10, 100, 40}}}
	dir := t.TempDir()
	base, err := pageRenderCachePath(dir, "doc-a", []byte("%PDF-A"), 1, blocks)
	if err != nil {
		t.Fatal(err)
	}
	otherDocument, err := pageRenderCachePath(dir, "doc-b", []byte("%PDF-A"), 1, blocks)
	if err != nil {
		t.Fatal(err)
	}
	otherSource, err := pageRenderCachePath(dir, "doc-a", []byte("%PDF-B"), 1, blocks)
	if err != nil {
		t.Fatal(err)
	}
	if base == otherDocument || base == otherSource || otherDocument == otherSource {
		t.Fatalf("文档/源 PDF 不同应有独立缓存：%q %q %q", base, otherDocument, otherSource)
	}
}

func TestImportPageSizesRetainsPageCountWhenDimensionsAreMissing(t *testing.T) {
	sizes, complete := importPageSizes([]publicationPageHint{
		{Page: 1, Width: 595, Height: 842},
		{Page: 2},
	})
	if complete {
		t.Fatal("页面缺少尺寸时应标记为不完整")
	}
	if len(sizes) != 2 || sizes[1].Width != 0 || sizes[1].Height != 0 {
		t.Fatalf("缺少尺寸仍须保留 OCR 页数对齐信息：%+v", sizes)
	}
}
