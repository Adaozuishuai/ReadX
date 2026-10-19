package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
)

var formulaPlaceholderRE = regexp.MustCompile(`<([ft])\d+-[0-9a-z]{3}/>`)

type formulaTextSegment struct {
	ID     string `json:"segment_id"`
	Source string `json:"source_text"`
}

type formulaSegmentReply struct {
	Segments []struct {
		ID   string `json:"segment_id"`
		Text string `json:"translated_text"`
	} `json:"segments"`
}

type formulaSkeletonPart struct {
	segmentID string
	text      string
	isSegment bool
}

// translateFormulaSegments mirrors LeePDF's risk-gated direct_typst
// segmentation route. Formula and matched-term placeholders stay in the
// skeleton; only the prose spans between them are sent for translation.
func translateFormulaSegments(ctx context.Context, generator Generator, item Item, options Options) (string, bool, error) {
	if itemMathMode(item) == "direct_typst" {
		return "", false, nil
	}
	if strings.TrimSpace(item.ContinuationGroup) != "" {
		return "", false, nil
	}
	protected, tokens := ProtectWithFormulas(item.Source, item.FormulaTexts)
	protected, tokens = protectTerms(protected, tokens, item.Terms)
	plans, skeleton := planFormulaSegments(protected)
	if len(plans) == 0 {
		return "", false, nil
	}
	placeholderCount := len(formulaPlaceholderRE.FindAllStringIndex(protected, -1))
	if placeholderCount < 4 || placeholderCount >= 24 || len(effectiveFormulaSegments(plans)) > 16 {
		return "", false, nil
	}
	if len(effectiveFormulaSegments(plans)) >= 5 && len([]rune(stripFormulaPlaceholders(protected))) >= 180 {
		return "", false, nil
	}
	if formulaRiskScore(protected, skeleton, plans) < 6 {
		return "", false, nil
	}

	payload := struct {
		ItemID    string               `json:"item_id"`
		Count     int                  `json:"segment_count"`
		Structure []string             `json:"segment_structure"`
		Segments  []formulaTextSegment `json:"segments"`
		Before    string               `json:"context_before,omitempty"`
		After     string               `json:"context_after,omitempty"`
	}{ItemID: item.ItemID, Count: len(plans), Segments: plans}
	payload.Structure = make([]string, 0, len(skeleton))
	for _, part := range skeleton {
		if part.isSegment {
			payload.Structure = append(payload.Structure, "segment:"+part.segmentID)
		} else if formulaPlaceholderRE.MatchString(part.text) {
			payload.Structure = append(payload.Structure, "formula")
		} else if strings.TrimSpace(part.text) != "" {
			payload.Structure = append(payload.Structure, "literal:"+strings.Join(strings.Fields(part.text), " "))
		}
	}
	if options.ContextMode != "off" {
		payload.Before = formulaSegmentContext(item.ContextBefore)
		payload.After = formulaSegmentContext(item.ContextAfter)
	}
	userBytes, err := json.Marshal(payload)
	if err != nil {
		return "", true, err
	}
	system := formulaSegmentSystemPrompt()
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if err := ctx.Err(); err != nil {
			return "", true, err
		}
		var raw string
		if timed, ok := generator.(timeoutGenerator); ok {
			raw, err = timed.GenerateWithTimeout(ctx, system, string(userBytes), translationTemp, 120*time.Second)
		} else {
			raw, err = generator.Generate(ctx, system, string(userBytes), translationTemp)
		}
		if err != nil {
			lastErr = err
			continue
		}
		translated, parseErr := parseFormulaSegmentReply(raw, plans)
		if parseErr != nil {
			lastErr = parseErr
			continue
		}
		var rebuilt strings.Builder
		for _, part := range skeleton {
			if part.isSegment {
				rebuilt.WriteString(translated[part.segmentID])
			} else {
				rebuilt.WriteString(part.text)
			}
		}
		result, missing, unexpected := Restore(rebuilt.String(), tokens)
		if len(missing) > 0 || len(unexpected) > 0 {
			lastErr = fmt.Errorf("分段公式占位符恢复失败")
			continue
		}
		issues := Review(item.Source, item.Source, result, nil, item)
		if hasError(issues) {
			lastErr = fmt.Errorf("分段公式译文未通过质量检查")
			continue
		}
		return strings.TrimSpace(result), true, nil
	}
	return "", true, lastErr
}

