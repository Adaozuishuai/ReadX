package translate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// tokenTagRE 是引擎自己的占位符语法：<t0-a1b/>、<c1-9f0/>、<u2-33a/>、<e3-5c1/>、<f0-72a/>。
// 前缀区分类型，数字是序号，后三位是原文校验和：模型改了 token 内容时能一眼看出来。
var tokenTagRE = regexp.MustCompile(`<[tcuefg]\d+-[0-9a-z]{3}/>`)

// Token 记录一个被替换掉的字面量，翻译完成后按 Restore 还原。
type Token struct {
	Tag      string
	Original string
	Restore  string
}

type protectedSpan struct {
	start    int
	end      int
	kind     byte
	original string
	restore  string
}

var (
	// fencedCodeRE 先于 inlineCodeRE 匹配：围栏代码里的反引号不会被拆成多个行内片段。
	fencedCodeRE = regexp.MustCompile("(?s)```[^`]*```")
	inlineCodeRE = regexp.MustCompile("`[^`\\n]+`")
	// 公式作为不透明片段处理，翻译周围自然语言后按原样插回。
	mathSpanInputRE = regexp.MustCompile(`(?s)\$\$.*?\$\$|\$(?:\\.|[^$\\])*?\$`)
	urlRE           = regexp.MustCompile(`(?:https?://|www\.)[^\s<>"'）】]+`)
	emailRE         = regexp.MustCompile(`[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)
)

// Protect 把不可翻译的字面量换成 token，返回保护后的文本和还原表。
//
// 先匹配代码和公式，再匹配 URL、邮箱；这些是语法字面量，不能被意译。
// 重叠区间按「先匹配到的更具体」合并。
func Protect(text string) (string, []Token) {
	return protect(text, nil)
}

// ProtectWithFormulas also protects formula spans identified by OCR structure,
// including unwrapped formula text that a dollar-delimiter scan cannot find.
func ProtectWithFormulas(text string, formulas []string) (string, []Token) {
	return protect(text, formulas)
}

// ProtectDirectMath preserves LeePDF's production direct_typst input: formula,
// code, URL, and email spans stay in source text. Hard glossary terms are
// protected separately by protectTerms.
func ProtectDirectMath(text string) (string, []Token) {
	return text, nil
}

func protect(text string, formulas []string) (string, []Token) {
	if text == "" {
		return "", nil
	}
	spans := make([]protectedSpan, 0, 8)
	spans = appendCodeSpans(spans, fencedCodeRE, text)
	spans = appendCodeSpans(spans, inlineCodeRE, text)
	spans = appendTypedSpans(spans, mathSpanInputRE, 'f', text)
	spans = appendExplicitFormulaSpans(spans, text, formulas)
	spans = appendLiteralSpans(spans, urlRE, 'u', text)
	spans = appendLiteralSpans(spans, emailRE, 'e', text)
	spans = removeOverlaps(sortSpans(spans))

	if len(spans) == 0 {
		return text, nil
	}
	counters := map[byte]int{}
	var out strings.Builder
	out.Grow(len(text) + len(spans)*4)
	tokens := make([]Token, 0, len(spans))
	cursor := 0
	for _, span := range spans {
		if span.start < cursor {
			continue
		}
		out.WriteString(text[cursor:span.start])
		tag := tokenTag(span.kind, counters[span.kind], span.original)
		counters[span.kind]++
		out.WriteString(tag)
		tokens = append(tokens, Token{Tag: tag, Original: span.original, Restore: span.restore})
		cursor = span.end
	}
	out.WriteString(text[cursor:])
	return out.String(), tokens
}

func appendExplicitFormulaSpans(spans []protectedSpan, text string, formulas []string) []protectedSpan {
	cursor := 0
	for _, formula := range formulas {
		formula = strings.TrimSpace(formula)
		if formula == "" {
			continue
		}
		start := strings.Index(text[cursor:], formula)
		if start < 0 {
			start = strings.Index(text, formula)
			if start < 0 {
				continue
			}
		} else {
			start += cursor
		}
		end := start + len(formula)
		cursor = end
		if overlapsSpan(start, end, spans) {
			continue
		}
		spans = append(spans, protectedSpan{start: start, end: end, kind: 'f', original: formula, restore: formula})
	}
	return spans
}

// ProtectSource is for downstream layout algorithms that need source-length
// weights without counting formulas, links, code, or canonical terms as prose.
// The model-facing translation path uses ProtectDirectMath to match LeePDF.
func ProtectSource(text string, terms []Term) string {
	protected, tokens := Protect(text)
	protected, _ = protectTerms(protected, tokens, terms)
	return protected
}

func appendTypedSpans(spans []protectedSpan, pattern *regexp.Regexp, kind byte, text string) []protectedSpan {
	for _, location := range pattern.FindAllStringIndex(text, -1) {
		if kind == 'f' && escapedAt(text, location[0]) {
			continue
		}
		if overlapsSpan(location[0], location[1], spans) {
			continue
		}
		literal := text[location[0]:location[1]]
		spans = append(spans, protectedSpan{
			start: location[0], end: location[1], kind: kind,
			original: literal, restore: literal,
		})
	}
	return spans
}

func escapedAt(text string, index int) bool {
	backslashes := 0
	for cursor := index - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
		backslashes++
	}
	return backslashes%2 == 1
}

func appendCodeSpans(spans []protectedSpan, pattern *regexp.Regexp, text string) []protectedSpan {
	for _, location := range pattern.FindAllStringIndex(text, -1) {
		if overlapsSpan(location[0], location[1], spans) {
			continue
		}
		spans = append(spans, protectedSpan{
			start:    location[0],
			end:      location[1],
			kind:     'c',
			original: text[location[0]:location[1]],
			restore:  text[location[0]:location[1]],
		})
	}
	return spans
}

func appendLiteralSpans(spans []protectedSpan, pattern *regexp.Regexp, kind byte, text string) []protectedSpan {
	for _, location := range pattern.FindAllStringIndex(text, -1) {
		start, end := trimTrailingPunctuation(text, location[0], location[1])
		if start >= end || overlapsSpan(start, end, spans) {
			continue
		}
		original := text[start:end]
		spans = append(spans, protectedSpan{start: start, end: end, kind: kind, original: original, restore: original})
	}
	return spans
}

// trimTrailingPunctuation 去掉 URL/邮箱后面顺手粘上的句号、右括号：
// 不裁掉的话 token 还原时会把标点也一起塞回译文中间。
func trimTrailingPunctuation(text string, start, end int) (int, int) {
	for end > start {
		switch text[end-1] {
		case '.', ',', ';', ':', ')', ']', '}':
			end--
			continue
		}
		trimmed := false
		for _, suffix := range []string{"。", "，", "；", "：", "）", "】"} {
			if strings.HasSuffix(text[start:end], suffix) {
				end -= len(suffix)
				trimmed = true
				break
			}
		}
		if trimmed {
			continue
		}
		break
	}
	return start, end
}

func tokenTag(kind byte, index int, original string) string {
	sum := sha256.Sum256([]byte(original))
	return fmt.Sprintf("<%c%d-%s/>", kind, index, hex.EncodeToString(sum[:])[:3])
}

func sortSpans(spans []protectedSpan) []protectedSpan {
	sort.SliceStable(spans, func(i, j int) bool {
		if spans[i].start != spans[j].start {
			return spans[i].start < spans[j].start
		}
		return spans[i].end > spans[j].end
	})
	return spans
}

func removeOverlaps(spans []protectedSpan) []protectedSpan {
	if len(spans) < 2 {
		return spans
	}
	out := spans[:0]
	cursor := -1
	for _, span := range spans {
		if span.start < cursor {
			continue
		}
		out = append(out, span)
		cursor = span.end
	}
	return out
}

func overlapsSpan(start, end int, spans []protectedSpan) bool {
	for _, span := range spans {
		if start < span.end && span.start < end {
			return true
		}
	}
	return false
}

// Restore 把 token 换回原文/术语指定译法，并报告缺失与未知 token。
func Restore(text string, tokens []Token) (string, []Token, []string) {
	known := make(map[string]string, len(tokens))
	for _, token := range tokens {
		known[token.Tag] = token.Restore
	}
	unexpected := []string{}
	restored := tokenTagRE.ReplaceAllStringFunc(text, func(tag string) string {
		if value, ok := known[tag]; ok {
			return value
		}
		unexpected = append(unexpected, tag)
		return tag
	})
	missing := make([]Token, 0, len(tokens))
	for _, token := range tokens {
		if !strings.Contains(text, token.Tag) {
			missing = append(missing, token)
		}
	}
	return restored, missing, dedupe(unexpected)
}

func tokenSequence(text string) []string {
	return tokenTagRE.FindAllString(text, -1)
}

func dedupe(values []string) []string {
	if len(values) < 2 {
		return values
	}
	seen := map[string]bool{}
	out := values[:0]
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
