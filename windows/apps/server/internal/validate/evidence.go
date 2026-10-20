// Package validate 是 evidence-first 校验链的 Go 移植。
//
// 移植纪律：windows/src/core 里每一个「刻意不做 X」的注释都是硬约束，这里逐条对应；
// 迁移判定由 parity_test.go 中的独立固定样本守护，无需旧版运行时。
package validate

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Page 与 TS 的 EvidencePage 对应。
type Page struct {
	Number int
	Text   string
}

// Field 与 TS 的 ExperimentField 对应：四键齐全，page/excerpt 可为 null。
type Field struct {
	K       string  `json:"k"`
	V       string  `json:"v"`
	Page    *int    `json:"page"`
	Excerpt *string `json:"excerpt"`
}

// ExperimentExtraction 与 TS 同名接口对应。
type ExperimentExtraction struct {
	Dataset     []Field `json:"dataset"`
	Acquisition []Field `json:"acquisition"`
	Training    []Field `json:"training"`
	Loss        []Field `json:"loss"`
	Metrics     []Field `json:"metrics"`
	Results     []Field `json:"results"`
	Baselines   []Field `json:"baselines"`
}

var pageMarker = regexp.MustCompile(`=== Page ([0-9]+) ===`)

// Pages 与 TS pages() 一致：按标记切页，标记前内容丢弃。
func Pages(text string) []Page {
	matches := pageMarker.FindAllStringSubmatchIndex(text, -1)
	out := make([]Page, 0, len(matches))
	for index, match := range matches {
		number := atoi(text[match[2]:match[3]])
		start := match[1]
		end := len(text)
		if index+1 < len(matches) {
			end = matches[index+1][0]
		}
		out = append(out, Page{Number: number, Text: text[start:end]})
	}
	return out
}

// whitespace 覆盖 JS 的 \s（含 U+00A0 / U+3000 等 Unicode 空白）；Go 的 \s 只认 ASCII。
var whitespace = regexp.MustCompile(`[\t\n\v\f\r\x{0085}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000} ]+`)

// Normalized 与 TS normalized() 一致：NFKC → 小写 → 去跨行断词连字符 → −→- →
// 去单词中间连字符 → 去所有空白。用于「摘录是否真的出现在该页」。
func Normalized(text string) string {
	s := strings.ToLower(norm.NFKC.String(text))
	s = stripLineHyphens(s)
	s = strings.ReplaceAll(s, "−", "-")
	s = stripInnerHyphens(s)
	return whitespace.ReplaceAllString(s, "")
}

// stripLineHyphens 对应 TS 的 (?<=\p{L})-[ \t]*\n[ \t]*(?=\p{L})：
// Go 的 RE2 没有后行断言，这里手工扫——字母后的连字符 + 空白 + 换行 + 空白 + 字母。
func stripLineHyphens(s string) string {
	runes := []rune(s)
	var out []rune
	for i := 0; i < len(runes); i++ {
		if runes[i] == '-' && i > 0 && unicode.IsLetter(runes[i-1]) {
			j := i + 1
			for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
				j++
			}
			if j < len(runes) && runes[j] == '\n' {
				j++
				for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
					j++
				}
				if j < len(runes) && unicode.IsLetter(runes[j]) {
					i = j - 1 // 吃掉连字符与中间空白
					continue
				}
			}
		}
		out = append(out, runes[i])
	}
	return string(out)
}

// stripInnerHyphens 对应 TS 的 (?<=\p{L}{2})-(?=\p{L}{2})：前后各两个字母的连字符去掉。
func stripInnerHyphens(s string) string {
	runes := []rune(s)
	var out []rune
	for i := 0; i < len(runes); i++ {
		if runes[i] == '-' && i >= 2 && i+2 < len(runes) &&
			unicode.IsLetter(runes[i-1]) && unicode.IsLetter(runes[i-2]) &&
			unicode.IsLetter(runes[i+1]) && unicode.IsLetter(runes[i+2]) {
			continue
		}
		out = append(out, runes[i])
	}
	return string(out)
}

var spelled = map[string]string{
	"zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
	"six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "single": "1",
}

