package validate

import (
	"fmt"
	"strings"
)

// IdeaEvidence 与 TS IdeaEvidence 对应。
type IdeaEvidence struct {
	ID         string  `json:"id"`
	PaperKey   string  `json:"paperKey"`
	PaperTitle string  `json:"paperTitle"`
	Origin     string  `json:"origin"`
	Page       *int    `json:"page"`
	Excerpt    string  `json:"excerpt"`
	VerifiedAt *string `json:"verifiedAt"`
}

// OriginPaperText 是唯一需要逐字摘录背书的来源标签。
const OriginPaperText = "论文原文"

// ValidateIdeaEvidence 与 TS validateIdeaEvidence 逐条对应。
//
// 关键取舍（继承自 Swift）：只有 origin === '论文原文' 才校验。
// AI 解释 / 研究建议 / 个人笔记本来就不是原文，强制逐字摘录只会逼模型编造页码；
// 它们的可信度由 origin 标签本身披露。
func ValidateIdeaEvidence(evidence IdeaEvidence, source string) error {
	if evidence.Origin != OriginPaperText {
		return nil
	}
	var pageText string
	pageOK := false
	if evidence.Page != nil {
		for _, p := range Pages(source) {
			if p.Number == *evidence.Page {
				pageText = p.Text
				pageOK = true
				break
			}
		}
	}
	ok := evidence.Page != nil && pageOK &&
		len([]rune(Normalized(evidence.Excerpt))) >= 8 &&
		strings.Contains(Normalized(pageText), Normalized(evidence.Excerpt))
	if !ok {
		return fmt.Errorf("原文证据须包含有效页码和该页至少 8 个非空白字符的逐字摘录。")
	}
	return nil
}
