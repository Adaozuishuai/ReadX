package translate

import (
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const numericQASchema = "translation_numeric_qa.v1"

type NumericQAIssue struct {
	ID                 string   `json:"id"`
	Type               string   `json:"type"`
	Severity           string   `json:"severity"`
	Message            string   `json:"message"`
	ItemIDs            []string `json:"itemIds"`
	UnitID             string   `json:"unitId"`
	PageNumber         int      `json:"pageNumber"`
	SourceExcerpt      string   `json:"sourceExcerpt"`
	TranslationExcerpt string   `json:"translationExcerpt"`
	ExpectedValue      string   `json:"expectedValue,omitempty"`
	Missing            []string `json:"missing,omitempty"`
	Extra              []string `json:"extra,omitempty"`
	SourceOCRSuspect   bool     `json:"sourceOcrSuspect,omitempty"`
}

type NumericQAReport struct {
	Schema             string           `json:"schema"`
	GeneratedAt        string           `json:"generatedAt"`
	ItemCount          int              `json:"itemCount"`
	CheckedUnitCount   int              `json:"checkedUnitCount"`
	CheckedNumberCount int              `json:"checkedNumberCount"`
	ViolationCount     int              `json:"violationCount"`
	BySeverity         map[string]int   `json:"bySeverity"`
	Violations         []NumericQAIssue `json:"violations"`
}

type numericUnit struct {
	id        string
	items     []Item
	sources   []string
	targets   []string
	firstPage int
}

type numericOccurrence struct {
	value *big.Rat
	raw   string
}

var (
	numericThousandsRE      = regexp.MustCompile(`\d{1,3}(?:,\d{3})+`)
	numericLatexThousandsRE = regexp.MustCompile(`\d{1,3}(?:(?:\\,|\{,\}|\\ )\d{3})+`)
	numericThinThousandsRE  = regexp.MustCompile(`\d{1,3}(?:[  ]\d{3})+`)
	numericSpaceThousandsRE = regexp.MustCompile(`\d{1,3}(?: \d{3})+`)
	numericSpacedDecimalRE  = regexp.MustCompile(`\d+(?: \d)* \. \d(?: \d)*`)
	numericSpacedDigitsRE   = regexp.MustCompile(`\d(?: \d)+`)
	numericScaleAbbrRE      = regexp.MustCompile(`(?i)(?:^|[^\d.\w])(\d+(?:\.\d+)?)([KMB])\b`)
	numericEnglishScaleRE   = regexp.MustCompile(`(?i)(?:^|[^\d.])(\d+(?:\.\d+)?)[ \t]*(thousand|million|billion|trillion)s?\b`)
	numericChineseScaleRE   = regexp.MustCompile(`(?:^|[^\d.])(\d+(?:\.\d+)?)[ \t]*(万亿|千亿|百亿|十亿|亿|千万|百万|十万|万|千)`)
	numericSciRE            = regexp.MustCompile(`(?:^|[^\d.])(\d+(?:\.\d+)?)[ \t]*(?:×|\\times|\\cdot|·|x|\*)[ \t]*10[ \t]*\^?[ \t]*\{?[ \t]*([+-]?\d+)[ \t]*\}?`)
	numericSciERe           = regexp.MustCompile(`(?:^|[^\w.])(\d+(?:\.\d+)?)[eE]([+-]?\d+)(?:$|[^\w])`)
	numericPercentRE        = regexp.MustCompile(`(?i)(?:^|[^\d.])(\d+(?:\.\d+)?)[ \t]*(?:%|\\%|percent\b|per cent\b)`)
	numericTargetPercentRE  = regexp.MustCompile(`(?:^|[^\d.])(\d+(?:\.\d+)?)[ \t]*(?:%|％|\\%)`)
	numericDecadeRE         = regexp.MustCompile(`(?:^|[^\d])((?:1[0-9]|20)(\d)0)(?:'?s)\b`)
	numericPlainRE          = regexp.MustCompile(`\d+(?:\.\d+)?`)
	numericCitationRE       = regexp.MustCompile(`\[(\d+(?:[ \t]*[,\-‐‑‒–—−][ \t]*\d+)*)\]`)
	numericRefRE            = regexp.MustCompile(`(?i)(?:^|[^A-Za-z])(?:fig(?:ure)?s?\.?|tables?|tab\.|equations?|eqns?\.?|eqs?\.?|sections?|sec(?:t)?s?\.?|§§?|chapters?|chap\.?|ch\.?|problems?|probs?\.?|exercises?|examples?|appendix|appendices|schemes?)[ \t]*\(?[A-Z]?\d+(?:[.\-‐‑‒–—−]\d+)*[a-z]?\)?(?:[ \t]*(?:,|and|&|or|to|through)[ \t]*\(?[A-Z]?\d+(?:[.\-‐‑‒–—−]\d+)*[a-z]?\)?)*`)
	numericOCRNoiseRE       = regexp.MustCompile(`\\[A-Za-z]+[ \t]*\{|\{[ \t]*\d|(?:^|[^\d.])\d \d(?:[^\d.]|$)|\d+\.\d+\.\d`)
)

var numericScalePowers = map[string]int{
	"k": 3, "m": 6, "b": 9,
	"thousand": 3, "million": 6, "billion": 9, "trillion": 12,
	"千": 3, "万": 4, "十万": 5, "百万": 6, "千万": 7, "亿": 8,
	"十亿": 9, "百亿": 10, "千亿": 11, "万亿": 12,
}

var numericChineseDigits = map[int]string{
	0: "零〇", 1: "一壹", 2: "二两贰双俩", 3: "三叁", 4: "四肆", 5: "五伍",
	6: "六陆", 7: "七柒", 8: "八捌", 9: "九玖", 10: "十拾",
}

var numericEnglishWords = map[int][]string{
	0: {"zero", "none"}, 1: {"one", "first", "single", "once", "a ", "an "},
	2: {"two", "second", "double", "twice", "pair", "both", "binary", "di"},
	3: {"three", "third", "triple", "thrice", "tri"}, 4: {"four", "fourth", "quad"},
	5: {"five", "fifth"}, 6: {"six", "sixth"}, 7: {"seven", "seventh"},
	8: {"eight", "eighth"}, 9: {"nine", "ninth"}, 10: {"ten", "tenth"},
}

// BuildNumericQA mirrors RetainPDF's document-wide numeric checks. Continuation
// members are compared as one unit so reordered clauses are not falsely flagged.
func BuildNumericQA(items []Item, targets []string) NumericQAReport {
	units := make([]*numericUnit, 0, len(items))
	byUnit := map[string]*numericUnit{}
	for index, item := range items {
		unitID := item.ItemID
		if strings.TrimSpace(item.ContinuationGroup) != "" {
			unitID = item.ContinuationGroup
		}
		unit := byUnit[unitID]
		if unit == nil {
			unit = &numericUnit{id: unitID, firstPage: item.PageIndex + 1}
			byUnit[unitID] = unit
			units = append(units, unit)
		}
		unit.items = append(unit.items, item)
		unit.sources = append(unit.sources, item.Source)
		if index < len(targets) {
			unit.targets = append(unit.targets, targets[index])
		} else {
			unit.targets = append(unit.targets, "")
		}
	}
	report := NumericQAReport{
		Schema: numericQASchema, GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		ItemCount: len(items), BySeverity: map[string]int{}, Violations: []NumericQAIssue{},
	}
	for _, unit := range units {
		source, target := strings.Join(unit.sources, " "), strings.Join(unit.targets, " ")
		if source == "" {
			continue
		}
		report.CheckedUnitCount++
		issues, checked := checkNumericUnit(unit, source, target)
		report.CheckedNumberCount += checked
		for _, issue := range issues {
			issue.ID = fmt.Sprintf("num-%05d", len(report.Violations)+1)
			report.BySeverity[issue.Severity]++
			report.Violations = append(report.Violations, issue)
		}
	}
	sortNumericIssues(report.Violations)
	for index := range report.Violations {
		report.Violations[index].ID = fmt.Sprintf("num-%05d", index+1)
	}
	report.ViolationCount = len(report.Violations)
	return report
}

func checkNumericUnit(unit *numericUnit, sourceRaw, targetRaw string) ([]NumericQAIssue, int) {
	source := normalizeNumericDashes(stripNumericReferences(sourceRaw))
	target := normalizeNumericDashes(stripNumericCitations(targetRaw))
	source = stripNumericThousands(source)
	target = stripNumericThousands(target)
	refNumbers := sourceReferenceNumbers(sourceRaw)
	issues := []NumericQAIssue{}
	checked := 0
	add := func(kind, severity, message, sourceNeedle, targetNeedle, expected string, missing, extra []string, noisy bool) {
		ids := make([]string, 0, len(unit.items))
		for _, item := range unit.items {
			if item.ItemID != "" {
				ids = append(ids, item.ItemID)
			}
		}
		issues = append(issues, NumericQAIssue{
			Type: kind, Severity: severity, Message: message, ItemIDs: ids, UnitID: unit.id,
			PageNumber: unit.firstPage, SourceExcerpt: numericExcerpt(sourceRaw, sourceNeedle),
			TranslationExcerpt: numericExcerpt(targetRaw, targetNeedle), ExpectedValue: expected,
			Missing: missing, Extra: extra, SourceOCRSuspect: noisy,
		})
	}
	sourceSci, source := extractNumericSci(source)
	targetSci, targetRest := extractNumericSci(target)
	targetAbbr, targetRest := extractNumericScales(targetRest, numericScaleAbbrRE)
	targetEnglish, targetRest := extractNumericScales(targetRest, numericEnglishScaleRE)
	abbr := []numericOccurrence{}
	source = replaceNumericMatches(numericScaleAbbrRE, source, func(match []string) (string, bool) {
		value, ok := numericScaledValue(match[1], numericScalePowers[strings.ToLower(match[2])])
		if ok {
			abbr = append(abbr, numericOccurrence{value: value, raw: match[1] + match[2]})
			return " ", true
		}
		return match[0], false
	})
	sourceScaled, source := extractNumericScales(source, numericEnglishScaleRE)
	targetChinese, targetRest := extractNumericScales(targetRest, numericChineseScaleRE)
	targetNumbers := extractNumericPlain(targetRest)
	targetValues := append(append(append(append([]numericOccurrence{}, targetSci...), targetAbbr...), targetEnglish...), targetChinese...)
	targetSet := numericValueSet(targetValues, targetNumbers)
	for _, occurrence := range abbr {
		checked++
		if numericHas(targetSet, occurrence.value) || numericHas(targetSet, parseNumericDecimal(occurrence.raw[:len(occurrence.raw)-1])) {
			continue
		}
		add("number_scale_mismatch", "major", "数值在译文中对不上："+occurrence.raw+"（应为 "+numericHuman(occurrence.value)+"）", occurrence.raw, "", numericCanonical(occurrence.value), nil, nil, false)
	}
	for _, occurrence := range append(sourceSci, sourceScaled...) {
		checked++
		if numericHas(targetSet, occurrence.value) {
			continue
		}
		kind, severity := "number_scale_mismatch", "critical"
		if strings.ContainsAny(occurrence.raw, "×x*") || strings.Contains(occurrence.raw, "\\times") || strings.Contains(occurrence.raw, "\\cdot") || strings.ContainsAny(occurrence.raw, "eE") {
			kind = "sci_notation_mismatch"
		}
		add(kind, severity, "数值在译文中对不上："+strings.TrimSpace(occurrence.raw)+"（应为 "+numericHuman(occurrence.value)+"）", occurrence.raw, "", numericCanonical(occurrence.value), nil, nil, false)
	}
	targetPercents := map[string]bool{}
	for _, match := range numericTargetPercentRE.FindAllStringSubmatch(target, -1) {
		if len(match) > 1 {
			targetPercents[numericCanonical(parseNumericDecimal(match[1]))] = true
		}
	}
	for _, match := range numericPercentRE.FindAllStringSubmatch(source, -1) {
		if len(match) < 2 {
			continue
		}
		number := numericCanonical(parseNumericDecimal(match[1]))
		checked++
		if targetPercents[number] || strings.Contains(targetRaw, "百分之") {
			continue
		}
		if numericValueIn(number, targetNumbers) {
			add("percent_dropped", "major", "百分数 "+strings.TrimSpace(match[0])+" 在译文中丢了百分号", match[0], number, "", nil, nil, false)
		}
	}
	decades := map[string]bool{}
	for _, match := range numericDecadeRE.FindAllStringSubmatch(source, -1) {
		if len(match) < 3 {
			continue
		}
		year := match[1]
		decades[year] = true
		checked++
		century, _ := strconv.Atoi(year[:2])
		century++
		decade := year[2:]
		if regexp.MustCompile(fmt.Sprintf(`%d\s*世纪\s*%s\s*年代`, century, decade)).MatchString(targetRaw) {
			continue
		}
		if regexp.MustCompile(`(?:^|\D)` + regexp.QuoteMeta(year) + `(?:$|\D)`).MatchString(target) {
			add("decade_style", "minor", fmt.Sprintf("年代 %s 建议写作「%d 世纪 %s 年代」", strings.TrimSpace(match[0]), century, decade), strings.TrimSpace(match[0]), year, fmt.Sprintf("%d 世纪 %s 年代", century, decade), nil, nil, false)
		} else {
			add("number_missing", "critical", fmt.Sprintf("年代 %s 在译文中缺失", strings.TrimSpace(match[0])), strings.TrimSpace(match[0]), "", fmt.Sprintf("%d 世纪 %s 年代", century, decade), []string{year}, nil, false)
		}
	}
	sourceNumbers := extractNumericPlain(source)
	plainSource := []string{}
	for _, number := range sourceNumbers {
		canonical := numericCanonical(parseNumericDecimal(number))
		if !decades[canonical] {
			plainSource = append(plainSource, canonical)
		}
	}
	checked += len(plainSource)
	translationSet := numericValueSet(targetValues, targetNumbers)
	missing := []string{}
	seenMissing := map[string]bool{}
	noisy := numericOCRNoiseRE.MatchString(stripNumericMath(sourceRaw))
	for _, number := range uniqueStrings(plainSource) {
		if refNumbers[number] || numericHas(translationSet, parseNumericDecimal(number)) {
			continue
		}
		if intValue, err := strconv.Atoi(number); err == nil && intValue <= 10 && intValue >= 0 && numericChineseDigitPresent(targetRaw, intValue) {
			continue
		}
		if !seenMissing[number] {
			seenMissing[number] = true
			missing = append(missing, number)
		}
	}
	if len(missing) > 0 {
		severity := "critical"
		allSingle := true
		for _, number := range missing {
			if len(number) != 1 {
				allSingle = false
			}
		}
		if noisy || allSingle {
			severity = "major"
		}
		preview := strings.Join(missing[:numericMin(8, len(missing))], "、")
		add("number_missing", severity, "原文中的数字在译文中缺失："+preview, missing[0], "", "", missing, nil, noisy)
	}
	sourceSet := map[string]bool{}
	for _, number := range plainSource {
		sourceSet[number] = true
	}
	for number := range refNumbers {
		sourceSet[number] = true
	}
	for _, occurrence := range append(append(sourceSci, sourceScaled...), abbr...) {
		sourceSet[numericCanonical(occurrence.value)] = true
	}
	for _, match := range numericPercentRE.FindAllStringSubmatch(source, -1) {
		if len(match) > 1 {
			sourceSet[numericCanonical(parseNumericDecimal(match[1]))] = true
		}
	}
	decadeCenturies, decadeTails := map[string]bool{}, map[string]bool{}
	for year := range decades {
		century, _ := strconv.Atoi(year[:2])
		decadeCenturies[strconv.Itoa(century+1)] = true
		decadeTails[year[2:]] = true
	}
	extra := []string{}
	for _, number := range uniqueStrings(targetNumbers) {
		if sourceSet[number] || decadeCenturies[number] || decadeTails[number] {
			continue
		}
		if intValue, err := strconv.Atoi(number); err == nil {
			if intValue <= 10 && intValue >= 0 && numericEnglishNumberWord(sourceRaw, intValue) {
				continue
			}
			if intValue >= 1 && intValue <= 12 && numericMonthRE.MatchString(sourceRaw) && strings.Contains(targetRaw, "月") {
				continue
			}
		}
		extra = append(extra, number)
	}
	if len(extra) > 0 {
		severity := "major"
		if noisy {
			severity = "minor"
		}
		add("number_extra", severity, "译文出现了原文没有的数字："+strings.Join(extra[:numericMin(8, len(extra))], "、"), "", extra[0], "", nil, extra, noisy)
	}
	return issues, checked
}

var numericMonthRE = regexp.MustCompile(`(?i)\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`)

func extractNumericSci(text string) ([]numericOccurrence, string) {
	occurrences := []numericOccurrence{}
	text = replaceNumericMatches(numericSciRE, text, func(match []string) (string, bool) {
		if len(match) < 3 {
			return match[0], false
		}
		exponent, err := strconv.Atoi(match[2])
		if err != nil || exponent > 1000 || exponent < -1000 {
			return match[0], false
		}
		value, ok := numericScaledValue(match[1], exponent)
		if ok {
			occurrences = append(occurrences, numericOccurrence{value: value, raw: strings.TrimSpace(match[0])})
			return " ", true
		}
		return match[0], false
	})
	text = replaceNumericMatches(numericSciERe, text, func(match []string) (string, bool) {
		if len(match) < 3 {
			return match[0], false
		}
		exponent, err := strconv.Atoi(match[2])
		if err != nil || exponent > 1000 || exponent < -1000 {
			return match[0], false
		}
		value, ok := numericScaledValue(match[1], exponent)
		if ok {
			occurrences = append(occurrences, numericOccurrence{value: value, raw: strings.TrimSpace(match[0])})
			return " ", true
		}
		return match[0], false
	})
	return occurrences, text
}

func extractNumericScales(text string, pattern *regexp.Regexp) ([]numericOccurrence, string) {
	occurrences := []numericOccurrence{}
	text = replaceNumericMatches(pattern, text, func(match []string) (string, bool) {
		if len(match) < 3 {
			return match[0], false
		}
		power := numericScalePowers[strings.ToLower(match[2])]
		if power == 0 {
			return match[0], false
		}
		value, ok := numericScaledValue(match[1], power)
		if ok {
			occurrences = append(occurrences, numericOccurrence{value: value, raw: strings.TrimSpace(match[0])})
			return " ", true
		}
		return match[0], false
	})
	return occurrences, text
}

func replaceNumericMatches(pattern *regexp.Regexp, text string, convert func([]string) (string, bool)) string {
	return pattern.ReplaceAllStringFunc(text, func(raw string) string {
		parts := pattern.FindStringSubmatch(raw)
		replacement, ok := convert(parts)
		if ok {
			return replacement
		}
		return raw
	})
}

func extractNumericPlain(text string) []string {
	text = normalizeNumericThousands(text)
	values := []string{}
	for _, match := range numericPlainRE.FindAllStringIndex(text, -1) {
		start, end := match[0], match[1]
		if start > 0 && (text[start-1] >= '0' && text[start-1] <= '9' || text[start-1] == '.') {
			continue
		}
		if end < len(text) && text[end] >= '0' && text[end] <= '9' {
			continue
		}
		if end < len(text) && text[end] == '.' && end+1 < len(text) && text[end+1] >= '0' && text[end+1] <= '9' {
			continue
		}
		values = append(values, numericCanonical(parseNumericDecimal(text[start:end])))
	}
	return values
}

func stripNumericThousands(text string) string {
	text = normalizeNumericSuperscripts(text)
	text = replaceBoundedNumeric(text, numericLatexThousandsRE, func(value string) string {
		return strings.NewReplacer(`\,`, "", `{,}`, "", `\ `, "").Replace(value)
	})
	text = collapseNumericOCRDigits(text)
	text = replaceBoundedNumeric(text, numericThousandsRE, func(value string) string { return strings.ReplaceAll(value, ",", "") })
	text = replaceBoundedNumeric(text, numericSpaceThousandsRE, func(value string) string { return strings.ReplaceAll(value, " ", "") })
	return replaceBoundedNumeric(text, numericThinThousandsRE, func(value string) string { return strings.NewReplacer(" ", "", " ", "").Replace(value) })
}

func normalizeNumericThousands(text string) string { return stripNumericThousands(text) }

func collapseNumericOCRDigits(text string) string {
	text = replaceBoundedNumeric(text, numericSpacedDecimalRE, func(value string) string { return strings.ReplaceAll(value, " ", "") })
	return replaceBoundedNumeric(text, numericSpacedDigitsRE, func(value string) string { return strings.ReplaceAll(value, " ", "") })
}

// Go's RE2 engine does not support lookbehind/lookahead. Enforce numeric
// token boundaries around the matched candidate instead of relying on PCRE.
func replaceBoundedNumeric(text string, pattern *regexp.Regexp, replace func(string) string) string {
	indices := pattern.FindAllStringIndex(text, -1)
	if len(indices) == 0 {
		return text
	}
	var out strings.Builder
	last := 0
	for _, index := range indices {
		start, end := index[0], index[1]
		if start > last {
			out.WriteString(text[last:start])
		}
		validLeft := start == 0 || !isNumericBoundaryChar(text[start-1])
		validRight := end == len(text) || !isNumericBoundaryChar(text[end])
		if validLeft && validRight {
			out.WriteString(replace(text[start:end]))
		} else {
			out.WriteString(text[start:end])
		}
		last = end
	}
	out.WriteString(text[last:])
	return out.String()
}

func isNumericBoundaryChar(value byte) bool {
	return value >= '0' && value <= '9' || value == '.' || value == ','
}

func normalizeNumericSuperscripts(text string) string {
	return strings.NewReplacer("⁰", "0", "¹", "1", "²", "2", "³", "3", "⁴", "4", "⁵", "5", "⁶", "6", "⁷", "7", "⁸", "8", "⁹", "9", "₀", "0", "₁", "1", "₂", "2", "₃", "3", "₄", "4", "₅", "5", "₆", "6", "₇", "7", "₈", "8", "₉", "9").Replace(text)
}

func normalizeNumericDashes(text string) string {
	return strings.NewReplacer("‐", "-", "‑", "-", "‒", "-", "–", "-", "—", "-", "−", "-", "﹣", "-", "－", "-").Replace(text)
}

func stripNumericReferences(text string) string {
	text = numericRefRE.ReplaceAllString(text, " ")
	return numericCitationRE.ReplaceAllString(text, " ")
}

func stripNumericCitations(text string) string { return numericCitationRE.ReplaceAllString(text, " ") }

func stripNumericMath(text string) string { return mathSpanRE.ReplaceAllString(text, " ") }

func sourceReferenceNumbers(text string) map[string]bool {
	out := map[string]bool{}
	for _, match := range numericCitationRE.FindAllStringSubmatch(text, -1) {
		if len(match) > 1 {
			for _, part := range numericPlainRE.FindAllString(match[1], -1) {
				out[numericCanonical(parseNumericDecimal(part))] = true
			}
		}
	}
	for _, raw := range numericRefRE.FindAllString(text, -1) {
		for _, number := range numericPlainRE.FindAllString(raw, -1) {
			out[numericCanonical(parseNumericDecimal(number))] = true
		}
	}
	return out
}

func numericScaledValue(number string, power int) (*big.Rat, bool) {
	value := parseNumericDecimal(number)
	if value == nil {
		return nil, false
	}
	if power >= 0 {
		factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(power)), nil)
		return new(big.Rat).Mul(value, new(big.Rat).SetInt(factor)), true
	}
	factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(-power)), nil)
	return new(big.Rat).Quo(value, new(big.Rat).SetInt(factor)), true
}

