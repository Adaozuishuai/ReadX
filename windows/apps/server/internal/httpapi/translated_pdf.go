// translated_pdf.go：生成保留排版的译文 PDF。
//
// 两条输入路径：
//   - 文本层 PDF：前端逐页提取块几何与译文，这里只做几何校验、交给 rpr 引擎排版；
//   - 扫描件：ocr=true，先走 PaddleOCR 文档解析拿到块与坐标，再用 ReadX 的翻译引擎
//     翻译正文块，最后同样交给 rpr。公式、表格、图片、页眉页脚保持原样。
//
// 渲染引擎是 RetainPDF 的 retain-pdf-rendering（MIT），见 resources/rendering-engine。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/ocr"
	"cbctv2/server/internal/render"
	"cbctv2/server/internal/translate"
)

const (
	maxTranslatedPDFBody  = 32 << 20
	maxTranslatedPDFPages = ocr.MaxPDFPages
	maxSourcePDFBytes     = ocr.MaxPDFBytes
)

type translatedPDFPage struct {
	Page   int     `json:"page"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type translatedPDFRequest struct {
	// Pages 只提供页号与尺寸；正文块一律由服务端 OCR 生成。
	Pages []translatedPDFPage `json:"pages"`
}

type translatedPDFResponse struct {
	Key        string        `json:"key"`
	Pages      int           `json:"pages"`
	Blocks     int           `json:"blocks"`
	Skipped    int           `json:"skipped"`
	Overflow   int           `json:"overflow"`
	Collisions int           `json:"collisions"`
	FailedMath int           `json:"failedMath"`
	Bytes      int64         `json:"bytes"`
	Download   string        `json:"download"`
	Report     render.Report `json:"report"`
}

func (s *Server) handleTranslatedPDF(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.serveTranslatedPDF(w, r)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / POST")
		return
	}
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	var body translatedPDFRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxTranslatedPDFBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "版式数据超过 32 MiB 上限")
			return
		}
		writeError(w, http.StatusBadRequest, "请求体必须是 {pages:[…], ocr?:true}")
		return
	}
	pages, err := validateTranslatedPages(body.Pages)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	paths := legacy.NewPaths(s.cfg.DataRoot)
	sourcePath, found := paths.PDFFile(key)
	if !found {
		writeError(w, http.StatusNotFound, "没有原 PDF 文件")
		return
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取原 PDF 失败: "+err.Error())
		return
	}
	if len(source) > maxSourcePDFBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "原 PDF 超过 PaddleOCR 本地上传上限 50 MB")
		return
	}

	renderer := render.New(s.cfg.DataRoot)
	if err := renderer.Available(); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}

	sizes := make([]ocr.Size, len(pages))
	for index, page := range pages {
		sizes[index] = ocr.Size{Width: page.Width, Height: page.Height}
	}

	// 导出也只走 RetainPDF 链路：OCR 识别段落 → 翻译 → rpr 排版。
	// 文本层块 + 旧翻译接口已删除，不再有第二套排版输入。
	if err := s.requireImportProviders(); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	ocrCtx, cancel := context.WithTimeout(r.Context(), 30*time.Minute)
	defer cancel()
	renderPages, err := s.ocrRenderPages(ocrCtx, key, source, sizes)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	if len(renderPages) == 0 {
		writeError(w, http.StatusBadRequest, "OCR 没有可渲染的段落")
		return
	}

	outputPath := filepath.Join(paths.LibraryDir(), key+"-translated.pdf")
	started := time.Now()
	report, err := renderer.Render(r.Context(), source, renderPages, outputPath)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "生成译文 PDF 超时")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "译文 PDF 没有落盘: "+err.Error())
		return
	}
	if report.Timings == nil {
		report.Timings = map[string]any{}
	}
	report.Timings["totalSeconds"] = time.Since(started).Seconds()
	writeJSON(w, http.StatusOK, translatedPDFResponse{
		Key:        key,
		Pages:      report.Pages,
		Blocks:     report.Blocks,
		Skipped:    0,
		Overflow:   report.Overflow,
		Collisions: report.Collisions,
		FailedMath: report.FailedMath,
		Bytes:      info.Size(),
		Download:   "/v1/documents/" + key + "/translated-pdf",
		Report:     report,
	})
}

func (s *Server) serveTranslatedPDF(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	path := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+"-translated.pdf")
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "还没有生成译文 PDF")
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", key+"-translated.pdf"))
	http.ServeFile(w, r, path)
}

func validateTranslatedPages(pages []translatedPDFPage) ([]translatedPDFPage, error) {
	if len(pages) == 0 {
		return nil, errors.New("pages 不能为空")
	}
	if len(pages) > maxTranslatedPDFPages {
		return nil, fmt.Errorf("一次最多处理 %d 页", maxTranslatedPDFPages)
	}
	sorted := append([]translatedPDFPage(nil), pages...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Page < sorted[j].Page })
	for index, page := range sorted {
		if page.Page != index+1 {
			return nil, fmt.Errorf("页码必须从 1 连续排列（第 %d 个是 %d）", index+1, page.Page)
		}
		if page.Width <= 0 || page.Height <= 0 {
			return nil, fmt.Errorf("第 %d 页尺寸无效", page.Page)
		}
	}
	return sorted, nil
}

// ocrRenderPages 对整份 PDF 跑 OCR，翻译正文块，返回可渲染的页。
func (s *Server) ocrRenderPages(ctx context.Context, key string, pdf []byte, sizes []ocr.Size) ([]render.Page, error) {
	client, err := s.ocrClient()
	if err != nil {
		return nil, err
	}
	ocrPages, err := client.Extract(ctx, pdf, key+".pdf", sizes)
	if err != nil {
		return nil, fmt.Errorf("OCR 失败: %w", err)
	}
	if len(ocrPages) != len(sizes) {
		return nil, fmt.Errorf("OCR 返回 %d 页，原 PDF 有 %d 页，无法可靠对齐页面", len(ocrPages), len(sizes))
	}
	// 与阅读器按页方案一致：按上游策略挑块、注入相邻上下文，再统一翻译。
	type pageItems struct {
		items  []translate.Item
		owners []int
	}
	perPage := make([]pageItems, len(ocrPages))
	texts := []string{}
	flatOwners := []struct{ page, item int }{}
	for pageIndex, page := range ocrPages {
		var before, after *ocr.Page
		if pageIndex > 0 {
			before = &ocrPages[pageIndex-1]
		}
		if pageIndex+1 < len(ocrPages) {
			after = &ocrPages[pageIndex+1]
		}
		items, owners, _ := pageTranslationItems(page, before, after)
		perPage[pageIndex] = pageItems{items: items, owners: owners}
		for itemIndex, item := range items {
			texts = append(texts, item.Source)
			flatOwners = append(flatOwners, struct{ page, item int }{pageIndex, itemIndex})
		}
	}
	if len(texts) == 0 {
		return nil, errors.New("OCR 没有识别出可翻译的正文块")
	}
	targets, err := s.translateOCRTexts(ctx, texts)
	if err != nil {
		return nil, err
	}
	out := make([]render.Page, 0, len(ocrPages))
	for _, page := range ocrPages {
		renderPage := render.Page{Index: page.Index, Width: page.Width, Height: page.Height}
		out = append(out, renderPage)
	}
	for index, owner := range flatOwners {
		if index >= len(targets) || strings.TrimSpace(targets[index]) == "" {
			continue
		}
		blockIndex := perPage[owner.page].owners[owner.item]
		block := ocrPages[owner.page].Blocks[blockIndex]
		role := roleForKind(block.Kind)
		out[owner.page].Blocks = append(out[owner.page].Blocks, render.Block{
			Text:     targets[index],
			Box:      block.Box,
			FontSize: estimateFontSize(block.Box, block.Kind),
			Role:     role,
		})
	}
	return out, nil
}

func (s *Server) translateOCRTexts(ctx context.Context, texts []string) ([]string, error) {
	config, err := s.aiConfig()
	if err != nil {
		return nil, err
	}
	if !config.Ready() {
		return nil, errors.New("还没配置 AI 助教的 API Key，无法翻译 OCR 文本")
	}
	items := make([]translate.Item, len(texts))
	for index, text := range texts {
		items[index] = translate.Item{Source: text}
	}
	budget := translate.Budget(len(items))
	translationCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	result, err := translate.Translate(translationCtx, ai.NewClient(config), items, translate.Options{
		BestEffort: true,
	})
	if err != nil {
		return nil, fmt.Errorf("翻译 OCR 文本失败: %w", err)
	}
	return result.Targets, nil
}

// estimateFontSize 从块框高度估字号：Paddle 只给块框，没有字号。
//
// 宁可估大一点：rpr 的 box_overlay 会按框自动缩小，估小了反而会让译文比原文明显偏小。
// 标题/小标题的字面高度占比高于正文，图注则常是多行，比例再低一些。
func estimateFontSize(box [4]float64, kind string) float64 {
	height := box[3] - box[1]
	ratio, maxSize := 0.72, 16.0
	switch kind {
	case "title":
		ratio, maxSize = 0.85, 32
	case "heading":
		ratio, maxSize = 0.78, 24
	case "figure_caption", "table_caption", "vision_footnote":
		ratio, maxSize = 0.62, 15
	}
	size := height * ratio
	if size > maxSize {
		size = maxSize
	}
	if size < 5 {
		size = 5
	}
	return size
}

func roleForKind(kind string) string {
	switch kind {
	case "title":
		return "title"
	case "heading":
		return "heading"
	case "abstract":
		return "abstract"
	case "toc":
		return "table_of_contents"
	case "figure_caption", "table_caption", "vision_footnote":
		return "caption"
	default:
		return "body"
	}
}

var (
	ocrAffiliationRE        = regexp.MustCompile(`(?i)\b(?:university|institute|department|laboratory|college|school of)\b`)
	ocrAuthorPairRE         = regexp.MustCompile(`\b[A-Z][a-z]+\s+[A-Z][a-z]+\b`)
	ocrReferenceRE          = regexp.MustCompile(`^\s*\[\d+\]`)
	ocrURLOnlyRE            = regexp.MustCompile(`(?i)^(?:https?://|www\.)\S+$`)
	ocrEmailOnlyRE          = regexp.MustCompile(`(?i)^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$`)
	ocrCopyrightRE          = regexp.MustCompile(`(?i)\b(copyright|trademarks?|all rights reserved|periodicals)\b`)
	ocrStandaloneRE         = regexp.MustCompile(`^(?:[0-9]+\.?|\([0-9]+(?:\.[0-9]+)*[a-z]?\)|\[[0-9]+\]|\([A-Za-z]\)|\((?:i{1,3}|iv|vi{0,3}|ix|x)\))$`)
	ocrListEnumRE           = regexp.MustCompile(`(?:^|\s)(?:\d{1,3}|[A-Z])[.)]\s+`)
	ocrListSuperscriptRE    = regexp.MustCompile(`\$\s*\^\s*\{?[\d,\-\s]+\}?\s*\$`)
	ocrListNameRE           = regexp.MustCompile(`\b[A-Z][a-zA-Z'\-]{2,}\b`)
	ocrContributorHeadingRE = regexp.MustCompile(`(?i)\b(data contributors?|contributors?|authors?|affiliations?|corresponding authors?|acknowledgements?)\b`)
	ocrHexByteRE            = regexp.MustCompile(`^[0-9A-Fa-f]{2}$`)
)

// keepOriginalOCRText 让作者行、单位、邮箱和参考文献保持原样。OCR 常把这些标成
// text；翻译后会变成拼音人名和中文期刊名，反而破坏版式信息。
func keepOriginalOCRText(text string, pageIndex int, y, pageHeight float64, isolated ...bool) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return true
	}
	isIsolated := len(isolated) == 0 || isolated[0]
	if keepOriginalByRetainPolicy(trimmed, isIsolated) {
		return true
	}
	if strings.Contains(trimmed, "@") || strings.Contains(strings.ToLower(trimmed), "doi.org") {
		return true
	}
	if pageIndex == 0 && pageHeight > 0 && y < pageHeight*0.3 {
		if ocrAffiliationRE.MatchString(trimmed) {
			return true
		}
		if len(ocrAuthorPairRE.FindAllString(trimmed, -1)) >= 2 {
			return true
		}
	}
	if ocrReferenceRE.MatchString(trimmed) {
		return true
	}
	lower := strings.ToLower(trimmed)
	return strings.HasPrefix(lower, "received ") ||
		strings.HasPrefix(lower, "accepted ") ||
		strings.HasPrefix(lower, "published ") ||
		strings.HasPrefix(lower, "doi:") ||
		strings.HasPrefix(lower, "arxiv")
}

