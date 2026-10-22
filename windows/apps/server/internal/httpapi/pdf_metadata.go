package httpapi

import (
	"cbctv2/server/internal/ai"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	publicationDOI   = regexp.MustCompile(`(?i)10\.\d{4,9}/[-._;()/:a-z0-9]+`)
	publicationArxiv = regexp.MustCompile(`(?i)(?:arxiv\s*:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]+/\d{7}(?:v\d+)?)`)
)

func identifyPDFMetadata(ctx context.Context, filename string, hint publicationMetadataHint) recognizedPaperMetadata {
	metadata := recognizedPaperMetadata{Title: strings.TrimSpace(hint.Title), Authors: []string{}}
	if !usablePDFTitle(metadata.Title, filename) {
		metadata.Title = ""
	}
	if author := strings.TrimSpace(hint.Author); author != "" {
		metadata.Authors = []string{author}
	}
	firstPage := hint.FirstPage
	doi := normalizePublicationDOI(hint.DOI)
	if doi == "" {
		if match := publicationDOI.FindString(firstPage); match != "" {
			doi = normalizePublicationDOI(match)
		}
	}
	if doi == "" {
		if match := publicationDOI.FindString(filename); match != "" {
			doi = normalizePublicationDOI(match)
		}
	}
	metadata.DOI = doi
	arxiv := strings.TrimSpace(hint.Arxiv)
	if arxiv == "" {
		if match := publicationArxiv.FindStringSubmatch(firstPage); len(match) > 1 {
			arxiv = match[1]
		}
	}
	arxiv = normalizeArxiv(arxiv)
	if arxiv == "" {
		if match := publicationArxiv.FindStringSubmatch(filename); len(match) > 1 {
			arxiv = match[1]
		}
	}
	query := doi
	if query == "" {
		query = arxiv
	}
	if query == "" {
		query = metadata.Title
	}
	lookupTitle := metadata.Title
	if lookupTitle == "" {
		lookupTitle = guessPDFTitle(firstPage)
		metadata.Title = lookupTitle
	}
	if query == "" {
		query = lookupTitle
	}
	if query == "" {
		return metadata
	}
	lookupCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	candidates, err := lookupPapers(lookupCtx, query)
	if err != nil || len(candidates) == 0 {
		return metadata
	}
	best, score := bestPaperCandidate(candidates, lookupTitle, doi, arxiv)
	if best == nil || (doi == "" && score < 0.65) {
		return metadata
	}
	if best.Title != "" {
		metadata.Title = best.Title
	}
	if len(best.Authors) > 0 {
		metadata.Authors = best.Authors
	}
	if best.DOI != "" {
		metadata.DOI = normalizePublicationDOI(best.DOI)
	}
	metadata.Venue = best.Venue
	metadata.Year = best.Year
	return metadata
}

func usablePDFTitle(title, filename string) bool {
	title = strings.TrimSpace(title)
	lower := strings.ToLower(title)
	base := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if len([]rune(title)) < 8 || titleSimilarity(title, base) > 0.9 {
		return false
	}
	for _, marker := range []string{"untitled", "microsoft word", "document", "scan.pdf", "acrobat"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func normalizePublicationDOI(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(value, "https://doi.org/"), "http://doi.org/"), "doi:")
	return strings.TrimRight(strings.TrimSpace(value), ".,;:)]}")
}

func guessPDFTitle(text string) string {
	best := ""
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		lower := strings.ToLower(line)
		length := len([]rune(line))
		if length < 15 || length > 240 || strings.Contains(lower, "abstract") || strings.Contains(lower, "arxiv:") || strings.Contains(lower, "doi:") || strings.Contains(lower, "http") {
			continue
		}
		if len(strings.Fields(line)) < 3 {
			continue
		}
		if len([]rune(line)) > len([]rune(best)) {
			best = line
		}
	}
	return best
}

func bestPaperCandidate(candidates []paperCandidate, title, doi, arxiv string) (*paperCandidate, float64) {
	var best *paperCandidate
	bestScore := 0.0
	for index := range candidates {
		candidate := &candidates[index]
		if doi != "" && normalizePublicationDOI(candidate.DOI) == doi {
			return candidate, 1
		}
		if arxiv != "" && normalizeArxiv(candidate.Arxiv) == arxiv {
			return candidate, 1
		}
		score := titleSimilarity(title, candidate.Title)
		if score > bestScore {
			best, bestScore = candidate, score
		}
	}
	if doi != "" && best == nil && len(candidates) == 1 {
		return &candidates[0], 1
	}
	return best, bestScore
}

