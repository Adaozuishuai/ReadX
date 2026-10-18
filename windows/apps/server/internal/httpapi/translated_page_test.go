package httpapi

import (
	"testing"

	"cbctv2/server/internal/render"
)

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
