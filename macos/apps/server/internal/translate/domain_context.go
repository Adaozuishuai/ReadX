package translate

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

const DomainContextPromptVersion = "domain-context-v1"

type DomainContext struct {
	Domain              string `json:"domain"`
	Summary             string `json:"summary"`
	TranslationGuidance string `json:"translation_guidance"`
}

func InferDocumentDomain(ctx context.Context, generator Generator, preview string) (DomainContext, error) {
	preview = strings.TrimSpace(preview)
	if preview == "" {
		return DomainContext{}, nil
	}
	schema := map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "domain_context_response", "strict": true, "schema": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]string{"domain": "string", "summary": "string", "translation_guidance": "string"}, "required": []string{"domain", "summary", "translation_guidance"}}}}
	system := strings.Join([]string{
		"你需要根据 PDF 前两页内容判断文档所属的学术或技术领域，并为后续整本书翻译生成领域指导。",
		"", "只返回严格 JSON，且必须且只能包含以下键：", "- domain", "- summary", "- translation_guidance", "",
		"规则：", "- `domain`：简短领域标签，例如“计算化学”“材料科学”“机器学习”。", "- `summary`：一句简短中文，总结主题与文档风格。",
		"- `translation_guidance`：一段紧凑的中文翻译指导，供后续翻译模型使用。", "- 指导内容要聚焦于：学科术语、行文风格、记号习惯、公式/符号处理方式、应保留的英文缩写类型。",
		"- 如果文档包含大量数学、化学式、变量、上下标或单位幂次，指导中应明确提醒后续翻译模型先理解语义，再主动用 `$...$` 包裹应作为公式显示的部分。",
		"- 不要输出 markdown，不要输出代码块，不要输出额外解释。", "- 除非文本确实无法辨认，否则不要强调不确定性。",
	}, "\n")
	task := `请阅读这个 PDF 的前两页，判断其所属的学术或技术领域。

然后为后续整本书翻译写一段简洁的中文指导。

这段指导至少应帮助翻译模型做到：
- 保持领域术语稳定一致
- 在需要时保留英文缩写、模型名、符号、命令、文件名和代码
- 使用自然、准确、符合学术语体的中文
- 避免过度意译或无依据扩写
- 优先采用该领域常见的中文术语
- 当内容里出现数学表达式、变量、化学式、上下标、单位幂次时，先理解语义，再主动用 $...$ 包裹应作为公式显示的部分`
	userBody, _ := json.Marshal(struct {
		Task        string `json:"task"`
		PreviewText string `json:"preview_text"`
	}{task, preview})
	user := string(userBody)
	var content string
	var err error
	if timed, ok := generator.(termPrescanTimedStructuredGenerator); ok {
		content, err = timed.GenerateStructuredWithTimeout(ctx, system, user, 0, 60*time.Second, schema)
	} else if structured, ok := generator.(termPrescanStructuredGenerator); ok {
		content, err = structured.GenerateStructured(ctx, system, user, 0, schema)
	} else if timed, ok := generator.(timeoutGenerator); ok {
		content, err = timed.GenerateWithTimeout(ctx, system, user, 0, 60*time.Second)
	} else {
		content, err = generator.Generate(ctx, system, user, 0)
	}
	if err != nil {
		return DomainContext{}, err
	}
	var value DomainContext
	if err = parseStructuredJSON(content, &value); err != nil {
		return DomainContext{}, err
	}
	value.Domain = strings.TrimSpace(value.Domain)
	value.Summary = strings.TrimSpace(value.Summary)
	value.TranslationGuidance = strings.TrimSpace(value.TranslationGuidance)
	return value, nil
}

func RenderDomainGuidance(domain DomainContext) string {
	parts := []string{}
	if strings.TrimSpace(domain.Domain) != "" {
		parts = append(parts, "学科领域："+strings.TrimSpace(domain.Domain))
	}
	if strings.TrimSpace(domain.Summary) != "" {
		parts = append(parts, "全书主题与文风："+strings.TrimSpace(domain.Summary))
	}
	if strings.TrimSpace(domain.TranslationGuidance) != "" {
		parts = append(parts, "全书领域翻译指导："+strings.TrimSpace(domain.TranslationGuidance))
	}
	return strings.Join(parts, "\n")
}
