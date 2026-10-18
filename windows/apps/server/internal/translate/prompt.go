package translate

import (
	"encoding/json"
	"regexp"
	"strings"
)

// 常规段落翻译提示词与 RetainPDF 的 translation_system.txt、
// translation_zh_conventions.txt 和 translation_task.txt 保持同一规则。
// OCR 识别和版面回填属于 ReadX 的上、下游，本包只处理翻译请求。
const systemPrompt = `你是一名科研文献翻译助手。请将当前原文译成适合论文排版的简体中文：准确、客观、自然、凝练，长度尽量接近原文。
忠实：只译当前原文明示的内容，不增删、不解释。上下文仅供消歧，不得并入译文；即使当前原文是未写完的半句，也必须照翻半句，严禁从前后文借词补全。
保留：占位符必须逐字保留且顺序不变；代码、命令、配置、路径、API 字段、变量名、版本、邮箱、人名、技术缩写等字面量不得改写，人名不要音译。明显损坏且少于 4 个拉丁字母的 OCR 乱码保持原样；正常词语（包括 and、or、the、vs）不按乱码处理。
遵守块级术语、风格和结构约束；数学排版遵循专项规则；按指定输出协议返回，不附加解释。`

const zhConventions = `术语：以人名命名的定律、方程、效应、反应，教科书有通行中文名的用中文（如 Hooke's law 译作「胡克定律」），拿不准的保留原文人名（如「Minisci 反应」）；同一术语全文同一处理。缩写、软件名、方法名缩写保留原文。
引用：Figure/Fig. 译「图」，Table 译「表」，Equation/Eq. 译「式」，Section 译「节」，Chapter 译「章」，Appendix 译「附录」，Problem/Exercise 译「习题」，Example 译「例」；编号原样保留，如「式 5.29」「图 3」。
标点：中文句子用全角标点（，。：；？！），如「Solution:」译作「解：」。`

const generalScienceRules = `科技论文默认规则档：
- 翻译正常散文、段落正文、小标题、条目说明、图表题注和简短的技术性标题。
- 字面代码、字面命令、输入卡片、坐标行、赋值语句、shell 示例，以及独立成行的参数或示例行，保持原样。
- 如果一个块以命令或示例前缀开头、随后转为说明性散文，保留字面前缀，翻译说明部分。
- 对“跳过翻译”要保守：成句的长段英文正文通常应当翻译。
- 前几页的元信息片段——作者行、单位署名、编辑日期，以及孤立出现的短连接词（例如 and）——通常不翻译。`

const outputProtocol = `你正在翻译一个文本块。
只返回译文本身，使用纯文本。
不要返回结构化数据、代码块、标签、编号、决策字段或解释说明。`

// RetainPDF's default math_mode is direct_typst: formulas stay in the source
// sent to the model, and the model returns plain text with LaTeX delimiters.
const directMathGuidance = `请先理解整句语义，再直接输出简体中文译文。
公式一律用 LaTeX 写在 $...$ 里，不要改写成 Typst 语法；LaTeX 命令使用单个反斜杠，例如 \mu、\mathrm{M}。
凡是语义上属于公式、变量、上下标、化学式、物理量符号、带上下标的单位与记号，请主动用 $...$ 包裹；不要把裸露的 LaTeX 片段留在正文里，普通正文不要放进 $...$。
公式内容原样保留，命令不要换成 Unicode 字符或近似命令（如 \hbar 不写成 ℏ）。只有 OCR 明显损坏了公式本身——括号缺失、上下标脱落、命令截断——才做最小修复。
引用编号保持原文样式：行内方括号（如 [12]、[3, 5]）原样输出；原文是上标角标或 \cite{117} 时写成 $^{117}$、$^{26-28}$，不要输出 Unicode 上标字符（如 ¹¹⁷）。
不要补写缺失的正文内容，不要编造新的科学信息。不要新造占位符；原文已有的受保护占位符仍须原样保留。以上规则只约束译文内容，不改变指定的输出协议。`

