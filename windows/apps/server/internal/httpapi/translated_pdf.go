// translated_pdf.go：用已保存的 OCR 版式和段落译文生成整本译文 PDF。
package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/render"
)

const (
	maxTranslatedPDFBody = 1 << 20
)

type translatedPDFRequest struct {
	PageCount int `json:"pageCount"`
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
			writeError(w, http.StatusRequestEntityTooLarge, "请求超过 1 MiB 上限")
			return
		}
		writeError(w, http.StatusBadRequest, "请求体必须包含 pageCount")
		return
	}
	if body.PageCount < 0 {
		writeError(w, http.StatusBadRequest, "pageCount 不能小于 0")
		return
	}
	paths := legacy.NewPaths(s.cfg.DataRoot)
	outputPath := filepath.Join(paths.LibraryDir(), key+"-translated.pdf")
	layout, hasLayout, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取 OCR 版式失败: "+err.Error())
		return
	}
	if !hasLayout || len(layout.Pages) == 0 {
		writeError(w, http.StatusConflict, "这篇论文尚无 RetainPDF 处理记录，请重新导入后再导出译文 PDF")
		return
	}
	if body.PageCount > 0 && body.PageCount != len(layout.Pages) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("请求页数 %d 与 RetainPDF 处理页数 %d 不一致", body.PageCount, len(layout.Pages)))
		return
	}
	info, err := os.Stat(outputPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusConflict, "RetainPDF 尚未生成译文 PDF，请重新导入论文")
		} else {
			writeError(w, http.StatusInternalServerError, "读取 RetainPDF 译文 PDF 失败: "+err.Error())
		}
		return
	}
	blockCount := 0
	for _, page := range layoutOCRPages(layout) {
		for _, block := range page.Blocks {
			if block.Translatable {
				blockCount++
			}
		}
	}
	writeJSON(w, http.StatusOK, translatedPDFResponse{
		Key:      key,
		Pages:    len(layout.Pages),
		Blocks:   blockCount,
		Skipped:  0,
		Bytes:    info.Size(),
		Download: "/v1/documents/" + key + "/translated-pdf",
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
	err := renderer.Available()
	available := err == nil
	message := errorString(err)
	ocrConfig, ocrErr := s.loadOCRConfig()
	if ocrErr == nil && strings.TrimSpace(ocrConfig.Token) == "" {
		ocrErr = errors.New("OCR 令牌尚未配置")
	}
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
