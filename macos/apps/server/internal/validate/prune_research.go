package validate

import (
	"fmt"
	"strings"
)

// Recover individual evidence failures after model repairs without accepting
// unsupported claims, shortening their quotes, or discarding valid sections.
func pruneResearchNotes(kind string, obj map[string]any, source string, fieldValid func(any) bool) *PruneResult {
	sections, ok := obj["sections"].([]any)
	if !ok || len(sections) == 0 {
		return nil
	}
	demoted := []string{}
	for _, raw := range sections {
		section, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(stringValue(section["title"])) == "" {
			return nil
		}
		fields, ok := section["fields"].([]any)
		if !ok || len(fields) == 0 {
			return nil
		}
		for i, rawField := range fields {
			field, ok := rawField.(map[string]any)
			if !ok || strings.TrimSpace(stringValue(field["k"])) == "" {
				return nil
			}
			if fieldValid(field) {
				continue
			}
			fields[i] = map[string]any{"k": field["k"], "v": "当前文本无法核实", "page": nil, "excerpt": nil}
			demoted = append(demoted, fmt.Sprintf("%s / %s：证据未匹配，已标为未知", section["title"], field["k"]))
		}
	}
	if raw, exists := obj["formulas"]; exists {
		formulas, ok := raw.([]any)
		if !ok {
			return nil
		}
		kept := []any{}
		for i, rawFormula := range formulas {
			formula, ok := rawFormula.(map[string]any)
			if ok && researchFormulaValid(formula, source) {
				kept = append(kept, formula)
				continue
			}
			demoted = append(demoted, fmt.Sprintf("公式 %d：无法可靠核验，未保留转写", i+1))
		}
		obj["formulas"] = kept
	}
	if err := ValidateGenerated(kind, mustJSON(obj), source); err != nil {
		return nil
	}
	return &PruneResult{Value: prettyJSON(obj), Demoted: demoted}
}

func researchFormulaValid(formula map[string]any, source string) bool {
	latex := stringValue(formula["latex"])
	if strings.TrimSpace(latex) == "" || strings.TrimSpace(stringValue(formula["explanation"])) == "" {
		return false
	}
	for _, r := range latex {
		if r < 0x20 {
			return false
		}
	}
	field, ok := toField(map[string]any{"k": "公式出处", "v": "公式", "page": formula["page"], "excerpt": formula["excerpt"]})
	if !ok || field.Page == nil || field.Excerpt == nil {
		return false
	}
	return ValidateExtraction(ExperimentExtraction{Dataset: []Field{field}}, source) == nil
}