const batchOutputProtocol = `每个 item 返回一个 tagged block，不要返回 JSON 或 Markdown。
必须使用以下精确格式：
<<<ITEM item_id=ITEM_ID>>>
translated text
<<<END>>>
每个请求的 item_id 都必须输出一个 block。`

const taskPrompt = `将以下原文翻译为简体中文。在不损失信息和技术精度的前提下保持凝练，长度尽可能接近原文。`

var (
	technicalFieldLabelRE = regexp.MustCompile(`(?:^|\s*[•\-]\s+)([A-Za-z][A-Za-z0-9 _./-]{1,40})\s*:`)
	technicalLiteralRE    = regexp.MustCompile(`(?i)^(?:-?\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?|true|false|null|none|yes|no|<[^<>\n]{1,80}>|"[^"]{0,120}"|'[^']{0,120}'|\[[^\]\n]{1,160}\])$`)
)

// BuildSystem 拼出一次任务共用的系统提示词。
func BuildSystem() string {
	return strings.Join([]string{systemPrompt, zhConventions, generalScienceRules, directMathGuidance, outputProtocol}, "\n\n")
}

func BuildBatchSystem() string {
	return strings.Join([]string{systemPrompt, zhConventions, generalScienceRules, directMathGuidance, batchOutputProtocol}, "\n\n")
}

// buildSingleUser 构造 RetainPDF 常规生产链使用的单段纯文本请求。
// 上下文注入沿用 "needed" 策略：只在半句或跨栏/跨页续接时给前后文。
func buildSingleUser(item Item, protected string, options Options) string {
	var builder strings.Builder
	builder.WriteString(taskPrompt)
	builder.WriteString("\n\n下面是一段待翻译正文。\n只输出这一段的最终简体中文译文正文，不要输出编号、决策字段、结构化数据、标签、代码块或解释。\n\n【当前原文开始】\n")
	builder.WriteString(protected)
	builder.WriteString("\n【当前原文结束】")
	if item.Role == "title" || item.Role == "heading" {
		builder.WriteString("\n标题规则：译成简洁正式的学术标题；保留编号、公式占位符、符号和专有名词；结合文档领域和匹配术语选择技术译法；不要扩写成正文。")
	} else if item.Role == "table_of_contents" {
		builder.WriteString("\n结构提示：当前原文是目录/图表清单。必须逐行翻译，每个原文行输出一个译文行；翻译行首标签和标题，保留行尾页码且不要改动页码；不要合并行，不要输出解释。")
	} else if hint := roleStyleHint(item.Role); hint != "" {
		builder.WriteString("\n风格提示：")
		builder.WriteString(hint)
	}
	if len(item.LineTexts) > 1 {
		builder.WriteString("\n结构提示：当前原文是多行结构块；译文应尽量保持相同换行数量和行序，不要合并成普通段落。")
	}
	if hint := combinedStyleHint(item); hint != "" {
		builder.WriteString("\n风格提示：")
		builder.WriteString(hint)
	}
	if guidance := preferredTermGuidance(item.Terms); guidance != "" {
		builder.WriteString("\n匹配的术语建议（优先采用；如与原文语境冲突，以当前原文为准）：\n")
		builder.WriteString(guidance)
	}
	if item.Continuation {
		builder.WriteString("\n这是跨栏或跨页续接正文的一部分，请结合上下文理解后直接输出这一整段的译文。")
	}
	if dollarCount(protected)%2 != 0 {
		builder.WriteString("\n注意：本段原文数学定界符 $ 数量为奇数，说明 OCR 可能丢失了配对符号。请按语义判断公式边界，在译文中最小修复并确保 $...$ 成对闭合。")
	}
	if before, after := contextsFor(item, options); before || after {
		if before {
			builder.WriteString("\n前文上下文（仅供理解，禁止翻译进输出）：")
			builder.WriteString(item.ContextBefore)
		}
		if after {
			if !hasTerminal(item.Source) {
				builder.WriteString("\n当前原文是不完整片段；译文必须保持同等不完整，不要用后文上下文补全。")
			}
			builder.WriteString("\n后文上下文（仅供理解，禁止翻译进输出）：")
			builder.WriteString(item.ContextAfter)
		}
		if !hasTerminal(item.Source) {
			builder.WriteString("\n即使当前原文是未写完的半句，也必须照翻半句，严禁从前后文借词补全。")
		}
	}
	return builder.String()
}