func translateHeavyFormula(ctx context.Context, generator Generator, item Item, options Options) (string, bool, []Issue, error) {
	if itemMathMode(item) == "direct_typst" || item.HeavyFormulaSplitApplied || strings.TrimSpace(item.ContinuationGroup) != "" {
		return "", false, nil, nil
	}
	protected, tokens := ProtectWithFormulas(item.Source, item.FormulaTexts)
	protected, tokens = protectTerms(protected, tokens, item.Terms)
	placeholderCount := len(formulaPlaceholderRE.FindAllStringIndex(protected, -1))
	if placeholderCount < 16 || (len([]rune(protected)) < 1200 && placeholderCount < 24) || (placeholderCount < 24 && float64(placeholderCount)/float64(maxInt(1, len([]rune(protected)))) < 0.016) {
		return "", false, nil, nil
	}
	chunks := splitHeavyFormulaSource(item.Source, item.FormulaTexts, item.Terms)
	if len(chunks) <= 1 {
		return "", false, nil, nil
	}
	translated := make([]string, len(chunks))
	for index, chunk := range chunks {
		chunkItem := item
		chunkItem.Source = chunk
		chunkItem.HeavyFormulaSplitApplied = true
		chunkItem.FormulaTexts = formulasInSource(item.FormulaTexts, chunk)
		chunkItem.ContextBefore = item.ContextBefore
		chunkItem.ContextAfter = item.ContextAfter
		if index > 0 {
			chunkItem.ContextBefore = chunks[index-1]
		}
		if index+1 < len(chunks) {
			chunkItem.ContextAfter = chunks[index+1]
		}
		result, err := Translate(ctx, generator, []Item{chunkItem}, Options{ContextMode: options.ContextMode, BestEffort: true, RepairRounds: options.RepairRounds})
		if err != nil {
			return "", true, nil, err
		}
		if len(result.Targets) == 0 || strings.TrimSpace(result.Targets[0]) == "" {
			return "", true, []Issue{{Kind: "formula_chunk_failed", Severity: severityError, Message: fmt.Sprintf("公式密集段落第 %d/%d 个分块翻译失败", index+1, len(chunks)), Retryable: true}}, nil
		}
		translated[index] = strings.TrimSpace(result.Targets[0])
	}
	joined := strings.TrimSpace(strings.Join(translated, " "))
	return joined, true, Review(item.Source, item.Source, joined, nil, item), nil
}

func splitHeavyFormulaSource(source string, formulas []string, terms []Term) []string {
	sentences := splitFormulaSentences(source)
	if len(sentences) <= 1 {
		words := regexp.MustCompile(`\$\$.*?\$\$|\$(?:\\.|[^$\\])*?\$|\S+`).FindAllString(source, -1)
		if len(words) > 40 {
			sentences = make([]string, 0, (len(words)+39)/40)
			for start := 0; start < len(words); start += 40 {
				end := min(start+40, len(words))
				sentences = append(sentences, strings.Join(words[start:end], " "))
			}
		}
	}
	if len(sentences) <= 1 {
		return nil
	}
	chunks := []string{}
	current := []string{}
	currentPlaceholders, currentChars := 0, 0
	for _, sentence := range sentences {
		protected, tokenList := ProtectWithFormulas(sentence, formulasInSource(formulas, sentence))
		protected, tokenList = protectTerms(protected, tokenList, terms)
		count := len(formulaPlaceholderRE.FindAllStringIndex(protected, -1))
		chars := len([]rune(sentence))
		if len(current) > 0 && (currentPlaceholders+count > 8 || currentChars+chars > 900) {
			chunks = append(chunks, strings.TrimSpace(strings.Join(current, " ")))
			current, currentPlaceholders, currentChars = nil, 0, 0
		}
		current = append(current, sentence)
		currentPlaceholders += count
		currentChars += chars
	}
	if len(current) > 0 {
		chunks = append(chunks, strings.TrimSpace(strings.Join(current, " ")))
	}
	return chunks
}

func splitFormulaSentences(source string) []string {
	pattern := regexp.MustCompile(`([.!?;:])\s+`)
	matches := pattern.FindAllStringSubmatchIndex(source, -1)
	if len(matches) == 0 {
		return []string{strings.TrimSpace(source)}
	}
	parts := []string{}
	start := 0
	for _, match := range matches {
		punctuationEnd := match[3]
		part := strings.TrimSpace(source[start:punctuationEnd])
		if part != "" {
			parts = append(parts, part)
		}
		start = match[1]
	}
	if tail := strings.TrimSpace(source[start:]); tail != "" {
		parts = append(parts, tail)
	}
	return parts
}

