package translate

import (
	"encoding/json"
	"regexp"
	"strings"
)

var (
	structuredJSONFenceRE     = regexp.MustCompile("(?is)^```(?:json)?\\s*|\\s*```$")
	structuredUnquotedKeyRE   = regexp.MustCompile(`([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)`)
	structuredTrailingCommaRE = regexp.MustCompile(`,(\s*[}\]])`)
	structuredLineValueRE     = regexp.MustCompile(`^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*$`)
	structuredUnicodeEscapeRE = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)
)

// parseStructuredJSON follows LeePDF's tolerant structured-output parser:
// it accepts fenced/comment-wrapped JSON, model-added trailing commas,
// unquoted object keys and LaTeX commands whose backslashes were not escaped.
func parseStructuredJSON(content string, target any) error {
	text := strings.TrimSpace(content)
	text = structuredJSONFenceRE.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	if start := strings.IndexByte(text, '{'); start >= 0 {
		if end := strings.LastIndexByte(text, '}'); end > start {
			text = text[start : end+1]
		}
	}
	if err := json.Unmarshal([]byte(text), target); err == nil {
		return nil
	}
	text = escapeStructuredLatexBackslashes(text)
	text = strings.Map(func(r rune) rune {
		if r < 0x20 && r != '\n' && r != '\r' && r != '\t' {
			return -1
		}
		return r
	}, text)
	text = structuredUnquotedKeyRE.ReplaceAllString(text, `${1}"${2}"${3}`)
	text = structuredTrailingCommaRE.ReplaceAllString(text, `${1}`)
	if err := json.Unmarshal([]byte(text), target); err == nil {
		return nil
	}
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(content), "\n") {
		line = strings.TrimSpace(strings.Trim(line, "`"))
		if match := structuredLineValueRE.FindStringSubmatch(line); len(match) == 3 {
			fields[match[1]] = strings.Trim(strings.TrimSpace(match[2]), `",`)
		}
	}
	if len(fields) > 0 {
		encoded, err := json.Marshal(fields)
		if err == nil {
			return json.Unmarshal(encoded, target)
		}
	}
	return json.Unmarshal([]byte(text), target)
}

func escapeStructuredLatexBackslashes(text string) string {
	var out strings.Builder
	out.Grow(len(text) + 16)
	for index := 0; index < len(text); {
		if text[index] != '\\' || index+1 >= len(text) {
			out.WriteByte(text[index])
			index++
			continue
		}
		next := text[index+1]
		if next == '"' || next == '\\' || next == '/' {
			out.WriteString(text[index : index+2])
			index += 2
			continue
		}
		if next == 'u' && index+6 <= len(text) && structuredUnicodeEscapeRE.MatchString(text[index+2:index+6]) {
			out.WriteString(text[index : index+6])
			index += 6
			continue
		}
		if strings.ContainsRune("bfnrt", rune(next)) {
			after := byte(0)
			if index+2 < len(text) {
				after = text[index+2]
			}
			if after < 'a' || after > 'z' {
				out.WriteString(text[index : index+2])
				index += 2
				continue
			}
		}
		out.WriteString(`\\`)
		index++
	}
	return out.String()
}
