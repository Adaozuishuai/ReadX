package translate

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultGarbledReconstructionLimit = 64

var (
	garbledLegacyStyleRE    = regexp.MustCompile(`\\(bf|rm|it|sf|tt|pmb)\b`)
	garbledCleanMathRE      = regexp.MustCompile(`\\(mathrm|mathbf|mathit|mathsf|mathtt|text|textit|textbf)\b`)
	garbledGreekRE          = regexp.MustCompile(`\\alpha|α`)
	garbledDoubleAlphaRE    = regexp.MustCompile(`\{\s*\{\s*(\\alpha|α)\s*\}\s*\}`)
	garbledUpperDuplicateRE = regexp.MustCompile(`\b([A-Z]{2,})\s+([A-Z]{2,})\b`)
	garbledLeadingGlueRE    = regexp.MustCompile(`\b([A-Z])([A-Z][a-z]{3,})\b`)
	garbledFormulaRE        = regexp.MustCompile(`(?s)\$\$.*?\$\$|\$(\\.|[^$\\])*?\$`)
	garbledResponseFormat   = map[string]any{
		"type": "json_schema",
		"json_schema": map[string]any{
			"name":   "garbled_reconstruction_response",
			"strict": true,
			"schema": map[string]any{
				"type": "object", "additionalProperties": false,
				"properties": map[string]any{"translated_text": map[string]string{"type": "string"}},
				"required":   []string{"translated_text"},
			},
		},
	}
)

type garbledStructuredGenerator interface {
	GenerateStructured(ctx context.Context, system, user string, temperature float64, responseFormat any) (string, error)
}

type garbledCandidate struct {
	index int
	item  Item
}

type garbledOutcome struct {
	index  int
	text   string
	issues []Issue
}

// runGarbledReconstruction mirrors LeePDF's post-primary reconstruction phase.
// OCR imports do not retain LeePDF formula maps, so this applies only source-text
// candidates available from the current normalized OCR blocks.
func runGarbledReconstruction(ctx context.Context, generator Generator, items []Item, result *Result) {
	if !garbledReconstructionEnabled() || ctx.Err() != nil || generator == nil || result == nil {
		return
	}
	candidates := make([]garbledCandidate, 0)
	for index, item := range items {
		if index >= len(result.Targets) {
			continue
		}
		if shouldReconstructGarbled(item, result.Targets[index], result.Issues[index]) {
			candidates = append(candidates, garbledCandidate{index: index, item: item})
		}
	}
	if len(candidates) == 0 {
		return
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].item.ItemID < candidates[j].item.ItemID })
	limit := garbledReconstructionLimit()
	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	workers := min(12, len(candidates))
	jobs := make(chan garbledCandidate)
	outcomes := make(chan garbledOutcome, len(candidates))
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for candidate := range jobs {
				if ctx.Err() != nil {
					continue
				}
				text := reconstructGarbledItem(ctx, generator, candidate.item)
				if text == "" {
					continue
				}
				source, tokens := ProtectDirectMath(candidate.item.Source)
				source, tokens = protectTerms(source, tokens, candidate.item.Terms)
				text, _, _ = Restore(text, tokens)
				issues := Review(candidate.item.Source, source, text, tokens, candidate.item)
				if !hasError(issues) {
					outcomes <- garbledOutcome{index: candidate.index, text: strings.TrimSpace(text), issues: issues}
				}
			}
		}()
	}
	for _, candidate := range candidates {
		jobs <- candidate
	}
	close(jobs)
	group.Wait()
	close(outcomes)
	for outcome := range outcomes {
		result.Targets[outcome.index] = outcome.text
		result.Issues[outcome.index] = outcome.issues
	}
}

func garbledReconstructionEnabled() bool {
	defaultEnabled := false
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_REPAIR_PROFILE"))) {
	case "quality", "strict", "full":
		defaultEnabled = true
	}
	value := strings.ToLower(strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_GARBLED_RECONSTRUCTION")))
	switch value {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return defaultEnabled
	}
}