func parseNumericDecimal(value string) *big.Rat {
	cleaned := strings.ReplaceAll(strings.TrimSpace(value), ",", "")
	parsed := new(big.Rat)
	if _, ok := parsed.SetString(cleaned); !ok {
		return nil
	}
	return parsed
}

func numericCanonical(value *big.Rat) string {
	if value == nil {
		return ""
	}
	return value.RatString()
}

func numericValueSet(special []numericOccurrence, plain []string) map[string]bool {
	values := map[string]bool{}
	for _, item := range special {
		if item.value != nil {
			values[numericCanonical(item.value)] = true
		}
	}
	for _, number := range plain {
		if value := parseNumericDecimal(number); value != nil {
			values[numericCanonical(value)] = true
		}
	}
	return values
}

func numericHas(values map[string]bool, number *big.Rat) bool {
	return number != nil && values[numericCanonical(number)]
}

func numericValueIn(want string, values []string) bool {
	for _, value := range values {
		if numericCanonical(parseNumericDecimal(value)) == want {
			return true
		}
	}
	return false
}

func numericChineseDigitPresent(text string, number int) bool {
	for _, char := range numericChineseDigits[number] {
		if strings.ContainsRune(text, char) {
			return true
		}
	}
	return false
}

func numericEnglishNumberWord(source string, value int) bool {
	folded := " " + strings.ToLower(source) + " "
	for _, word := range numericEnglishWords[value] {
		if strings.HasSuffix(word, " ") {
			if strings.Contains(folded, " "+word) {
				return true
			}
			continue
		}
		if len(word) <= 3 {
			if regexp.MustCompile(`\b` + regexp.QuoteMeta(word)).MatchString(folded) {
				return true
			}
		} else if regexp.MustCompile(`\b` + regexp.QuoteMeta(word) + `\b`).MatchString(folded) {
			return true
		}
	}
	return false
}

