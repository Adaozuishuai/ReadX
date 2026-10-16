package validate

import (
	"encoding/json"
	"fmt"
	"strings"
)

func ValidateResearchNotes(value, source string) error {
	var notes struct {
		Sections []struct {
			Title  string  `json:"title"`
			Fields []Field `json:"fields"`
		} `json:"sections"`
	}
	if err := json.Unmarshal([]byte(stripFence(value)), &notes); err != nil {
		return fmt.Errorf("精读记录不是合法 JSON: %w", err)
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