func normalizeArxiv(value string) string {
	match := publicationArxiv.FindStringSubmatch(value)
	if len(match) > 1 {
		return strings.ToLower(match[1])
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func titleSimilarity(left, right string) float64 {
	leftWords := titleWords(left)
	rightWords := titleWords(right)
	if len(leftWords) == 0 || len(rightWords) == 0 {
		return 0
	}
	intersection := 0
	for word := range leftWords {
		if rightWords[word] {
			intersection++
		}
	}
	union := len(leftWords) + len(rightWords) - intersection
	if union == 0 {
		return 0
	}
	return float64(intersection) / float64(union)
}

var titleWordSplit = regexp.MustCompile(`[^\pL\pN]+`)

func titleWords(value string) map[string]bool {
	words := map[string]bool{}
	for _, word := range titleWordSplit.Split(strings.ToLower(value), -1) {
		if len([]rune(word)) > 1 {
			words[word] = true
		}
	}
	return words
}

func (s *Server) saveRecognizedPDFMetadata(ctx context.Context, id, filenameTitle string, metadata recognizedPaperMetadata) error {
	metadata.Title = normalizePaperTitle(metadata.Title)
	if metadata.Title == "" && len(metadata.Authors) == 0 && metadata.DOI == "" && metadata.Venue == "" && metadata.Year == 0 {
		return nil
	}
	authors, err := json.Marshal(metadata.Authors)
	if err != nil {
		return err
	}
	var year any
	if metadata.Year > 0 {
		year = metadata.Year
	}
	_, err = s.handle.ExecContext(ctx, `UPDATE documents SET
		title = CASE WHEN title = ? OR trim(title) = '' THEN COALESCE(NULLIF(?, ''), title) ELSE title END,
		authors = CASE WHEN authors IS NULL OR authors = '' OR authors = '[]' THEN ? ELSE authors END,
		doi = CASE WHEN doi IS NULL OR doi = '' THEN ? ELSE doi END,
		venue = CASE WHEN venue IS NULL OR venue = '' THEN ? ELSE venue END,
		year = CASE WHEN year IS NULL OR year <= 0 THEN ? ELSE year END,
        translated_title = COALESCE(NULLIF(?, ''), translated_title),
		updated_at = ? WHERE id = ?`,
		filenameTitle, metadata.Title, string(authors), metadata.DOI, metadata.Venue, year, metadata.TranslatedTitle, nowStamp(), id)
	return err
}

// Recognition finishes before importPublication creates a library entry.
func (s *Server) recognizePDFMetadata(ctx context.Context, filename string, hint publicationMetadataHint) (recognizedPaperMetadata, error) {
	if strings.TrimSpace(hint.FirstPage) == "" {
		// Legacy API clients without a text hint retain their existing import behavior.
		return identifyPDFMetadata(ctx, filename, hint), nil
	}
	config, err := s.aiConfig()
	if err != nil {
		return recognizedPaperMetadata{}, err
	}
	if !config.Ready() {
		return recognizedPaperMetadata{}, fmt.Errorf("请先在 AI 设置中配置模型，再识别论文题目、作者、期刊/会议、年份及中文题名")
	}
	recognitionCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	parsed, err := ai.ExtractPaperMetadata(recognitionCtx, ai.NewClient(config), string([]rune(hint.FirstPage)[:min(len([]rune(hint.FirstPage)), 20000)]), hint.Title)
	if err != nil {
		return recognizedPaperMetadata{}, fmt.Errorf("论文信息识别失败，尚未导入：%w", err)
	}
	recognized := recognizedPaperMetadata{Title: parsed.Title, TranslatedTitle: parsed.TranslatedTitle, Authors: parsed.Authors, Venue: parsed.Venue, Year: parsed.Year, DOI: normalizePublicationDOI(parsed.DOI)}
	// 调用方可能已经知道题录（每日推荐卡片带着 OpenAlex 的 DOI/作者）：模型没识别出来的字段用 hint 兜底，
	// 免得把已经确定的值写空——旧版链接导入是直接把卡片元数据写库的，这里不能比它更差。
	if recognized.DOI == "" {
		recognized.DOI = normalizePublicationDOI(hint.DOI)
	}
	if len(recognized.Authors) == 0 {
		if author := strings.TrimSpace(hint.Author); author != "" {
			recognized.Authors = []string{author}
		}
	}
	if !usablePDFTitle(recognized.Title, filename) {
		if title := strings.TrimSpace(hint.Title); title != "" {
			recognized.Title = title
		}
	}
	return recognized, nil
}

func fillMissingPaperMetadata(target *recognizedPaperMetadata, source recognizedPaperMetadata) {
	if strings.TrimSpace(target.Title) == "" {
		target.Title = source.Title
	}
	if strings.TrimSpace(target.TranslatedTitle) == "" {
		target.TranslatedTitle = source.TranslatedTitle
	}
	if len(target.Authors) == 0 {
		target.Authors = source.Authors
	}
	if strings.TrimSpace(target.DOI) == "" {
		target.DOI = normalizePublicationDOI(source.DOI)
	}
	if strings.TrimSpace(target.Venue) == "" {
		target.Venue = strings.TrimSpace(source.Venue)
	}
	if target.Year <= 0 && source.Year >= 1500 && source.Year <= 2100 {
		target.Year = source.Year
	}
}

// All PDF import paths reach this step after OCR, even when the title was
// supplied by a download card. Search records supply facts; the configured AI
// assistant identifies the matching paper before missing fields are filled.
func (s *Server) completeImportedPDFMetadata(ctx context.Context, filename string, metadata *recognizedPaperMetadata) error {
	firstPage := ""
	if len(metadata.Pages) > 0 {
		firstPage = metadata.Pages[0].Text
		text := []rune(firstPage)
		firstPage = string(text[:min(len(text), 20000)])
	}
	if firstPage != "" && (metadata.Title == "" || metadata.TranslatedTitle == "" || metadata.Venue == "" || metadata.Year <= 0 || metadata.DOI == "" || len(metadata.Authors) == 0) {
		hint := publicationMetadataHint{FirstPage: firstPage, Title: metadata.Title, DOI: metadata.DOI}
		if len(metadata.Authors) > 0 {
			hint.Author = metadata.Authors[0]
		}
		if recognized, err := s.recognizePDFMetadata(ctx, filename, hint); err == nil {
			fillMissingPaperMetadata(metadata, recognized)
		}
	}
	config, err := s.aiConfig()
	if err != nil {
		return err
	}
	if !config.Ready() {
		return fmt.Errorf("AI 助手尚未配置，无法联网核对题录")
	}
	searchCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	return completePaperMetadataFromSearch(searchCtx, ai.NewClient(config), metadata, firstPage, lookupPapers)
}

// Reimporting an existing PDF can repair its missing publication fields while
// reusing the saved source text and all previous OCR/translation results.
func (s *Server) completeExistingPDFMetadata(ctx context.Context, filename string, document DocumentSummary) (DocumentSummary, string, error) {
	if strings.TrimSpace(document.Venue) != "" && document.Year != nil && *document.Year > 0 {
		return document, "", nil
	}
	metadata := recognizedPaperMetadata{Title: document.Title, TranslatedTitle: document.TranslatedTitle, Authors: document.Authors, DOI: document.DOI, Venue: document.Venue}
	if document.Year != nil {
		metadata.Year = *document.Year
	}
	var firstPage string
	err := s.handle.QueryRowContext(ctx, `SELECT text FROM document_pages WHERE document_id=? ORDER BY page LIMIT 1`, document.ID).Scan(&firstPage)
	if err != nil && err != sql.ErrNoRows {
		return document, "", err
	}
	if firstPage != "" {
		metadata.Pages = []publicationPageHint{{Page: 1, Text: firstPage}}
	}
	warning := ""
	if err := s.completeImportedPDFMetadata(ctx, filename, &metadata); err != nil {
		warning = "出版信息联网核对未完成：" + err.Error() + "；已保留原文与已有题录"
	}
	if err := s.saveRecognizedPDFMetadata(ctx, document.ID, strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)), metadata); err != nil {
		return document, warning, err
	}
	updated, err := s.loadDocument(ctx, document.Key)
	return updated, warning, err
}

