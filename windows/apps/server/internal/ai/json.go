package ai

import "strings"

// extractJSONObject 容忍模型在 JSON 外裹一层 ```json 围栏或前后解说。
// 导出给其它「模型只回 JSON」的调用方复用，避免到处复制一份查找逻辑。
func extractJSONObject(raw string) string {
	return ExtractJSONObject(raw)
}

// ExtractJSONObject 找出文本里第一个 { 到最后一个 } 之间的内容。
func ExtractJSONObject(raw string) string {
	text := strings.TrimSpace(raw)
	if start := strings.Index(text, "{"); start >= 0 {
		if end := strings.LastIndex(text, "}"); end > start {
			return text[start : end+1]
		}
	}
	return text
}