func formulasInSource(formulas []string, source string) []string {
	out := make([]string, 0, len(formulas))
	for _, formula := range formulas {
		if strings.Contains(source, strings.TrimSpace(formula)) {
			out = append(out, formula)
		}
	}
	return out
}

func itemMathMode(item Item) string {
	mode := strings.ToLower(strings.TrimSpace(item.MathMode))
	if mode == "" {
		return "direct_typst"
	}
	return mode
}

func planFormulaSegments(source string) ([]formulaTextSegment, []formulaSkeletonPart) {
	plans := []formulaTextSegment{}
	skeleton := []formulaSkeletonPart{}
	cursor := 0
	for _, match := range formulaPlaceholderRE.FindAllStringIndex(source, -1) {
		appendFormulaTextSpan(&plans, &skeleton, source[cursor:match[0]])
		skeleton = append(skeleton, formulaSkeletonPart{text: source[match[0]:match[1]]})
		cursor = match[1]
	}
	appendFormulaTextSpan(&plans, &skeleton, source[cursor:])
	return plans, skeleton
}

func appendFormulaTextSpan(plans *[]formulaTextSegment, skeleton *[]formulaSkeletonPart, text string) {
	if text == "" {
		return
	}
	if !containsLetter(text) {
		*skeleton = append(*skeleton, formulaSkeletonPart{text: text})
		return
	}
	id := fmt.Sprintf("%d", len(*plans)+1)
	*plans = append(*plans, formulaTextSegment{ID: id, Source: strings.TrimSpace(text)})
	*skeleton = append(*skeleton, formulaSkeletonPart{segmentID: id, isSegment: true})
}

func effectiveFormulaSegments(segments []formulaTextSegment) []formulaTextSegment {
	meaningful := make([]formulaTextSegment, 0, len(segments))
	for _, segment := range segments {
		if !isMicroFormulaSegment(segment.Source) {
			meaningful = append(meaningful, segment)
		}
	}
	if len(meaningful) == 0 {
		return segments
	}
	return meaningful
}

func isMicroFormulaSegment(text string) bool {
	text = strings.ToLower(strings.Join(strings.Fields(text), " "))
	words := regexp.MustCompile(`[a-z]+(?:[-'][a-z]+)?`).FindAllString(text, -1)
	if len(words) == 0 {
		return true
	}
	connectors := map[string]bool{"a": true, "an": true, "and": true, "as": true, "at": true, "also": true, "be": true, "been": true, "being": true, "but": true, "by": true, "can": true, "could": true, "does": true, "for": true, "from": true, "has": true, "have": true, "if": true, "in": true, "into": true, "is": true, "it": true, "its": true, "may": true, "might": true, "of": true, "on": true, "or": true, "per": true, "should": true, "that": true, "the": true, "their": true, "then": true, "these": true, "this": true, "those": true, "to": true, "via": true, "vs": true, "was": true, "were": true, "with": true, "which": true, "while": true, "will": true}
	allConnectors := true
	for _, word := range words {
		if !connectors[word] {
			allConnectors = false
			break
		}
	}
	if len(words) <= 2 && len([]rune(text)) <= 20 && allConnectors {
		return true
	}
	if len(words) <= 3 && len([]rune(text)) <= 24 && (connectors[words[0]] || connectors[words[len(words)-1]]) {
		return true
	}
	return len(words) <= 4 && allConnectors
}