var spelledPatterns = func() map[string]*regexp.Regexp {
	out := map[string]*regexp.Regexp{}
	for word := range spelled {
		out[word] = regexp.MustCompile(`\b` + word + `\b`)
	}
	return out
}()

var numberPattern = regexp.MustCompile(`[+-]?(?:[0-9]*\.[0-9]+|[0-9]+)`)
var signSpace = regexp.MustCompile(`([+\-])[ \t]+([0-9.])`)

// Numbers 与 TS numbers() 一致：只排除**完全嵌在单词中间**的数字。
// 方法名 IntraTomo3D 的 3 必须排除（否则伪造值可借方法名通过），
// 而 RTX3090 / 1.2GB 这类贴边型号数字必须保留。
func Numbers(text string) map[string]bool {
	s := strings.ToLower(norm.NFKC.String(text))
	s = strings.ReplaceAll(s, "−", "-")
	s = strings.ReplaceAll(s, "–", "-")
	s = signSpace.ReplaceAllString(s, "$1$2")
	for word, pattern := range spelledPatterns {
		s = pattern.ReplaceAllString(s, spelled[word])
	}
	out := map[string]bool{}
	runes := []rune(s)
	byteToRune := make([]int, len(s)+1)
	ri := 0
	for bi := range s {
		byteToRune[bi] = ri
		ri++
	}
	byteToRune[len(s)] = ri

	for _, match := range numberPattern.FindAllStringIndex(s, -1) {
		startRune := byteToRune[match[0]]
		endRune := byteToRune[match[1]]
		prevIsLetter := startRune > 0 && unicode.IsLetter(runes[startRune-1])
		nextIsLetter := endRune < len(runes) && unicode.IsLetter(runes[endRune])
		if prevIsLetter && nextIsLetter {
			continue
		}
		out[s[match[0]:match[1]]] = true
	}
	return out
}

var citationMarker = regexp.MustCompile(`\[\d{1,4}\]`)

// declaredUnknownPattern 与 TS 一致：否定陈述且不含数字才放行无摘录字段。
var declaredUnknownPattern = regexp.MustCompile(`^(?:论文|原文|文中)?[^。；;]*未(?:报告|说明|提及|找到|发现|提供|进行)`)

// UnknownValues 与 TS UNKNOWN_VALUES 全表一致。
var UnknownValues = map[string]bool{
	"当前文本无法核实": true,
	"论文未说明":    true, "论文中未说明": true, "论文中未找到": true, "未报告": true,
	"论文未报告": true, "论文未提及": true, "未提及": true, "原文未说明": true,
	"文中未提及": true, "论文中没有说明": true,
}

// ValidationError 携带结构化问题列表，供上层（四层兜底）逐条处理而不是只拿一句字符串。
type ValidationError struct {
	Message  string
	Problems []string
}

func (e *ValidationError) Error() string { return e.Message }

// GroupsOf 与 TS groupsOf 一致：七个分组的顺序影响诊断顺序，不能调。
func GroupsOf(x ExperimentExtraction) []struct {
	ID     string
	Label  string
	Fields []Field
} {
	return []struct {
		ID     string
		Label  string
		Fields []Field
	}{
		{"dataset", "研究对象与数据", x.Dataset},
		{"acquisition", "研究设计与条件", x.Acquisition},
		{"training", "实施流程", x.Training},
		{"loss", "分析方法", x.Loss},
		{"baselines", "对照或基线", x.Baselines},
		{"metrics", "评价标准", x.Metrics},
		{"results", "结果", x.Results},
	}
}

