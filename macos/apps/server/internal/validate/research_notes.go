package validate

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func ValidateResearchNotes(value, source string) error {
	canonical, err := NormalizeJSONObject(value)
	if err != nil {
		return fmt.Errorf("精读记录不是合法 JSON: %w", err)
	}
	var notes struct {
		Sections []struct {
			Title  string  `json:"title"`
			Fields []Field `json:"fields"`
		} `json:"sections"`
		Formulas []struct {
			Latex       string  `json:"latex"`
			Explanation string  `json:"explanation"`
			Page        *int    `json:"page"`
			Excerpt     *string `json:"excerpt"`
		} `json:"formulas"`
	}
	if err := json.Unmarshal([]byte(canonical), &notes); err != nil {
		var typeError *json.UnmarshalTypeError
		if errors.As(err, &typeError) {
			return fmt.Errorf("精读字段类型错误：%s 需要 %s，实际为 %s", typeError.Field, typeError.Type.String(), typeError.Value)
		}
		return fmt.Errorf("精读记录不是合法 JSON: %w", err)
	}
	for i, formula := range notes.Formulas {
		if strings.TrimSpace(formula.Latex) == "" {
			return fmt.Errorf("公式 %d 的 latex 为空；不能可靠转写时请省略该公式", i+1)
		}
		for _, r := range formula.Latex {
			if r < 0x20 {
				return fmt.Errorf("公式 %d 的 LaTeX 含控制字符；JSON 中的 LaTeX 反斜杠必须双写，latex 使用单行字符串", i+1)
			}
		}
		if formula.Page == nil || formula.Excerpt == nil {
			return fmt.Errorf("公式 %d 缺少原文页码和摘录，不能可靠转写时请省略", i+1)
		}
		if err := ValidateExtraction(ExperimentExtraction{Dataset: []Field{{K: fmt.Sprintf("公式 %d 出处", i+1), V: "公式", Page: formula.Page, Excerpt: formula.Excerpt}}}, source); err != nil {
			return err
		}
	}
	if len(notes.Sections) == 0 {
		return fmt.Errorf("精读记录缺少 sections")
	}
	fields := []Field{}
	for _, section := range notes.Sections {
		if strings.TrimSpace(section.Title) == "" || len(section.Fields) == 0 {
			return fmt.Errorf("每节必须有标题和事实条目")
		}
		for _, field := range section.Fields {
			if strings.TrimSpace(field.K) == "" || strings.TrimSpace(field.V) == "" {
				return fmt.Errorf("事实条目的 k/v 不得为空")
			}
			fields = append(fields, field)
		}
	}
	return ValidateExtraction(ExperimentExtraction{Dataset: fields}, source)
}
