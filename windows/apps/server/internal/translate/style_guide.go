package translate

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"
)

const StyleGuidePromptVersion = "style-guide-v1"

type documentStyleRule struct {
	Category string `json:"category"`
	Rule     string `json:"rule"`
	Example  string `json:"example"`
}

type documentStyleResponse struct {
	Register       string              `json:"register"`
	Audience       string              `json:"audience"`
	Rules          []documentStyleRule `json:"rules"`
	DoNotTranslate []string            `json:"do_not_translate"`
	Notes          string              `json:"notes"`
}

// GenerateDocumentStyle mirrors RetainPDF's one-shot terms+style preparation.
// It freezes book-wide advice and returns a deterministic prompt prefix.
func GenerateDocumentStyle(ctx context.Context, generator Generator, items []Item, terms []Term, domainContext DomainContext, userGlossary ...[]Term) (string, error) {
	schema := map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "style_guide_response", "strict": true, "schema": map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"register": map[string]string{"type": "string"}, "audience": map[string]string{"type": "string"},
			"rules":            map[string]any{"type": "array", "items": map[string]any{"type": "object", "additionalProperties": false, "properties": map[string]string{"category": "string", "rule": "string", "example": "string"}, "required": []string{"category", "rule", "example"}}},
			"do_not_translate": map[string]any{"type": "array", "items": map[string]string{"type": "string"}}, "notes": map[string]string{"type": "string"},
		}, "required": []string{"register", "audience", "rules", "do_not_translate", "notes"}}}}
	system := strings.ReplaceAll(`你是学术出版社的译审，负责在一本译著开译之前制定全书统一的翻译风格指南（译入语：<<TARGET_LANGUAGE>>）。

只返回严格 JSON，且只包含以下键：
- register：一句话描述全书应采用的语体（例如「规范、简洁的学术书面语」）。
- audience：一句话描述目标读者。
- rules：数组，每项 {"category": "...", "rule": "...", "example": "..."}。只写针对这份文档的具体规则（例如本书反复出现的句式、记号或称谓应如何处理、哪些专名保留原文），不要重复已经给出的通用规范，不超过 12 条。category 取 terminology / cross_reference / names / numbers / do_not_translate / punctuation / syntax / other 之一。
- do_not_translate：数组，列出本书中应保留原文不译的具体名称（软件、代码标识符、数据集、期刊缩写等），没有就给空数组。
- notes：一句补充说明，没有就给空字符串。

不要输出 markdown、代码块或额外解释。`, "<<TARGET_LANGUAGE>>", "简体中文")
	baseline := []string{
		"同一术语全书只用一种译法；给出的术语表译法优先于自行翻译。",
		"交叉引用按中文体例改写，编号保持原样：Figure 3.2 → 图 3.2，Table 1 → 表 1，Eq. (5) → 式(5)，Section 2.3 → 2.3 节，Chapter 4 → 第 4 章。",
		"外国人名采用通行译名，名与姓之间用间隔号「·」；无通行译名的人名保留原文。",
		"年代统一写成「20 世纪 60 年代」的形式，全书一致。",
		"数值、单位、量符号和科学计数法照原文保留，不得改动数值；数字与单位之间按国标留空格。",
		"代码、变量名、函数名、命令、文件名、软件名、数据集名一律保留原文，不翻译。",
		"参考文献条目照录原文，不翻译。",
		"不要擅自添加译者注；确需说明时，译者注放在括号内并以「——译者注」结尾。",
		"中文行文使用全角标点；省略号用「……」，破折号用「——」；数字和拉丁字母保持半角。",
	}
	keyTerms := make([]map[string]string, 0, 40)
	styleSegments := collectPrescanSegments(items)
	orderedTerms := append([]Term(nil), terms...)
	if len(userGlossary) > 0 {
		for _, term := range userGlossary[0] {
			if termFrequency(term, styleSegments) > 0 {
				orderedTerms = append(orderedTerms, term)
			}
		}
	} else {
		for _, item := range items {
			orderedTerms = append(orderedTerms, item.Terms...)
		}
	}
	eligibleTerms := make([]Term, 0, len(orderedTerms))
	seenTerms := map[string]bool{}
	for _, term := range orderedTerms {
		if term.Treatment == "free" || term.Treatment == "drop" {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(term.Source)) + "\x00" + strings.ToLower(strings.TrimSpace(term.Target))
		if term.Source == "" || term.Target == "" || seenTerms[key] {
			continue
		}
		seenTerms[key] = true
		eligibleTerms = append(eligibleTerms, term)
	}
	orderedTerms = eligibleTerms
	frequency := func(term Term) int {
		return termFrequency(term, styleSegments)
	}
	sort.SliceStable(orderedTerms, func(i, j int) bool {
		left, right := frequency(orderedTerms[i]), frequency(orderedTerms[j])
		if left != right {
			return left > right
		}
		return strings.ToLower(orderedTerms[i].Source) < strings.ToLower(orderedTerms[j].Source)
	})
	for _, term := range orderedTerms {
		if len(keyTerms) >= 40 {
			break
		}
		if term.Source != "" && term.Target != "" {
			keyTerms = append(keyTerms, map[string]string{"source": term.Source, "target": term.Target})
		}
	}
	var sample strings.Builder
	sampleRuneCount := 0
	for _, item := range styleSegments {
		text := item.Source
		if sampleRuneCount >= 6000 {
			break
		}
		remaining := 6000 - sampleRuneCount
		textRunes := []rune(text)
		if len(textRunes) > remaining {
			textRunes = textRunes[:remaining]
		}
		sample.WriteString(string(textRunes))
		sample.WriteByte('\n')
		sampleRuneCount += len(textRunes) + 1
	}
	payload, _ := json.Marshal(map[string]any{
		"task":           "根据 domain（领域识别结果）、rule_profile（翻译规则档）、key_terms（全书术语预扫结果）和 sample_text（正文样本），为这本书制定风格指南。baseline_rules 里的通用规范（首现括注、交叉引用、间隔号、年代、不译项、参考文献照录、译者注格式）已经确定，不要重复，也不要与之冲突；你只需补充本书特有的规则。",
		"domain":         map[string]string{"domain": domainContext.Domain, "summary": domainContext.Summary, "translation_guidance": domainContext.TranslationGuidance},
		"rule_profile":   map[string]string{"name": "general_sci", "text": "科技论文默认规则档：\n- 翻译正常散文、段落正文、小标题、条目说明、图表题注和简短的技术性标题。\n- 字面代码、字面命令、输入卡片、坐标行、赋值语句、shell 示例，以及独立成行的参数或示例行，保持原样。\n- 如果一个块以命令或示例前缀开头、随后转为说明性散文，保留字面前缀，翻译说明部分。\n- 对\"跳过翻译\"要保守：成句的长段英文正文通常应当翻译。\n- 前几页的元信息片段——作者行、单位署名、编辑日期，以及孤立出现的短连接词（例如 'and'）——通常不翻译。"},
		"baseline_rules": baseline, "key_terms": keyTerms, "sample_text": sample.String(),
	})
	var content string
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if timed, ok := generator.(termPrescanTimedStructuredGenerator); ok {
			content, err = timed.GenerateStructuredWithTimeout(ctx, system, string(payload), 0, 90*time.Second, schema)
		} else if structured, ok := generator.(termPrescanStructuredGenerator); ok {
			content, err = structured.GenerateStructured(ctx, system, string(payload), 0, schema)
		} else if timed, ok := generator.(timeoutGenerator); ok {
			content, err = timed.GenerateWithTimeout(ctx, system, string(payload), 0, 90_000_000_000)
		} else {
			content, err = generator.Generate(ctx, system, string(payload), 0)
		}
		if err != nil {
			continue
		}
		var parsed documentStyleResponse
		if err = parseStructuredJSON(content, &parsed); err == nil {
			return renderDocumentStyle(parsed, baseline), nil
		}
	}
	return renderDocumentStyle(documentStyleResponse{}, baseline), err
}