// ValidateExtraction 与 TS validateExtraction 逐条对应。
func ValidateExtraction(x ExperimentExtraction, source string) error {
	byPage := map[int]string{}
	for _, p := range Pages(source) {
		byPage[p.Number] = p.Text
	}

	var fields []Field
	for _, group := range GroupsOf(x) {
		fields = append(fields, group.Fields...)
	}
	if len(fields) == 0 {
		return &ValidationError{Message: "实验抽取没有返回字段，请重试。"}
	}

	problems := []string{}
	for _, field := range fields {
		if isDeclaredUnknown(field) {
			continue
		}
		var pageText string
		pageOK := false
		if field.Page != nil {
			pageText, pageOK = byPage[*field.Page]
		}
		quote := ""
		if field.Excerpt != nil {
			quote = *field.Excerpt
		}
		ok := field.Page != nil && pageOK && quote != "" &&
			len([]rune(Normalized(quote))) >= 8 && strings.Contains(Normalized(pageText), Normalized(quote))
		if !ok {
			label := strings.TrimSpace(field.K)
			if label == "" {
				label = "(该条目缺少 k 字段：每项必须是 {\"k\",\"v\",\"page\",\"excerpt\"} 四键齐全的对象)"
			}
			diagnostic := fmt.Sprintf("「%s」缺少对应页的逐字摘录；引用单页不可拼接跨页文字", label)
			if field.Page != nil && pageOK && quote != "" {
				if fragment := MatchingQuoteFragment(quote, pageText); fragment != "" {
					diagnostic += fmt.Sprintf("。Page %d 内可匹配的原文片段：%s；仅用本页片段支持的事实重新填写 v/excerpt，不能沿用片段未支持的数字或其他事实", *field.Page, fragment)
				}
			}
			problems = append(problems, diagnostic)
			continue
		}
		vNumbers := Numbers(citationMarker.ReplaceAllString(field.V, " "))
		quoteNumbers := Numbers(quote)
		unsupported := []string{}
		for n := range vNumbers {
			if !quoteNumbers[n] {
				unsupported = append(unsupported, n)
			}
		}
		if len(unsupported) > 0 {
			sort.Strings(unsupported)
			shown := field.V
			if len([]rune(shown)) > 100 {
				shown = string([]rune(shown)[:100])
			}
			problems = append(problems, fmt.Sprintf("「%s：%s」的数字 %s 未被所附摘录支持", field.K, shown, strings.Join(unsupported, ", ")))
		}
	}
	if len(problems) > 0 {
		return &ValidationError{Message: "证据校验未通过，未保存：" + strings.Join(problems, "；"), Problems: problems}
	}
	return nil
}

func isDeclaredUnknown(field Field) bool {
	if field.Page != nil || field.Excerpt != nil {
		return false
	}
	if UnknownValues[field.V] {
		return true
	}
	return declaredUnknownPattern.MatchString(field.V) && len(Numbers(field.V)) == 0
}

// ValidateConfiguration 与 TS validateConfiguration 一致：配置章只放配置。
func ValidateConfiguration(x ExperimentExtraction) error {
	problems := []string{}
	if len(x.Results) > 0 {
		problems = append(problems, "实验配置不能混入结果数值，results 应为空数组。")
	}
	trainingTime := regexp.MustCompile(`(?:训练.*(?:时长|耗时|时间))|(?:training.*(?:time|duration))`)
	for _, field := range x.Training {
		if trainingTime.MatchString(field.K) {
			quote := ""
			if field.Excerpt != nil {
				quote = *field.Excerpt
			}
			reconstruct := regexp.MustCompile(`(?i)reconstruct`)
			trainLike := regexp.MustCompile(`(?i)(?:train|optimi|updat)`)
			if reconstruct.MatchString(quote) && !trainLike.MatchString(quote) {
				problems = append(problems, fmt.Sprintf("「%s」的原文只报告重建耗时，不能标为训练时长；放在对应结果图的解读中。", field.K))
			}
		}
	}
	equationLike := regexp.MustCompile(`(?i)(?:公式|equation|formula)`)
	for _, field := range x.Loss {
		if equationLike.MatchString(field.K) {
			problems = append(problems, fmt.Sprintf("「%s」应在方法对应模块中介绍，本章仅列损失类型与权重。", field.K))
		}
	}
	if len(problems) > 0 {
		return &ValidationError{Message: strings.Join(problems, "；"), Problems: problems}
	}
	return nil
}

var citationPattern = regexp.MustCompile(`(?i)Page\s+([0-9]+)`)