// keepOriginalByRetainPolicy mirrors RetainPDF's default fast-path keep-origin
// rules for text blocks whose translation would damage structure or metadata.
func keepOriginalByRetainPolicy(text string, isolated bool) bool {
	compact := strings.Join(strings.Fields(text), " ")
	if compact == "" {
		return true
	}
	stripped := strings.Trim(compact, "()[]<>\"'“”‘’,;")
	if ocrURLOnlyRE.MatchString(stripped) || ocrEmailOnlyRE.MatchString(stripped) {
		return true
	}
	if isolated && (ocrStandaloneRE.MatchString(compact) || looksLikeOCRProtocolHexDump(compact) || looksLikeOCRSpecialLongList(compact)) {
		return true
	}
	if len([]rune(compact)) > 220 || len(continuationWordRE.FindAllString(compact, -1)) > 32 || !ocrCopyrightRE.MatchString(compact) {
		return false
	}
	lower := strings.ToLower(compact)
	if !strings.Contains(lower, "all rights reserved") && !strings.Contains(lower, "copyright") && !strings.Contains(lower, "trademark") && !strings.Contains(lower, "trademarks") && !strings.Contains(lower, "registered trademark") && !strings.Contains(lower, "registered and unregistered") && !strings.Contains(lower, "intellectual property rights") && !strings.Contains(lower, "key symbol") && !strings.Contains(lower, "periodicals") {
		return false
	}
	for _, marker := range []string{"redistribution of this document", "accepts no liability", "written permission", "this material is distributed", "advised to seek independent professional advice"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func looksLikeOCRProtocolHexDump(text string) bool {
	tokens := strings.Fields(strings.ReplaceAll(text, "\n", " "))
	if len(tokens) < 24 {
		return false
	}
	byteCount := 0
	for _, token := range tokens {
		if ocrHexByteRE.MatchString(token) {
			byteCount++
		}
	}
	ratio := float64(byteCount) / float64(len(tokens))
	return byteCount >= 32 && ratio >= 0.55 || byteCount >= 128 && ratio >= 0.35
}

func looksLikeOCRSpecialLongList(text string) bool {
	compact := strings.Join(strings.Fields(text), " ")
	if len([]rune(compact)) < 900 {
		return false
	}
	words := strings.Fields(compact)
	if len(words) < 130 {
		return false
	}
	commaDensity := float64(strings.Count(compact, ",")) / float64(len(words))
	numberedDensity := float64(len(ocrListEnumRE.FindAllString(compact, -1))) / float64(len(words))
	superscriptDensity := float64(len(ocrListSuperscriptRE.FindAllString(compact, -1))) / float64(len(words))
	nameLikeDensity := float64(len(ocrListNameRE.FindAllString(compact, -1))) / float64(len(words))
	runes := []rune(compact)
	if ocrContributorHeadingRE.MatchString(string(runes[:min(len(runes), 300)])) && (commaDensity >= 0.12 || superscriptDensity >= 0.08) {
		return true
	}
	return numberedDensity >= 0.12 || numberedDensity >= 0.06 && commaDensity >= 0.04 || superscriptDensity >= 0.14 && commaDensity >= 0.10 || commaDensity >= 0.28 && nameLikeDensity >= 0.50
}

// renderStatus 供前端在导出前判断运行环境。
func (s *Server) handleRenderStatus(w http.ResponseWriter, r *http.Request) {
	renderer := render.New(s.cfg.DataRoot)
	available := true
	message := ""
	if err := renderer.Available(); err != nil {
		available = false
		message = err.Error()
	}
	_, ocrErr := s.ocrClient()
	writeJSON(w, http.StatusOK, map[string]any{
		"available":     available,
		"error":         message,
		"ocrConfigured": ocrErr == nil,
		"ocrError":      errorString(ocrErr),
	})
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
