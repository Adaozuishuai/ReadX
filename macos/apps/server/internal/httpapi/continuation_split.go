package httpapi

import (
	"math"
	"regexp"
	"strings"

	"cbctv2/server/internal/translate"
)

var (
	continuationSplitTokenRE  = regexp.MustCompile(`(<[tcuefg]\d+-[0-9a-z]{3}/>|\[\[FORMULA_\d+\]\]|(?:https?://|www\.)[^\s<>"'）】]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\s+|[A-Za-z0-9_./-]+|[\p{Han}]|.)`)
	continuationInlineMathRE  = regexp.MustCompile(`\$(?:\\.|[^$\\\n])+\$`)
	continuationInlineCodeRE  = regexp.MustCompile("`[^`\\n]+`")
	continuationSourceLabelRE = regexp.MustCompile(`^\s*[A-Z][A-Za-z]*(?:[ -][A-Za-z]+){0,3}\s*[:：]\s`)
	continuationTargetLabelRE = regexp.MustCompile(`^[\p{Han}A-Za-z][\p{Han}A-Za-z ]{0,11}[：:]`)
)

const (
	continuationSentenceClosers    = `"'”’)]}）】」』`
	continuationLeadingPunctuation = `，。、；：！？）】」』,.;:!?)]}`
)

// splitContinuationTranslation ports LeePDF's group split policy: preserve
// protected formula tokens as atomic units, use source-length weights, and
// prefer coherent sentence/clause boundaries in the translated paragraph.
func splitContinuationTranslation(target string, members []translate.Item) []string {
	if len(members) <= 1 {
		return []string{strings.TrimSpace(target)}
	}
	tokens := tokenizeContinuationTranslation(strings.TrimSpace(target))
	if len(tokens) == 0 {
		return make([]string, len(members))
	}
	tokenCosts := make([]float64, len(tokens))
	totalCost := 0.0
	prefixCosts := make([]float64, len(tokens)+1)
	for index, token := range tokens {
		tokenCosts[index] = continuationTokenUnits(token)
		totalCost += tokenCosts[index]
		prefixCosts[index+1] = totalCost
	}
	if totalCost <= 0 {
		return []string{strings.TrimSpace(strings.Join(tokens, ""))}
	}
	sourceWeights := make([]float64, len(members))
	totalSourceWeight := 0.0
	for index, member := range members {
		sourceWeights[index] = math.Max(1, continuationTextUnits(translate.ProtectSource(member.Source, member.Terms)))
		totalSourceWeight += sourceWeights[index]
	}
	if totalSourceWeight < 1 {
		totalSourceWeight = 1
	}
	chunks := make([]string, 0, len(members))
	cursor, sourceSeen := 0, 0.0
	cumulativeTargetCost := 0.0
	for index, weight := range sourceWeights[:len(sourceWeights)-1] {
		sourceSeen += weight
		targetCost := totalCost * sourceSeen / totalSourceWeight
		maxProbe := len(tokens) - (len(sourceWeights) - index - 1)
		if continuationSourceEndsSentence(members[index].Source) {
			if probe := continuationSentenceBoundary(tokens, prefixCosts, cursor, maxProbe, targetCost, continuationSourceLabelRE.MatchString(members[index+1].Source)); probe >= 0 {
				chunks = append(chunks, strings.TrimSpace(strings.Join(tokens[cursor:probe], "")))
				cumulativeTargetCost = prefixCosts[probe]
				cursor = probe
				continue
			}
		}
		cumulative := cumulativeTargetCost
		anchor := cursor + 1
		for anchor < len(tokens)-(len(sourceWeights)-index-1) && cumulative < targetCost {
			cumulative += tokenCosts[anchor-1]
			anchor++
		}
		left := max(cursor+1, anchor-36)
		right := min(len(tokens)-(len(sourceWeights)-index-1), anchor+36)
		best, bestScore := anchor, math.MaxFloat64
		for probe := left; probe <= right; probe++ {
			if probe <= cursor {
				continue
			}
			score := math.Abs(cumulativeTargetCost+prefixCosts[probe]-prefixCosts[cursor]-targetCost) + continuationBreakAdjustment(tokens, probe)
			if score < bestScore {
				best, bestScore = probe, score
			}
		}
		if best <= cursor {
			best = min(cursor+1, len(tokens))
		}
		chunks = append(chunks, strings.TrimSpace(strings.Join(tokens[cursor:best], "")))
		cumulativeTargetCost += prefixCosts[best] - prefixCosts[cursor]
		cursor = best
	}
	chunks = append(chunks, strings.TrimSpace(strings.Join(tokens[cursor:], "")))
	for len(chunks) < len(members) {
		chunks = append(chunks, "")
	}
	return chunks[:len(members)]
}