func completePaperMetadataFromSearch(ctx context.Context, client *ai.Client, metadata *recognizedPaperMetadata, firstPage string, lookup func(context.Context, string) ([]paperCandidate, error)) error {
	query := normalizePublicationDOI(metadata.DOI)
	if query == "" {
		query = strings.TrimSpace(metadata.Title)
	}
	if query == "" {
		return fmt.Errorf("未识别到可检索的论文标题或 DOI")
	}
	candidates, err := lookup(ctx, query)
	if (err != nil || len(candidates) == 0) && metadata.Title != "" && query != metadata.Title && ctx.Err() == nil {
		candidates, err = lookup(ctx, metadata.Title)
	}
	if err != nil {
		return fmt.Errorf("联网检索出版信息失败：%w", err)
	}
	if len(candidates) == 0 {
		return fmt.Errorf("联网未找到这篇论文的可核实题录")
	}
	known := ai.PaperMetadata{Title: metadata.Title, Authors: metadata.Authors, DOI: metadata.DOI, Venue: metadata.Venue, Year: metadata.Year}
	choices := make([]ai.PaperMetadata, len(candidates))
	for i, candidate := range candidates {
		choices[i] = ai.PaperMetadata{Title: candidate.Title, Authors: candidate.Authors, DOI: candidate.DOI, Venue: candidate.Venue, Year: candidate.Year}
	}
	index, err := ai.MatchPaperMetadata(ctx, client, known, firstPage, choices)
	if err != nil {
		return err
	}
	if index < 0 {
		return fmt.Errorf("AI 助手未能确认搜索结果与原文为同一篇论文")
	}
	match := candidates[index]
	knownDOI, matchDOI := normalizePublicationDOI(metadata.DOI), normalizePublicationDOI(match.DOI)
	if knownDOI != "" && matchDOI != "" {
		if !strings.EqualFold(knownDOI, matchDOI) {
			return fmt.Errorf("搜索结果的 DOI 与原文不一致，保留已有题录")
		}
	} else if titleSimilarity(metadata.Title, match.Title) < 0.65 {
		return fmt.Errorf("搜索结果与论文标题不符，保留已有题录")
	}
	fillMissingPaperMetadata(metadata, recognizedPaperMetadata{Title: match.Title, Authors: match.Authors, DOI: match.DOI, Venue: match.Venue, Year: match.Year})
	if strings.TrimSpace(metadata.Venue) == "" || metadata.Year <= 0 {
		return fmt.Errorf("已核对联网题录，但出版来源或年份仍未收录")
	}
	return nil
}
