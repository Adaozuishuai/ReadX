package translate

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// MatchTerms injects only glossary entries that occur in this segment, matching
// LeePDF's matched-only glossary behavior.
func MatchTerms(source string, entries []Term) []Term {
	matched := make([]Term, 0)
	seen := map[string]bool{}
	for _, term := range entries {
		if term.Treatment == "free" || term.Treatment == "drop" {
			continue
		}
		term.Source = strings.TrimSpace(term.Source)
		term.Target = strings.TrimSpace(term.Target)
		term.MatchMode = normalizeTermMatchMode(term.MatchMode)
		term.Context = strings.TrimSpace(term.Context)
		if term.Level != "preserve" && term.Level != "canonical" && term.Level != "preferred" {
			term.Level = "preferred"
		}
		if term.Source == "" || term.Target == "" || !termMatches(source, term) {
			continue
		}
		key := strings.ToLower(term.Source) + "\x00" + strings.ToLower(term.Target) + "\x00" + strings.ToLower(term.Level) + "\x00" + term.MatchMode + "\x00" + strings.ToLower(term.Context)
		if seen[key] {
			continue
		}
		seen[key] = true
		matched = append(matched, term)
	}
	sort.SliceStable(matched, func(i, j int) bool { return len([]rune(matched[i].Source)) > len([]rune(matched[j].Source)) })
	return matched
}

func termMatches(source string, term Term) bool {
	for _, location := range termLocations(source, term) {
		if termContextMatches(source, term, location[0], location[1]) {
			return true
		}
	}
	return false
}

func termLocations(source string, term Term) [][]int {
	pattern := regexp.QuoteMeta(term.Source)
	if term.MatchMode == "regex" {
		pattern = term.Source
	} else if term.MatchMode == "case_insensitive" {
		pattern = "(?i)" + pattern
	}
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		return nil
	}
	locations := compiled.FindAllStringIndex(source, -1)
	matched := locations[:0]
	for _, loc := range locations {
		if term.MatchMode != "regex" {
			leftWord := loc[0] > 0 && isTermWord(source[loc[0]-1])
			rightWord := loc[1] < len(source) && isTermWord(source[loc[1]])
			if leftWord || rightWord {
				continue
			}
		}
		matched = append(matched, loc)
	}
	return matched
}

func normalizeTermMatchMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "case_insensitive", "regex":
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return "exact"
	}
}

func termContextMatches(text string, term Term, start, end int) bool {
	if term.Context == "" {
		return true
	}
	left, right := start, end
	for count := 0; left > 0 && count < 160; count++ {
		_, size := utf8.DecodeLastRuneInString(text[:left])
		if size == 0 {
			break
		}
		left -= size
	}
	for count := 0; right < len(text) && count < 160; count++ {
		_, size := utf8.DecodeRuneInString(text[right:])
		if size == 0 {
			break
		}
		right += size
	}
	return strings.Contains(strings.ToLower(text[left:right]), strings.ToLower(term.Context))
}

func isTermWord(value byte) bool {
	return value == '_' || value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9'
}

func protectTerms(text string, tokens []Token, terms []Term) (string, []Token) {
	terms = MatchTerms(text, terms)
	if len(terms) == 0 {
		return text, tokens
	}
	spans := make([]protectedSpan, 0)
	for _, term := range terms {
		if term.Level == "preferred" {
			continue
		}
		for _, loc := range termLocations(text, term) {
			if !termContextMatches(text, term, loc[0], loc[1]) {
				continue
			}
			original := text[loc[0]:loc[1]]
			restore := term.Target
			if term.Level == "preserve" {
				restore = original
			}
			spans = append(spans, protectedSpan{start: loc[0], end: loc[1], kind: 'g', original: original, restore: restore})
		}
	}
	if len(spans) == 0 {
		return text, tokens
	}
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].end-spans[i].start > spans[j].end-spans[j].start })
	selected := make([]protectedSpan, 0, len(spans))
	for _, span := range spans {
		if overlapsSpan(span.start, span.end, selected) || overlapsTokenTag(span.start, span.end, text) {
			continue
		}
		selected = append(selected, span)
	}
	spans = selected
	spans = sortSpans(spans)
	counter := 0
	for _, token := range tokens {
		if strings.HasPrefix(token.Tag, "<g") {
			counter++
		}
	}
	var out strings.Builder
	newTokens := append([]Token(nil), tokens...)
	cursor := 0
	for _, span := range spans {
		if span.start < cursor {
			continue
		}
		out.WriteString(text[cursor:span.start])
		tag := tokenTag('g', counter, span.original)
		counter++
		out.WriteString(tag)
		newTokens = append(newTokens, Token{Tag: tag, Original: span.original, Restore: span.restore})
		cursor = span.end
	}
	out.WriteString(text[cursor:])
	return out.String(), newTokens
}

func overlapsTokenTag(start, end int, text string) bool {
	for _, loc := range tokenTagRE.FindAllStringIndex(text, -1) {
		if start < loc[1] && loc[0] < end {
			return true
		}
	}
	return false
}