// Citations 与 TS citations() 一致。
func Citations(text string) []int {
	seen := map[int]bool{}
	for _, match := range citationPattern.FindAllStringSubmatch(text, -1) {
		seen[atoi(match[1])] = true
	}
	out := make([]int, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

// ValidateEvidence 与 TS validateEvidence 一致：输出必须引用真实存在的页码。
func ValidateEvidence(output, source string) error {
	refs := Citations(output)
	available := map[int]bool{}
	for _, p := range Pages(source) {
		available[p.Number] = true
	}
	if len(refs) == 0 {
		return &ValidationError{Message: "输出缺少有效证据页码，未保存。请重试或核对原文。"}
	}
	for _, ref := range refs {
		if !available[ref] {
			return &ValidationError{Message: "输出缺少有效证据页码，未保存。请重试或核对原文。"}
		}
	}
	return nil
}

// MatchingQuoteFragment 与 TS matchingQuoteFragment 一致：诊断用，找本页可匹配片段。
func MatchingQuoteFragment(quote, inText string) string {
	needle := Normalized(quote)
	haystack := Normalized(inText)
	needleRunes := []rune(needle)
	if len(needleRunes) < 8 {
		return ""
	}
	for size := min(len(needleRunes), 700); size >= 8; size-- {
		for _, frag := range []string{string(needleRunes[:size]), string(needleRunes[len(needleRunes)-size:])} {
			if strings.Contains(haystack, frag) {
				if r := quoteSpan(frag, inText); r != nil {
					return inText[r.Start:r.End]
				}
			}
		}
	}
	return ""
}

// QuoteRange 与 TS quoteRange() 一致：把归一化匹配映射回原文区间（高亮用）。
type QuoteRange struct {
	Start int
	End   int
}

func quoteSpan(quote, inText string) *QuoteRange {
	needle := Normalized(quote)
	if len([]rune(needle)) < 8 {
		return nil
	}

	hyphenPositions := lineHyphenBytePositions(inText)

	type charEntry struct {
		ch    rune
		start int
		end   int
	}
	var chars []charEntry
	byteIndex := 0
	for _, ch := range inText {
		length := len(string(ch))
		if !hyphenPositions[byteIndex] {
			for _, c := range strings.ReplaceAll(strings.ToLower(norm.NFKC.String(string(ch))), "−", "-") {
				if !unicode.IsSpace(c) {
					chars = append(chars, charEntry{ch: c, start: byteIndex, end: byteIndex + length})
				}
			}
		}
		byteIndex += length
	}

	keep := []int{}
	for k, entry := range chars {
		insideWord := entry.ch == '-' && k >= 2 && k+2 < len(chars) &&
			unicode.IsLetter(chars[k-1].ch) && unicode.IsLetter(chars[k-2].ch) &&
			unicode.IsLetter(chars[k+1].ch) && unicode.IsLetter(chars[k+2].ch)
		if !insideWord {
			keep = append(keep, k)
		}
	}

	canonical := strings.Builder{}
	for _, k := range keep {
		canonical.WriteRune(chars[k].ch)
	}
	position := strings.Index(canonical.String(), needle)
	if position < 0 {
		return nil
	}
	startRange := chars[keep[position]]
	endRange := chars[keep[position+len([]rune(needle))-1]]
	return &QuoteRange{Start: startRange.start, End: endRange.end}
}

// lineHyphenBytePositions 标记「字母-空白换行空白-字母」里连字符的字节位置。
func lineHyphenBytePositions(inText string) map[int]bool {
	out := map[int]bool{}
	runes := []rune(inText)
	byteOffsets := make([]int, len(runes)+1)
	offset := 0
	for i, r := range runes {
		byteOffsets[i] = offset
		offset += len(string(r))
	}
	byteOffsets[len(runes)] = offset

	for i := 1; i < len(runes); i++ {
		if runes[i] != '-' || !unicode.IsLetter(runes[i-1]) {
			continue
		}
		j := i + 1
		for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
			j++
		}
		if j < len(runes) && runes[j] == '\n' {
			j++
			for j < len(runes) && (runes[j] == ' ' || runes[j] == '\t') {
				j++
			}
			if j < len(runes) && unicode.IsLetter(runes[j]) {
				out[byteOffsets[i]] = true
			}
		}
	}
	return out
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return n
		}
		n = n*10 + int(r-'0')
	}
	return n
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