func buildBatchUser(items []Item, protected []string, options Options) string {
	var builder strings.Builder
	builder.WriteString(taskPrompt)
	builder.WriteString("\n\n下面是若干段待翻译正文。\n请为每段输出一个 tagged block，除此之外不要输出结构化数据、代码块、解释或额外文字。\n严格格式：\n<<<ITEM item_id=对应的原文 ID>>>\n译文\n<<<END>>>")
	for index, item := range items {
		builder.WriteString("\n\n原文 ")
		builder.WriteString(item.ItemID)
		builder.WriteString(":\n")
		builder.WriteString(protected[index])
		if item.Role == "title" || item.Role == "heading" {
			builder.WriteString("\n标题规则：译成简洁正式的学术标题；保留编号、公式占位符、符号和专有名词；结合文档领域和匹配术语选择技术译法；不要扩写成正文。")
		} else if item.Role == "table_of_contents" {
			builder.WriteString("\n结构提示：当前原文是目录/图表清单。必须逐行翻译，每个原文行输出一个译文行；翻译行首标签和标题，保留行尾页码且不要改动页码；不要合并行，不要输出解释。")
		} else if hint := roleStyleHint(item.Role); hint != "" {
			builder.WriteString("\n风格提示：")
			builder.WriteString(hint)
		}
		if len(item.LineTexts) > 1 {
			builder.WriteString("\n结构提示：当前原文是多行结构块；译文应尽量保持相同换行数量和行序，不要合并成普通段落。")
		}
		if hint := combinedStyleHint(item); hint != "" {
			builder.WriteString("\n风格提示：")
			builder.WriteString(hint)
		}
		if guidance := preferredTermGuidance(item.Terms); guidance != "" {
			builder.WriteString("\n匹配的术语建议（优先采用；如与原文语境冲突，以当前原文为准）：\n")
			builder.WriteString(guidance)
		}
		if item.Continuation {
			builder.WriteString("\n这是跨栏或跨页续接正文的一部分，请结合上下文理解后直接输出这一整段的译文。")
		}
		if before, after := contextsFor(item, options); before || after {
			if before {
				builder.WriteString("\n前文上下文（仅供理解，禁止翻译进输出）：")
				builder.WriteString(item.ContextBefore)
			}
			if after {
				if !hasTerminal(item.Source) {
					builder.WriteString("\n当前原文是不完整片段；译文必须保持同等不完整，不要用后文上下文补全。")
				}
				builder.WriteString("\n后文上下文（仅供理解，禁止翻译进输出）：")
				builder.WriteString(item.ContextAfter)
			}
			if !hasTerminal(item.Source) {
				builder.WriteString("\n即使当前原文是未写完的半句，也必须照翻半句，严禁从前后文借词补全。")
			}
		}
	}
	return builder.String()
}

func combinedStyleHint(item Item) string {
	parts := []string{}
	if hint := strings.TrimSpace(item.StyleHint); hint != "" {
		parts = append(parts, hint)
	}
	if hint := structuredTechnicalStyleHint(item.Source); hint != "" {
		parts = append(parts, hint)
	}
	return strings.Join(parts, "\n")
}

