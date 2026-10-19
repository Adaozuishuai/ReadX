package ai

import (
	"encoding/json"
	"fmt"
	"strings"

	"cbctv2/server/internal/validate"
)

type readingEvidence struct {
	ID   string `json:"id"`
	Page int    `json:"page"`
	Text string `json:"text"`
}

// Snippets are contiguous slices from one physical page, with overlapping
// boundaries. Their text is never reconstructed by the model.
func readingEvidenceCatalog(source string) []readingEvidence {
	selected := SelectWithMeta(source, "", "全文", 50000)
	out := []readingEvidence{}
	for _, page := range validate.Pages(selected.Text) {
		runes := []rune(page.Text)
		for start, index := 0, 1; start < len(runes); start, index = start+750, index+1 {
			end := min(start+900, len(runes))
			text := strings.TrimSpace(string(runes[start:end]))
			if len([]rune(validate.Normalized(text))) >= 8 {
				out = append(out, readingEvidence{ID: fmt.Sprintf("p%d-b%d", page.Number, index), Page: page.Number, Text: text})
			}
			if end == len(runes) {
				break
			}
		}
	}
	return out
}

func bindReadingEvidence(value string, catalog []readingEvidence) (string, error) {
	var body map[string]any
	if err := json.Unmarshal([]byte(value), &body); err != nil {
		return value, err
	}
	byID := map[string]readingEvidence{}
	for _, item := range catalog {
		byID[item.ID] = item
	}
	bind := func(raw any) error {
		item, ok := raw.(map[string]any)
		if !ok {
			return nil
		}
		rawID, exists := item["evidenceID"]
		if !exists {
			return nil
		}
		delete(item, "evidenceID")
		if rawID == nil || rawID == "" {
			return nil
		}
		id, ok := rawID.(string)
		if !ok {
			return fmt.Errorf("evidenceID 必须为目录编号字符串或 null")
		}
		quote, ok := byID[id]
		if !ok {
			return fmt.Errorf("原文片段编号 %s 不存在，请从证据目录选择；不得编造编号", id)
		}
		item["page"], item["excerpt"] = quote.Page, quote.Text
		return nil
	}
	sections, _ := body["sections"].([]any)
	for _, raw := range sections {
		section, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fields, _ := section["fields"].([]any)
		for _, field := range fields {
			if err := bind(field); err != nil {
				return value, err
			}
		}
	}
	formulas, _ := body["formulas"].([]any)
	for _, formula := range formulas {
		if err := bind(formula); err != nil {
			return value, err
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return value, err
	}
	return string(encoded), nil
}
