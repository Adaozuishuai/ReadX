package httpapi

import (
	"regexp"
	"strings"
)

var paperSuperscript = regexp.MustCompile(`\$\s*\^\s*\{\s*([^{}]+?)\s*\}\s*\$|\^\s*\{\s*([^{}]+?)\s*\}`)
var paperTitlePunctuation = regexp.MustCompile(`\s+([:;,.!?])`)

func normalizePaperTitle(value string) string {
	superscript := strings.NewReplacer("0", "⁰", "1", "¹", "2", "²", "3", "³", "4", "⁴", "5", "⁵", "6", "⁶", "7", "⁷", "8", "⁸", "9", "⁹")
	value = paperSuperscript.ReplaceAllStringFunc(value, func(match string) string {
		parts := paperSuperscript.FindStringSubmatch(match)
		body := parts[1]
		if body == "" {
			body = parts[2]
		}
		if body != "" && strings.Trim(body, "0123456789") == "" {
			return superscript.Replace(body)
		}
		return "^" + body
	})
	value = strings.Join(strings.Fields(value), " ")
	return paperTitlePunctuation.ReplaceAllString(value, "$1")
}