func shouldReconstructGarbled(item Item, translated string, issues []Issue) bool {
	source := strings.TrimSpace(item.Source)
	if len([]rune(source)) < 80 || shouldSkipGarbledRole(item.Role) {
		return false
	}
	lowQuality := strings.TrimSpace(translated) == "" || hasError(issues)
	formulas := garbledFormulaRE.FindAllString(source, -1)
	if len(formulas) > 0 {
		badFormula := false
		for _, formula := range formulas {
			if formulaLooksGarbled(formula) {
				badFormula = true
				break
			}
		}
		if badFormula && lowQuality {
			return true
		}
		// LeePDF treats a mapped formula as a separate content identity. The
		// OCR path has no formula map, so do not reconstruct ordinary math spans.
		return false
	}
	if formulaLooksGarbled(source) && lowQuality {
		return true
	}
	if lowQuality && looksLikeDuplicateGluedText(source) {
		return true
	}
	if strings.TrimSpace(translated) == "" && len([]rune(source)) >= 120 {
		return true
	}
	return false
}

func shouldSkipGarbledRole(role string) bool {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "formula", "code", "url", "email", "reference", "bibliography":
		return true
	default:
		return false
	}
}

func looksLikeDuplicateGluedText(text string) bool {
	if strings.Contains(text, "ASMALL") || strings.Contains(text, "ABIG") || garbledLeadingGlueRE.MatchString(text) {
		return true
	}
	for _, match := range garbledUpperDuplicateRE.FindAllStringSubmatch(text, -1) {
		if len(match) == 3 && match[1] == match[2] {
			return true
		}
	}
	return false
}

func formulaLooksGarbled(formula string) bool {
	legacy := len(garbledLegacyStyleRE.FindAllString(formula, -1))
	clean := len(garbledCleanMathRE.FindAllString(formula, -1))
	greek := len(garbledGreekRE.FindAllString(formula, -1))
	doubleAlpha := len(garbledDoubleAlphaRE.FindAllString(formula, -1))
	if greek >= 8 || legacy >= 2 || doubleAlpha >= 2 {
		return true
	}
	if clean >= 3 && legacy == 0 && greek <= 2 && doubleAlpha == 0 {
		return false
	}
	return len([]rune(formula)) >= 180 && greek >= 4
}

func garbledReconstructionLimit() int {
	raw := strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_GARBLED_MAX_CANDIDATES"))
	if raw == "" {
		return defaultGarbledReconstructionLimit
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return defaultGarbledReconstructionLimit
	}
	return max(0, value)
}

func reconstructGarbledItem(ctx context.Context, generator Generator, item Item) string {
	source, _ := ProtectDirectMath(item.Source)
	formulaHints := make([]string, 0, 12)
	for _, formula := range garbledFormulaRE.FindAllString(item.Source, -1) {
		formula = strings.TrimSpace(formula)
		if formula != "" && !formulaLooksGarbled(formula) && len([]rune(formula)) <= 80 {
			formulaHints = append(formulaHints, formula)
			if len(formulaHints) == 12 {
				break
			}
		}
	}
	payload, err := json.Marshal(map[string]any{
		"item_id": item.ItemID, "source_text": source, "formula_hints": formulaHints,
	})
	if err != nil {
		return ""
	}
	system := "你负责修复被 OCR 破坏的科技文本块，并把它翻译成流畅的简体中文。\n" +
		"输入里可能有重复片段、断行错乱，以及伪造的 LaTeX 公式噪声。\n" +
		"保守地还原原意。\n不要提及 OCR 有损坏。\n" +
		"只返回一个 JSON 对象，键名为 translated_text。\ntranslated_text 里只放纯中文文本。\n" +
		"不要输出 \\bf、\\mathbf、\\mathrm 这类 LaTeX 命令。\n" +
		"如果材料名或符号是明确的，用自然的科学写法保留，例如 alpha-Al2O3 或 α-Al2O3。\n"
	user := string(payload)
	requestCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	var raw string
	if structured, ok := generator.(garbledStructuredGenerator); ok {
		raw, err = structured.GenerateStructured(requestCtx, system, user, 0, garbledResponseFormat)
		if err != nil && requestCtx.Err() == nil {
			raw, err = generator.Generate(requestCtx, system, user, 0)
		}
	} else {
		raw, err = generator.Generate(requestCtx, system, user, 0)
	}
	if err != nil {
		return ""
	}
	var response struct {
		TranslatedText string `json:"translated_text"`
	}
	if json.Unmarshal([]byte(extractJSONObject(raw)), &response) != nil {
		return ""
	}
	return strings.TrimSpace(response.TranslatedText)
}