func formulaRiskScore(source string, skeleton []formulaSkeletonPart, segments []formulaTextSegment) int {
	lowered := strings.ToLower(strings.Join(strings.Fields(stripFormulaPlaceholders(source)), " "))
	phrases := []string{"abbreviated as", "defined as", "denoted as", "is defined as", "can be defined as", "where ", "represented by", "expressed as", "written as", "calculated as", "corresponds to", "refers to", "stands for"}
	score := 0
	for _, phrase := range phrases {
		if strings.Contains(lowered, phrase) {
			score += 3
			break
		}
	}
	shortSegments, microSegments := 0, 0
	for _, segment := range segments {
		runes := len([]rune(strings.TrimSpace(segment.Source)))
		if runes > 0 && runes <= 32 {
			shortSegments++
		}
		if isMicroFormulaSegment(segment.Source) {
			microSegments++
		}
	}
	if shortSegments > 0 {
		score++
	}
	placeholders := len(formulaPlaceholderRE.FindAllStringIndex(source, -1))
	if placeholders >= 4 {
		score += 2
	}
	if placeholders >= 8 {
		score += 2
	}
	proseChars := len([]rune(stripFormulaPlaceholders(source)))
	if proseChars >= 180 {
		score++
	}
	if float64(placeholders)/float64(maxInt(1, len([]rune(source)))) >= 0.015 {
		score++
	}
	if float64(placeholders)/float64(maxInt(1, len([]rune(source)))) >= 0.03 {
		score++
	}
	if microSegments >= maxInt(2, len(segments)-1) {
		score -= 2
	} else if microSegments > 0 {
		score--
	}
	if len(segments) >= 3 {
		score++
	}
	placeholderIndexes := []int{}
	for index, part := range skeleton {
		if !part.isSegment && formulaPlaceholderRE.MatchString(part.text) {
			placeholderIndexes = append(placeholderIndexes, index)
		}
	}
	if len(placeholderIndexes) > 0 {
		if placeholderIndexes[0] <= 1 {
			score++
		}
		if placeholderIndexes[len(placeholderIndexes)-1] < len(skeleton)-1 {
			score++
		}
	}
	if strings.Contains(source, ")") && (strings.Contains(lowered, "abbreviated as") || strings.Contains(lowered, "stands for") || strings.Contains(lowered, "denoted as")) {
		score++
	}
	return score
}

func stripFormulaPlaceholders(text string) string {
	return formulaPlaceholderRE.ReplaceAllString(text, "")
}

func formulaSegmentContext(text string) string {
	text = strings.Join(strings.Fields(stripFormulaPlaceholders(text)), " ")
	if len([]rune(text)) <= 280 {
		return text
	}
	runes := []rune(text)
	return strings.TrimSpace(string(runes[:279])) + "…"
}

func parseFormulaSegmentReply(raw string, plans []formulaTextSegment) (map[string]string, error) {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "```") {
		if newline := strings.IndexByte(text, '\n'); newline >= 0 {
			text = strings.TrimSuffix(strings.TrimSpace(text[newline+1:]), "```")
		}
	}
	var reply formulaSegmentReply
	if err := json.Unmarshal([]byte(text), &reply); err != nil {
		return nil, fmt.Errorf("公式分段 JSON 无效: %w", err)
	}
	if len(reply.Segments) != len(plans) {
		return nil, fmt.Errorf("公式分段数量不匹配")
	}
	out := make(map[string]string, len(plans))
	for _, segment := range reply.Segments {
		if _, exists := out[segment.ID]; exists {
			return nil, fmt.Errorf("公式分段 ID 重复")
		}
		if strings.TrimSpace(segment.Text) == "" {
			return nil, fmt.Errorf("公式分段译文为空")
		}
		out[segment.ID] = strings.TrimSpace(segment.Text)
	}
	for _, plan := range plans {
		if _, ok := out[plan.ID]; !ok {
			return nil, fmt.Errorf("缺少公式分段 %s", plan.ID)
		}
	}
	return out, nil
}

func formulaSegmentSystemPrompt() string {
	return "你在翻译从同一个科技 OCR 条目里切出来的固定文本段。\n每一段都是夹在受保护公式或字面记号之间的自然语言跨度。\n那些受保护的公式和字面量没有出现在请求里，翻译完成后由程序自动插回。\n你不是把整个条目当成一句话翻译。你要逐段独立翻译，并保持原有的段序。\n使用适合科技写作的、凝练的出版体简体中文。\n缩写、符号和标准模型名保持其通行的技术写法。\n如果某一段只是连接词或不完整的短语，中文也要同样简短、同样不完整。\n不要从相邻段落借内容来补全被截断的语法。\n不要输出任何公式占位符、公式标记、拼回的整条文本、评论、markdown 或代码块围栏。\n只返回符合 {\"segments\":[{\"segment_id\":\"1\",\"translated_text\":\"...\"}]} 的 JSON。\n硬性规则：每个请求中的 segment_id 必须且只能出现一次；不要合并、拆分、遗漏、重新编号、调序或新增段；不要以任何形式把隐藏的公式抄回输出。"
}

func containsLetter(text string) bool {
	for _, r := range text {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}
