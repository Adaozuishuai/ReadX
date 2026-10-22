package httpapi

import (
	"context"
	"testing"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/ocr"
)

// 译文缓存的键是「段落 + 上下文 + 版式线索」的指纹，写入端与读取端必须算出同一个值。
//
// 写入端拿的是 LeePDF 的归一化文档（字段齐全），读取端拿的是**落库的版式**重建出来的页。
// 所以版式保存时漏掉任何参与指纹的字段，读取端就会永远查不中——现象就是
// 「后台明明已入库 43 段译文，阅读器却显示 0/16」。
func TestLayoutRoundTripKeepsTranslationCacheHash(t *testing.T) {
	ctx := context.Background()
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	aiConfig := ai.Config{
		Provider: "openai", Model: "gpt-test",
		APIKey: "sk-test", BaseURL: "https://example.invalid",
	}

	const key = "round-trip"
	pages := []ocr.Page{{
		Index: 0, Width: 595, Height: 842,
		Blocks: []ocr.Block{{
			Kind: "text", Text: "跨栏续接的段落，上一块没写完", Translatable: true,
			Box: [4]float64{40, 100, 260, 160},
			// 这些是「上一块没写完 / 跨栏续接」的线索，也是缓存指纹的一部分。
			ContinuationGroup:     "group-1",
			ContinuationSignature: "signature-1",
			ContinuationDecision:  "merge",
			ContinuationPrevious:  "上一块的结尾文本",
			ContinuationNext:      "下一块的开头文本",
			LineTexts:             []string{"跨栏续接的段落", "上一块没写完"},
			Segments:              []ocr.Segment{{Type: "text", Text: "跨栏续接的段落"}},
		}},
	}}

	metadata := recognizedPaperMetadata{}
	translated := []leePageTranslation{{
		PageIndex: 0,
		Source:    "跨栏续接的段落，上一块没写完",
		Target:    "译文",
	}}
	if err := leeOutputToReadXMetadata(pages, translated, aiConfig, &metadata); err != nil {
		t.Fatal(err)
	}
	if len(metadata.Translations) != 1 {
		t.Fatalf("应当产出 1 段译文，实际 %d：%+v", len(metadata.Translations), metadata.Translations)
	}
	writerHash := metadata.Translations[0].Hash

	// 版式落库 → 读回 → 重建 item：这就是阅读器轮询译文预览时走的路径。
	tx, err := handle.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := saveLayoutTx(ctx, tx, key, metadata.LayoutPages); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	layout, available, err := server.loadLayout(ctx, key)
	if err != nil || !available {
		t.Fatalf("版式应当读得回来: %v available=%v", err, available)
	}
	restored := layoutOCRPages(layout)
	items, _, _ := pageTranslationItems(restored[0], nil, nil)
	if len(items) != 1 {
		t.Fatalf("重建后应当有 1 段可译内容，实际 %d", len(items))
	}
	readerHash := translationCacheHash(items[0], &aiConfig)

	if writerHash != readerHash {
		t.Fatalf("版式往返后缓存指纹变了，译文永远查不中：\n  写入端 %s\n  读取端 %s", writerHash, readerHash)
	}
}

// 旧版式（丢了续接字段）里已有的译文，必须仍能显示出来。
//
// 这是用户实际遇到的情况：后台已经把译文写进库，但阅读器按指纹永远查不中，
// 页面一直显示「本页译文 0 / N 段」。指纹修好只能救**将来**存进去的版式，
// 已经存进库的版式改不回来，所以必须有「同一篇论文 + 逐字相同原文」的兜底。
func TestTranslationLookupFallsBackToSameSourceText(t *testing.T) {
	ctx := context.Background()
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	const key = "legacy-layout"
	// translations.document_id 有外键约束：先有一篇文档才谈得上它的译文。
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,authors,year,venue,doi,url,status,pdf_path,added_at,updated_at,format,translated_title)
		 VALUES(?,?,?,'[]',0,'','','','reading','','','','pdf','')`, key, key, "Legacy Layout"); err != nil {
		t.Fatal(err)
	}
	page := ocr.Page{Index: 0, Width: 595, Height: 842, Blocks: []ocr.Block{{
		Kind: "text", Text: "库里已经有译文的这一段", Translatable: true, Box: [4]float64{40, 100, 260, 160},
	}}}
	items, _, _ := pageTranslationItems(page, nil, nil)
	if len(items) != 1 {
		t.Fatalf("夹具应当有 1 段可译内容，实际 %d", len(items))
	}

	// 模拟旧版式时代的写入：指纹算自「当时那个更完整的页」，与现在重建出来的不同。
	if err := server.persistLeeTranslationSegments(ctx, key, []translateSegment{
		{Hash: "旧版式时代的指纹", Source: items[0].Source, Target: "库里的既有译文"},
	}); err != nil {
		t.Fatal(err)
	}

	targets, err := server.translatePageItemsMode(ctx, key, items, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0] != "库里的既有译文" {
		t.Fatalf("逐字相同的原文应当取到已有译文，实际 %q", targets)
	}

	// 用户主动「重新翻译」（force）时不能走兜底：那正是他要丢掉旧译文重来。
	forced, err := server.translatePageItemsMode(ctx, key, items, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(forced) != 1 || forced[0] != "" {
		t.Fatalf("force 时不应复用旧译文，实际 %q", forced)
	}
}

// 指纹里包含续接上下文：丢了它，跨栏段落全部查不中（这是多栏论文的常态）。
func TestLayoutRoundTripKeepsContinuationContext(t *testing.T) {
	ctx := context.Background()
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	const key = "round-trip-context"
	pages := []ocr.Page{{
		Index: 0, Width: 595, Height: 842,
		Blocks: []ocr.Block{{
			Kind: "text", Text: "续接段落", Translatable: true, Box: [4]float64{40, 100, 260, 160},
			ContinuationGroup: "g", ContinuationPrevious: "前文", ContinuationNext: "后文",
		}},
	}}
	metadata := recognizedPaperMetadata{}
	if err := leeOutputToReadXMetadata(pages, nil, ai.Config{}, &metadata); err != nil {
		t.Fatal(err)
	}
	tx, err := handle.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := saveLayoutTx(ctx, tx, key, metadata.LayoutPages); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	layout, _, err := server.loadLayout(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	restored := layoutOCRPages(layout)
	block := restored[0].Blocks[0]
	if block.ContinuationPrevious != "前文" || block.ContinuationNext != "后文" {
		t.Fatalf("续接上下文没被持久化：previous=%q next=%q", block.ContinuationPrevious, block.ContinuationNext)
	}
	if block.ContinuationSignature != "signature-1" && block.ContinuationSignature != "" {
		t.Fatalf("续接签名没被持久化：%q", block.ContinuationSignature)
	}
}