package validate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// NormalizeJSONObject removes transport wrappers without inventing or dropping
// object fields. A complete object may have redundant closing brackets after it;
// a second answer, unfinished object or malformed field must be repaired upstream.
func NormalizeJSONObject(value string) (string, error) {
	text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "\ufeff"))
	for depth := 0; depth < 4; depth++ {
		if strings.HasPrefix(text, "```") {
			newline := strings.IndexByte(text, '\n')
			if newline < 0 || !strings.HasSuffix(text, "```") {
				return "", fmt.Errorf("JSON 代码块未完整结束")
			}
			label := strings.TrimSpace(text[3:newline])
			if label != "" && !strings.EqualFold(label, "json") {
				return "", fmt.Errorf("预期 JSON 代码块")
			}
			text = strings.TrimSpace(text[newline+1 : len(text)-3])
		}
		decoder := json.NewDecoder(strings.NewReader(text))
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return "", fmt.Errorf("JSON 语法不完整或无效: %w", err)
		}
		tail := strings.TrimSpace(text[decoder.InputOffset():])
		if tail != "" {
			// Do not take the first object out of multiple answers or trailing prose.
			if len(raw) == 0 || raw[0] != '{' || strings.Trim(tail, "]} \t\r\n") != "" {
				return "", fmt.Errorf("JSON 结束后还有额外内容，请仅输出一个完整对象")
			}
		}
		if len(raw) == 0 {
			return "", fmt.Errorf("JSON 输出为空")
		}
		switch raw[0] {
		case '{':
			var compact bytes.Buffer
			if err := json.Compact(&compact, raw); err != nil {
				return "", err
			}
			return compact.String(), nil
		case '"':
			var inner string
			if err := json.Unmarshal(raw, &inner); err != nil {
				return "", err
			}
			text = strings.TrimSpace(inner)
		case '[':
			var entries []json.RawMessage
			if err := json.Unmarshal(raw, &entries); err != nil {
				return "", err
			}
			if len(entries) != 1 {
				return "", fmt.Errorf("精读输出必须是单个 JSON 对象，不能是多个条目的数组")
			}
			text = strings.TrimSpace(string(entries[0]))
		default:
			return "", fmt.Errorf("精读输出必须是 JSON 对象")
		}
	}
	return "", fmt.Errorf("JSON 包裹层级过多，请只输出一个对象")
}
