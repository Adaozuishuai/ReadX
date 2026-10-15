package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// TranslateInstruction 是段落翻译的任务词。
//
// 翻译与「精读产物」走的是两条不相交的路：译文只作阅读辅助，不参与证据校验，
// 因此这里不要求页码/摘录——但「逐段对应、不合并不遗漏」是硬约束：
// 段数对不上就没法把译文贴回原文，整批作废比错位拼接更安全。
const TranslateInstruction = `你是 CBCT（锥束 CT）论文的翻译助手。把用户给出的英文段落逐段翻译成简体中文。
硬性规则：
1) 逐段对应：返回的条目数、顺序必须与输入完全一致，禁止合并、拆分、补充或遗漏任何一段；
2) 专业术语、方法名、指标名、数据集名保留英文原样（如 NAF、PSNR、FDK、sparse-view、Walnut）；
3) 数字、单位、页码、图表编号（Fig. 2、Table 1）原样保留，禁止改写、换算或补全；
4) 行内公式与数学符号用 $...$ 包裹的 LaTeX 原样保留；不确定的符号照抄，不要自造数学表达；
5) 只翻译，不解释、不总结、不添加原文没有的内容；原文读不清时按字面翻译，不要猜测。
只输出 JSON：{"items":[{"i":0,"t":"译文"},{"i":1,"t":"译文"}]}，其中 i 是段落在输入中的序号（从 0 开始），t 是该段译文。不要输出 JSON 以外的任何文字。`

// 单批上限：沿用参考实现的「按阅读顺序累计约 1 万字符切分，绝不截断段落」。
const (
	translateBatchChars = 10000
	translateBatchParas = 24
)

// TranslateBatch 是一次翻译请求的输入/输出单元。
type TranslateBatch struct {
	Sources []string
}

type translateReply struct {
	Items []struct {
		Index  int    `json:"i"`
		Target string `json:"t"`
	} `json:"items"`
}

// TranslateParagraphs 逐段翻译，按字符数与段数切批，串行调用（并发留给上层控制）。
//
// 任何一批只要段数对不上就整批报错——返回部分结果会让调用方误以为「这段没译文是模型没翻」，
// 实际是错位。宁可真报错、让用户重试。
func TranslateParagraphs(ctx context.Context, client *Client, sources []string, progress ...func(completed, total, start, end int)) ([]string, error) {
	report := func(completed, start, end int) {
		for _, callback := range progress {
			if callback != nil {
				callback(completed, len(sources), start, end)
			}
		}
	}
	out := make([]string, len(sources))
	for start := 0; start < len(sources); {
		end := start
		chars := 0
		for end < len(sources) && end-start < translateBatchParas {
			length := len([]rune(sources[end]))
			if end > start && chars+length > translateBatchChars {
				break
			}
			chars += length
			end++
		}
		batch := sources[start:end]
		report(start, start+1, end)
		targets, err := translateBatch(ctx, client, batch)
		if err != nil {
			return nil, fmt.Errorf("第 %d–%d 段翻译失败: %w", start+1, end, err)
		}
		copy(out[start:end], targets)
		report(end, start+1, end)
		start = end
	}
	return out, nil
}

func translateBatch(ctx context.Context, client *Client, sources []string) ([]string, error) {
	var user strings.Builder
	user.WriteString("请逐段翻译以下 ")
	fmt.Fprintf(&user, "%d", len(sources))
	user.WriteString(" 段，返回等长的 items 数组：\n\n")
	for index, source := range sources {
		fmt.Fprintf(&user, "[%d] %s\n\n", index, source)
	}
	raw, err := client.Generate(ctx, TranslateInstruction, user.String(), 0.1)
	if err != nil {
		return nil, err
	}
	payload := extractJSONObject(raw)
	var decoded translateReply
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		return nil, fmt.Errorf("译文不是合法 JSON: %w", err)
	}
	if len(decoded.Items) != len(sources) {
		return nil, fmt.Errorf("译文段数不符（期望 %d，实际 %d），已放弃本批以免错位", len(sources), len(decoded.Items))
	}
	out := make([]string, len(sources))
	seen := make([]bool, len(sources))
	for _, item := range decoded.Items {
		if item.Index < 0 || item.Index >= len(sources) {
			return nil, fmt.Errorf("译文返回了越界序号 %d", item.Index)
		}
		if seen[item.Index] {
			return nil, fmt.Errorf("译文序号 %d 重复", item.Index)
		}
		seen[item.Index] = true
		out[item.Index] = strings.TrimSpace(item.Target)
	}
	for index, ok := range seen {
		if !ok {
			return nil, fmt.Errorf("译文缺少第 %d 段", index+1)
		}
	}
	return out, nil
}

// extractJSONObject 容忍模型在 JSON 外裹一层 ```json 围栏或前后解说。
func extractJSONObject(raw string) string {
	text := strings.TrimSpace(raw)
	if start := strings.Index(text, "{"); start >= 0 {
		if end := strings.LastIndex(text, "}"); end > start {
			return text[start : end+1]
		}
	}
	return text
}