func tokenizeContinuationTranslation(text string) []string {
	// Keep inline LaTeX spans atomic before applying the general token pattern.
	var tokens []string
	for len(text) > 0 {
		loc := findUnescapedContinuationMath(text)
		if codeLoc := continuationInlineCodeRE.FindStringIndex(text); codeLoc != nil && (loc == nil || codeLoc[0] < loc[0]) {
			loc = codeLoc
		}
		prefixEnd := len(text)
		if loc != nil {
			prefixEnd = loc[0]
		}
		if prefixEnd > 0 {
			tokens = append(tokens, continuationSplitTokenRE.FindAllString(text[:prefixEnd], -1)...)
			text = text[prefixEnd:]
			continue
		}
		if loc == nil {
			tokens = append(tokens, continuationSplitTokenRE.FindAllString(text, -1)...)
			break
		}
		tokens = append(tokens, text[:loc[1]])
		text = text[loc[1]:]
	}
	return tokens
}

func findUnescapedContinuationMath(text string) []int {
	searchFrom := 0
	for searchFrom < len(text) {
		location := continuationInlineMathRE.FindStringIndex(text[searchFrom:])
		if location == nil {
			return nil
		}
		start, end := searchFrom+location[0], searchFrom+location[1]
		backslashes := 0
		for index := start - 1; index >= 0 && text[index] == '\\'; index-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			return []int{start, end}
		}
		searchFrom = end
	}
	return nil
}

func continuationTokenUnits(token string) float64 {
	if token == "" {
		return 0
	}
	if strings.TrimSpace(token) == "" {
		return 0.2
	}
	if strings.HasPrefix(token, "<") || strings.HasPrefix(token, "[[FORMULA_") || strings.HasPrefix(token, "$") || strings.HasPrefix(token, "`") || strings.Contains(token, "@") || strings.HasPrefix(token, "http://") || strings.HasPrefix(token, "https://") || strings.HasPrefix(token, "www.") {
		return 3
	}
	if continuationAsciiTokenRE.MatchString(token) {
		return math.Max(1, float64(len([]rune(token)))*0.55)
	}
	return 1
}

var continuationAsciiTokenRE = regexp.MustCompile(`^[A-Za-z0-9_\-./]+$`)

func continuationTextUnits(text string) float64 {
	units := 0.0
	for _, token := range tokenizeContinuationTranslation(text) {
		units += continuationTokenUnits(token)
	}
	return units
}

func continuationSourceEndsSentence(text string) bool {
	trimmed := strings.TrimSpace(text)
	runes := []rune(trimmed)
	for len(runes) > 0 && strings.ContainsRune(continuationSentenceClosers, runes[len(runes)-1]) {
		runes = runes[:len(runes)-1]
	}
	if len(runes) == 0 {
		return false
	}
	return strings.ContainsRune("。！？.!?", runes[len(runes)-1])
}

func continuationSentenceBoundary(tokens []string, prefixCosts []float64, cursor, maxProbe int, targetCost float64, nextStartsWithLabel bool) int {
	candidates := make([]int, 0)
	for probe := cursor + 1; probe <= maxProbe; probe++ {
		index := probe - 1
		for index >= 0 && strings.Trim(tokens[index], continuationSentenceClosers) == "" {
			index--
		}
		if index < 0 {
			continue
		}
		token := tokens[index]
		if strings.ContainsRune("。！？", lastRune(token)) {
			candidates = append(candidates, probe)
			continue
		}
		if !strings.ContainsRune(".!?", lastRune(token)) {
			continue
		}
		if probe >= len(tokens) || strings.TrimSpace(tokens[probe]) == "" {
			candidates = append(candidates, probe)
		}
	}
	if len(candidates) == 0 {
		return -1
	}
	if nextStartsWithLabel {
		labeled := candidates[:0]
		for _, probe := range candidates {
			head := strings.TrimLeft(strings.Join(tokens[probe:min(probe+16, len(tokens))], ""), " \t\r\n")
			if continuationTargetLabelRE.MatchString(head) {
				labeled = append(labeled, probe)
			}
		}
		if len(labeled) > 0 {
			candidates = labeled
		}
	}
	best := candidates[0]
	bestDistance := math.Abs(prefixCosts[best] - targetCost)
	for _, probe := range candidates[1:] {
		if distance := math.Abs(prefixCosts[probe] - targetCost); distance < bestDistance {
			best, bestDistance = probe, distance
		}
	}
	return best
}

func continuationBreakAdjustment(tokens []string, probe int) float64 {
	if probe <= 0 || probe > len(tokens) {
		return 0
	}
	previous := strings.TrimSpace(tokens[probe-1])
	adjustment := 0.0
	switch {
	case strings.ContainsRune("。！？；.!?;", lastRune(previous)):
		adjustment -= 6
	case strings.ContainsRune("，、：,:", lastRune(previous)):
		adjustment -= 4
	case strings.ContainsRune("。！？；，、,.!?;:)]}）】」』", lastRune(previous)):
		adjustment -= 2
	}
	for index := probe; index < len(tokens); index++ {
		if strings.TrimSpace(tokens[index]) == "" {
			continue
		}
		if strings.ContainsRune(continuationLeadingPunctuation, firstRune(tokens[index])) {
			adjustment += 6
		}
		break
	}
	return adjustment
}

func lastRune(text string) rune {
	runes := []rune(text)
	if len(runes) == 0 {
		return 0
	}
	return runes[len(runes)-1]
}

func firstRune(text string) rune {
	for _, r := range text {
		return r
	}
	return 0
}