func termFrequency(term Term, segments []Item) int {
	if strings.HasPrefix(term.Note, "document_term_prescan:") {
		return prescanFrequency(term.Source, segments)
	}
	count := 0
	for _, segment := range segments {
		for _, location := range termLocations(segment.Source, term) {
			if termContextMatches(segment.Source, term, location[0], location[1]) {
				count++
			}
		}
	}
	return count
}

func renderDocumentStyle(style documentStyleResponse, baseline []string) string {
	lines := []string{"Style guide (frozen for this book; follow it in every block):"}
	if value := strings.TrimSpace(style.Register); value != "" {
		lines = append(lines, "- 语体："+limitRunes(value, 200))
	}
	if value := strings.TrimSpace(style.Audience); value != "" {
		lines = append(lines, "- 读者："+limitRunes(value, 200))
	}
	for _, rule := range baseline {
		lines = append(lines, "- "+rule)
	}
	valid := map[string]bool{"terminology": true, "cross_reference": true, "names": true, "numbers": true, "do_not_translate": true, "punctuation": true, "syntax": true, "other": true}
	count := 0
	for _, rule := range style.Rules {
		rule.Rule = strings.Join(strings.Fields(rule.Rule), " ")
		if rule.Rule == "" || count >= 12 {
			continue
		}
		if !valid[strings.ToLower(rule.Category)] {
			rule.Category = "other"
		}
		line := "- " + limitRunes(rule.Rule, 400)
		if ex := strings.Join(strings.Fields(rule.Example), " "); ex != "" {
			line += " 例：" + limitRunes(ex, 200)
		}
		lines = append(lines, line)
		count++
	}
	seen := map[string]bool{}
	keep := []string{}
	for _, item := range style.DoNotTranslate {
		item = strings.Join(strings.Fields(item), " ")
		if item != "" && !seen[item] && len(keep) < 40 {
			seen[item] = true
			keep = append(keep, limitRunes(item, 80))
		}
	}
	if len(keep) > 0 {
		lines = append(lines, "- 本书保留原文不译："+strings.Join(keep, "、"))
	}
	return strings.Join(lines, "\n")
}

func limitRunes(value string, max int) string {
	r := []rune(value)
	if len(r) > max {
		return string(r[:max])
	}
	return value
}