func preferredTermGuidance(terms []Term) string {
	lines := make([]string, 0, len(terms))
	seen := map[string]bool{}
	for _, term := range terms {
		if term.Level != "preferred" || strings.TrimSpace(term.Source) == "" || strings.TrimSpace(term.Target) == "" {
			continue
		}
		key := strings.ToLower(term.Source) + "\x00" + strings.ToLower(term.Target)
		if seen[key] {
			continue
		}
		seen[key] = true
		line := term.Source + " → " + term.Target
		if term.Annotate && term.FirstOccurrence {
			line += "（本段首次出现时，在译名后括注原文：" + term.Source + "）"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func roleStyleHint(role string) string {
	switch role {
	case "abstract":
		return "当前是摘要句或摘要段，保持紧凑的学术摘要表达。"
	case "caption":
		return "当前是图注或表注，保持简洁图注风格，保留编号、标签和图表引用。"
	case "footnote":
		return "当前是脚注，保持简短注释风格，保留符号、上标和标记。"
	default:
		return ""
	}
}

func structuredTechnicalStyleHint(source string) string {
	text := strings.Join(strings.Fields(source), " ")
	if text == "" || len([]rune(text)) > 1200 {
		return ""
	}
	matches := technicalFieldLabelRE.FindAllStringSubmatch(text, -1)
	structured := len(matches) >= 2
	if len(matches) == 1 {
		if _, value, ok := strings.Cut(text, ":"); ok {
			structured = technicalLiteralRE.MatchString(strings.TrimSpace(value))
		}
	}
	if !structured {
		return ""
	}
	labels := make([]string, 0, min(6, len(matches)))
	for _, match := range matches[:min(6, len(matches))] {
		labels = append(labels, strings.TrimSpace(match[1]))
	}
	hint := "这是技术文档中的结构化条目"
	if len(labels) > 0 {
		hint += "（字段包括：" + strings.Join(labels, "、") + "）"
	}
	return hint + "。请保持字段名、字段顺序、列表符号、分隔符和换行排版稳定；字段值、类型标记、枚举、路径、命令、变量名、文件名、代码片段和尖括号内容应原样保留；只翻译字段值中明显属于自然语言说明的部分。不要把结构化字段名随意改写成另一种语言。"
}

func contextsFor(item Item, options Options) (bool, bool) {
	if item.CrossColumnMergeSuspected || item.ReadingOrderUnreliable || item.StructureUnreliable {
		return false, false
	}
	switch options.ContextMode {
	case "off":
		return false, false
	case "all":
		return item.ContextBefore != "", item.ContextAfter != ""
	}
	needed := item.Continuation || !hasTerminal(item.Source)
	if !needed {
		return false, false
	}
	return item.ContextBefore != "", item.ContextAfter != ""
}

// hasTerminal 判断原文是否已经写完一句：RetainPDF 用它决定要不要把邻段上下文
// 交给模型，以及要不要提醒「半句照翻半句」。
func hasTerminal(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return false
	}
	last := []rune(trimmed)[len([]rune(trimmed))-1]
	switch last {
	case '.', '!', '?', '。', '！', '？', '；', ';', ':', '：', ')', '）', ']', '】', '”', '’', '"', '\'':
		return true
	}
	return false
}

// cleanPlainReply 容忍模型把单条译文包进代码围栏或 JSON。
func cleanPlainReply(raw string) string {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "```") {
		text = strings.TrimPrefix(text, "```")
		if newline := strings.IndexByte(text, '\n'); newline >= 0 {
			text = text[newline+1:]
		}
		text = strings.TrimSuffix(strings.TrimSpace(text), "```")
	}
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "{") {
		var decoded struct {
			TranslatedText string `json:"translated_text"`
			Text           string `json:"text"`
		}
		if err := json.Unmarshal([]byte(extractJSONObject(text)), &decoded); err == nil {
			if decoded.TranslatedText != "" {
				return strings.TrimSpace(decoded.TranslatedText)
			}
			if decoded.Text != "" {
				return strings.TrimSpace(decoded.Text)
			}
		}
	}
	return text
}