func numericExcerpt(text, needle string) string {
	compact := strings.Join(strings.Fields(text), " ")
	if compact == "" {
		return ""
	}
	position := -1
	if needle != "" {
		position = strings.Index(strings.ToLower(compact), strings.ToLower(strings.Join(strings.Fields(needle), " ")))
	}
	const width = 48
	if position < 0 {
		if len([]rune(compact)) <= width*2 {
			return compact
		}
		return string([]rune(compact)[:width*2]) + "…"
	}
	runes := []rune(compact)
	byteToRune := len([]rune(compact[:position]))
	needleRunes := len([]rune(needle))
	left, right := numericMax(0, byteToRune-width), numericMin(len(runes), byteToRune+needleRunes+width)
	result := string(runes[left:right])
	if left > 0 {
		result = "…" + result
	}
	if right < len(runes) {
		result += "…"
	}
	return result
}

func numericHuman(value *big.Rat) string {
	if value == nil {
		return ""
	}
	for _, scale := range []struct {
		power int
		label string
	}{{12, "万亿"}, {8, "亿"}, {4, "万"}} {
		threshold := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(scale.power)), nil)
		if new(big.Rat).Abs(value).Cmp(new(big.Rat).SetInt(threshold)) >= 0 {
			divisor := new(big.Rat).SetInt(threshold)
			return numericCanonical(new(big.Rat).Quo(value, divisor)) + " " + scale.label
		}
	}
	return numericCanonical(value)
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	unique := []string{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			unique = append(unique, value)
		}
	}
	return unique
}

func numericMin(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func numericMax(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func sortNumericIssues(issues []NumericQAIssue) {
	severityOrder := map[string]int{"critical": 0, "major": 1, "minor": 2}
	sort.SliceStable(issues, func(i, j int) bool {
		if issues[i].PageNumber != issues[j].PageNumber {
			return issues[i].PageNumber < issues[j].PageNumber
		}
		return severityOrder[issues[i].Severity] < severityOrder[issues[j].Severity]
	})
}
