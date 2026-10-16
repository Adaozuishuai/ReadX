package ai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
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
	translateBatchChars  = 10000
	translateBatchParas  = 24
	translateConcurrency = 3
)

type translationFormatError struct{ err error }

func (e *translationFormatError) Error() string { return e.err.Error() }
func (e *translationFormatError) Unwrap() error { return e.err }

func formatError(format string, args ...any) error {
	return &translationFormatError{err: fmt.Errorf(format, args...)}
}

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

// TranslateParagraphs translates bounded batches concurrently and preserves input ordering.
func TranslateParagraphs(ctx context.Context, client *Client, sources []string, progress ...func(completed, total, start, end int)) ([]string, error) {
	translations, _, err := translateParagraphs(ctx, client, sources, false, progress...)
	return translations, err
}

// TranslateParagraphsBestEffort keeps an import usable when a model persistently returns malformed
// JSON for an individual paragraph. Such paragraphs remain untranslated and can be translated later.
func TranslateParagraphsBestEffort(ctx context.Context, client *Client, sources []string, progress ...func(completed, total, start, end int)) ([]string, []int, error) {
	return translateParagraphs(ctx, client, sources, true, progress...)
}

type translationBatchRange struct{ start, end int }
type translationBatchResult struct {
	batch   translationBatchRange
	targets []string
	err     error
}

func translateParagraphs(ctx context.Context, client *Client, sources []string, bestEffort bool, progress ...func(completed, total, start, end int)) ([]string, []int, error) {
	report := func(completed, start, end int) {
		for _, callback := range progress {
			if callback != nil {
				callback(completed, len(sources), start, end)
			}
		}
	}
	out := make([]string, len(sources))
	batches := make([]translationBatchRange, 0, (len(sources)+translateBatchParas-1)/translateBatchParas)
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
		batches = append(batches, translationBatchRange{start: start, end: end})
		start = end
	}
	if len(batches) == 0 {
		return out, nil, nil
	}
	for _, batch := range batches {
		report(0, batch.start+1, batch.end)
	}
	workerCount := min(translateConcurrency, len(batches))
	jobs := make(chan translationBatchRange, len(batches))
	results := make(chan translationBatchResult, len(batches))
	for _, batch := range batches {
		jobs <- batch
	}
	close(jobs)
	workerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var workers sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for batch := range jobs {
				segmentTargets, err := translateBatchRecover(workerCtx, client, sources[batch.start:batch.end], bestEffort)
				results <- translationBatchResult{batch: batch, targets: segmentTargets, err: err}
			}
		}()
	}
	go func() { workers.Wait(); close(results) }()
	completed := 0
	failed := []int{}
	var firstErr error
	for result := range results {
		batch := result.batch
		if result.err != nil {
			var invalid *translationFormatError
			if bestEffort && errors.As(result.err, &invalid) {
				for index := batch.start; index < batch.end; index++ {
					failed = append(failed, index)
				}
			} else if firstErr == nil {
				firstErr = fmt.Errorf("第 %d–%d 段翻译失败: %w", batch.start+1, batch.end, result.err)
				cancel()
			}
		} else {
			copy(out[batch.start:batch.end], result.targets)
			for index, target := range result.targets {
				if target == "" {
					failed = append(failed, batch.start+index)
				}
			}
		}
		completed += batch.end - batch.start
		report(completed, batch.start+1, batch.end)
	}
	if firstErr != nil {
		return nil, nil, firstErr
	}
	return out, failed, nil
}

func translateBatchRecover(ctx context.Context, client *Client, sources []string, bestEffort bool) ([]string, error) {
	targets, err := translateBatch(ctx, client, sources, false)
	if err == nil {
		return targets, nil
	}
	var invalid *translationFormatError
	if !errors.As(err, &invalid) {
		return nil, err
	}
	// Retry once with an explicit JSON-only repair instruction before splitting the batch.
	targets, err = translateBatch(ctx, client, sources, true)
	if err == nil {
		return targets, nil
	}
	if !errors.As(err, &invalid) {
		return nil, err
	}
	if len(sources) == 1 {
		if bestEffort {
			return []string{""}, nil
		}
		return nil, err
	}
	middle := len(sources) / 2
	left, leftErr := translateBatchRecover(ctx, client, sources[:middle], bestEffort)
	if leftErr != nil {
		return nil, leftErr
	}
	right, rightErr := translateBatchRecover(ctx, client, sources[middle:], bestEffort)
	if rightErr != nil {
		return nil, rightErr
	}
	return append(left, right...), nil
}

func translateBatch(ctx context.Context, client *Client, sources []string, repair bool) ([]string, error) {
	var user strings.Builder
	if repair {
		user.WriteString("上次输出格式不合法。请严格输出一个 JSON 对象，不要代码围栏或解释文字；保证每个 i 唯一且完整。\n\n")
	}
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
		return nil, formatError("译文不是合法 JSON: %w", err)
	}
	if len(decoded.Items) != len(sources) {
		return nil, formatError("译文段数不符（期望 %d，实际 %d），已放弃本批以免错位", len(sources), len(decoded.Items))
	}
	out := make([]string, len(sources))
	seen := make([]bool, len(sources))
	for _, item := range decoded.Items {
		if item.Index < 0 || item.Index >= len(sources) {
			return nil, formatError("译文返回了越界序号 %d", item.Index)
		}
		if seen[item.Index] {
			return nil, formatError("译文序号 %d 重复", item.Index)
		}
		seen[item.Index] = true
		out[item.Index] = strings.TrimSpace(item.Target)
		if out[item.Index] == "" {
			return nil, formatError("第 %d 段译文为空", item.Index+1)
		}
	}
	for index, ok := range seen {
		if !ok {
			return nil, formatError("译文缺少第 %d 段", index+1)
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
