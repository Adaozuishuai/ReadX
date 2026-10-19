package translate

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Budget 估算整篇翻译的合理总时限：按「并发波次」而不是「批数」计，
// 因为 concurrency 个批次是并行跑的。上限 2 小时只是防止请求无限悬挂。
func Budget(segmentCount int) time.Duration {
	const perWave = 3 * time.Minute
	if segmentCount <= 0 {
		return 10 * time.Minute
	}
	batches := (segmentCount + batchItems - 1) / batchItems
	waves := (batches + concurrency - 1) / concurrency
	budget := time.Duration(waves) * perWave
	if budget < 10*time.Minute {
		return 10 * time.Minute
	}
	if budget > 2*time.Hour {
		return 2 * time.Hour
	}
	return budget
}

type formatError struct{ err error }

func (e *formatError) Error() string { return e.err.Error() }
func (e *formatError) Unwrap() error { return e.err }

type batchRange struct {
	start, end int
	indices    []int
}

type timeoutGenerator interface {
	GenerateWithTimeout(ctx context.Context, system, user string, temperature float64, timeout time.Duration) (string, error)
}

type translationTimeoutGenerator interface {
	GenerateTranslation(ctx context.Context, system, user string, temperature float64, sourceChars int) (string, error)
}

type translationBatchTimeoutGenerator interface {
	GenerateTranslationBatch(ctx context.Context, system, user string, temperature float64) (string, error)
}

type translationTailTimeoutGenerator interface {
	GenerateTranslationTail(ctx context.Context, system, user string, temperature float64, sourceChars int) (string, error)
}

type transportErrorClassifier interface {
	IsTransportError(error) bool
}

type batchOutcome struct {
	rangeStart int
	rangeEnd   int
	indices    []int
	count      int
	targets    map[int]string
	issues     map[int][]Issue
	err        error
}

// Translate 翻译一批段落，返回与输入等长、同序的译文。
//
// 与旧实现的区别：格式异常仍然可以拆批重试，但质检不过的条目走「单条带问题
// 清单重译」，不会因为某一段少了数字就把整批发回去重翻。
func Translate(ctx context.Context, generator Generator, items []Item, options Options, progress ...ProgressFunc) (Result, error) {
	options = normalizedOptions(options)
	result := Result{Targets: make([]string, len(items)), Issues: make([][]Issue, len(items))}
	if len(items) == 0 {
		return result, nil
	}
	for index := range items {
		if strings.TrimSpace(items[index].ItemID) == "" {
			items[index].ItemID = fmt.Sprintf("item-%d", index+1)
		}
	}
	report := func(completed, start, end int) {
		for _, callback := range progress {
			if callback != nil {
				callback(completed, len(items), start, end)
			}
		}
	}
	system := BuildSystem()
	batches := buildBatchRanges(items)
	for _, batch := range batches {
		report(0, batch.start+1, batch.end)
	}

	workerCount := concurrency
	if workerCount > len(batches) {
		workerCount = len(batches)
	}
	jobs := make(chan batchRange, len(batches))
	outcomes := make(chan batchOutcome, len(batches))
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
				targets, issues, err := runBatch(workerCtx, generator, system, items, batch, options)
				outcomes <- batchOutcome{rangeStart: batch.start, rangeEnd: batch.end, indices: batch.indices, count: len(batchItemIndexes(batch, len(items))), targets: targets, issues: issues, err: err}
			}
		}()
	}
	go func() { workers.Wait(); close(outcomes) }()

	completed := 0
	failed := []int{}
	var firstErr error
	for outcome := range outcomes {
		if outcome.err != nil {
			if options.BestEffort && ctx.Err() == nil {
				for _, index := range outcome.indices {
					failed = append(failed, index)
					kind := "translation_request_failed"
					if isTransportFailure(generator, outcome.err) {
						kind = "translation_transport_failed"
					}
					result.Issues[index] = append(result.Issues[index], Issue{
						Kind: kind, Severity: severityError,
						Message: "首轮翻译请求未完成，将进入未译段恢复轮", Retryable: true,
					})
				}
			} else if firstErr == nil {
				firstErr = fmt.Errorf("第 %d–%d 段翻译失败: %w", outcome.rangeStart+1, outcome.rangeEnd, outcome.err)
				cancel()
			}
		} else {
			for index, target := range outcome.targets {
				result.Targets[index] = target
				if strings.TrimSpace(target) == "" {
					failed = append(failed, index)
					if itemMathMode(items[index]) != "direct_typst" && hasError(outcome.issues[index]) {
						result.Issues[index] = append(result.Issues[index], Issue{
							Kind: "translation_validation_deferred", Severity: severityError,
							Message: "单段质量校验失败，进入延迟重试", Retryable: true,
						})
					}
				}
				result.Issues[index] = outcome.issues[index]
			}
		}
		completed += outcome.count
		report(completed, outcome.rangeStart+1, outcome.rangeEnd)
	}
	if options.BestEffort && ctx.Err() == nil {
		failed = retryDeferredTranslations(ctx, generator, system, items, failed, options, &result)
	}
	if options.BestEffort && ctx.Err() == nil {
		// LeePDF rebuilds OCR-damaged text after the primary pass and before
		// Agent repair and final untranslated recovery.
		runGarbledReconstruction(ctx, generator, items, &result)
		stillFailed := failed[:0]
		for _, index := range failed {
			if index < len(result.Targets) && strings.TrimSpace(result.Targets[index]) == "" {
				stillFailed = append(stillFailed, index)
			}
		}
		failed = stillFailed
		runFastAgentRepair(ctx, generator, items, &result, len(sortedUnique(failed)))
	}
	if options.BestEffort && ctx.Err() == nil && len(failed) > 0 {
		// LeePDF 的 final untranslated recovery 是独立的兜底阶段。ReadX
		// 在同一模型配置下对仍为空的段落再请求一次，成功的结果覆盖空位，
		// 持续失败的段落保留原文由调用方回填。
		remaining := make([]int, 0, len(failed))
		recovery := make([]int, 0, len(failed))
		for _, index := range sortedUnique(failed) {
			if strings.TrimSpace(result.Targets[index]) == "" {
				if hasIssueKind(result.Issues[index], "translation_tail_exhausted") {
					remaining = append(remaining, index)
					continue
				}
				if hasRecoverableLetter(items[index].Source) {
					recovery = append(recovery, index)
				} else {
					remaining = append(remaining, index)
				}
			}
		}
		recoveryLimit := finalRecoveryLimitFromEnv()
		if len(recovery) > recoveryLimit {
			remaining = append(remaining, recovery[recoveryLimit:]...)
			recovery = recovery[:recoveryLimit]
		}
		type recoveryOutcome struct {
			index  int
			target string
			issues []Issue
			err    error
		}
		// LeePDF's final-recovery phase uses the configured document worker
		// count, capped by its 32-worker service limit. This engine has no
		// separate worker setting, so use the same cap and the actual queue size.
		workerCount := min(32, len(recovery))
		jobs := make(chan int, len(recovery))
		outcomes := make(chan recoveryOutcome, len(recovery))
		var recoveryWorkers sync.WaitGroup
		for worker := 0; worker < workerCount; worker++ {
			recoveryWorkers.Add(1)
			go func() {
				defer recoveryWorkers.Done()
				for index := range jobs {
					target, issues, err := finalUntranslatedRecovery(ctx, generator, items[index])
					outcomes <- recoveryOutcome{index: index, target: target, issues: issues, err: err}
				}
			}()
		}
		for _, index := range recovery {
			jobs <- index
		}
		close(jobs)
		go func() { recoveryWorkers.Wait(); close(outcomes) }()
		for outcome := range outcomes {
			if outcome.err == nil && strings.TrimSpace(outcome.target) != "" {
				result.Targets[outcome.index] = outcome.target
				result.Issues[outcome.index] = outcome.issues
				continue
			}
			remaining = append(remaining, outcome.index)
		}
		failed = remaining
	}
	result.Failed = sortedUnique(failed)
	if firstErr != nil {
		// 已经成功的批次保留在 Targets 里：调用方据此先落盘再报错。
		return result, firstErr
	}
	return result, nil
}

func buildBatchRanges(items []Item) []batchRange {
	pageLocal := leePageLocalBatchStrategy()
	batchable := make([]int, 0, len(items))
	singles := make([]int, 0, len(items))
	for index, item := range items {
		if batchableItem(item) {
			batchable = append(batchable, index)
		} else {
			singles = append(singles, index)
		}
	}
	ranges := make([]batchRange, 0, (len(items)+batchItems-1)/batchItems)
	for cursor := 0; cursor < len(batchable); {
		end := cursor + 1
		chars := len([]rune(items[batchable[cursor]].Source))
		for end < len(batchable) && end-cursor < batchItems {
			if pageLocal && items[batchable[end]].PageIndex != items[batchable[cursor]].PageIndex {
				break
			}
			length := len([]rune(items[batchable[end]].Source))
			if pageLocal && chars+length > batchChars {
				break
			}
			chars += length
			end++
		}
		ranges = append(ranges, newBatchRange(batchable[cursor:end]))
		cursor = end
	}
	for _, index := range singles {
		ranges = append(ranges, newBatchRange([]int{index}))
	}
	return ranges
}

func newBatchRange(indices []int) batchRange {
	copyOfIndices := append([]int(nil), indices...)
	return batchRange{start: copyOfIndices[0], end: copyOfIndices[len(copyOfIndices)-1] + 1, indices: copyOfIndices}
}

func batchItemIndexes(batch batchRange, itemCount int) []int {
	if len(batch.indices) > 0 {
		return batch.indices
	}
	indices := make([]int, 0, batch.end-batch.start)
	for index := batch.start; index < batch.end && index < itemCount; index++ {
		indices = append(indices, index)
	}
	return indices
}

func leePageLocalBatchStrategy() bool {
	if strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_TRANSPORT")) != "rust" {
		return false
	}
	return strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_OPTIMIZATION")) == "page_local_v1"
}

// batchableItem mirrors LeePDF's low-risk batched-plain eligibility: only
// body-like prose with no continuation/group semantics, formulas, or oversized
// placeholder inventories can share one tagged request.
func batchableItem(item Item) bool {
	if item.Role != "body" && item.Role != "abstract" {
		return false
	}
	if item.Continuation || strings.TrimSpace(item.ContinuationGroup) != "" {
		return false
	}
	if len(item.FormulaTexts) > 0 {
		return false
	}
	if mathSpanInputRE.MatchString(item.Source) {
		return false
	}
	length := len([]rune(strings.TrimSpace(item.Source)))
	if length < 16 || length > 1200 || englishWordCount(item.Source) < 8 || !looksLikeEnglishProse(item.Source) {
		return false
	}
	protected, tokens := ProtectDirectMath(item.Source)
	protected, tokens = protectTerms(protected, tokens, item.Terms)
	if len(tokens) > 8 {
		return false
	}
	for _, token := range tokens {
		if strings.HasPrefix(token.Tag, "<f") {
			return false
		}
	}
	return true
}

func hasRecoverableLetter(source string) bool {
	for _, char := range source {
		if unicode.IsLetter(char) {
			return true
		}
	}
	return false
}

func runBatch(ctx context.Context, generator Generator, system string, items []Item, batch batchRange, options Options) (map[int]string, map[int][]Issue, error) {
	targets, issues, err := generateBatch(ctx, generator, system, items, batch, options)
	if err == nil {
		return targets, issues, nil
	}
	var invalid *formatError
	if !errors.As(err, &invalid) {
		return nil, nil, err
	}
	indexes := batchItemIndexes(batch, len(items))
	if len(indexes) == 1 {
		if options.BestEffort {
			return map[int]string{indexes[0]: ""}, map[int][]Issue{indexes[0]: nil}, nil
		}
		return nil, nil, err
	}
	// 拆到单段仍然解析不出来，说明模型对这一段持续输出坏格式；只有一段的错误
	// 不值得让整篇导入失败，BestEffort 下由上层保留空译文。
	middle := len(indexes) / 2
	leftBatch, rightBatch := newBatchRange(indexes[:middle]), newBatchRange(indexes[middle:])
	leftTargets, leftIssues, leftErr := runBatch(ctx, generator, system, items, leftBatch, options)
	if leftErr != nil {
		return nil, nil, leftErr
	}
	rightTargets, rightIssues, rightErr := runBatch(ctx, generator, system, items, rightBatch, options)
	if rightErr != nil {
		return nil, nil, rightErr
	}
	return mergeMaps(leftTargets, rightTargets), mergeIssueMaps(leftIssues, rightIssues), nil
}

func generateBatch(ctx context.Context, generator Generator, system string, items []Item, batch batchRange, options Options) (map[int]string, map[int][]Issue, error) {
	indexes := batchItemIndexes(batch, len(items))
	if len(indexes) == 1 {
		index := indexes[0]
		if target, handled, issues, err := translateHeavyFormula(ctx, generator, items[index], options); handled {
			if err != nil {
				return nil, nil, err
			}
			return map[int]string{index: target}, map[int][]Issue{index: issues}, nil
		}
		if target, handled, err := translateFormulaSegments(ctx, generator, items[index], options); handled && err == nil {
			return map[int]string{index: target}, map[int][]Issue{index: Review(items[index].Source, items[index].Source, target, nil, items[index])}, nil
		}
	}
	protected := make([]string, len(indexes))
	tokens := make([][]Token, len(indexes))
	subset := make([]Item, len(indexes))
	for position, index := range indexes {
		subset[position] = items[index]
		protected[position], tokens[position] = ProtectDirectMath(items[index].Source)
		protected[position], tokens[position] = protectTerms(protected[position], tokens[position], items[index].Terms)
	}
	user := ""
	replyIDs := make([]string, len(subset))
	activeSystem := system
	if len(subset) == 1 {
		user = buildSingleUser(subset[0], protected[0], options)
		replyIDs[0] = subset[0].ItemID
	} else {
		activeSystem = BuildBatchSystem()
		user = buildBatchUser(subset, protected, options)
		for index := range subset {
			replyIDs[index] = subset[index].ItemID
		}
	}
	raw, err := generateForBatch(ctx, generator, activeSystem, user, len(subset) > 1, sourceCharacterCount(subset), options.TailRetry)
	if err != nil {
		return nil, nil, err
	}
	var replies []string
	if len(subset) == 1 {
		var reply string
		reply, err = parseSingleReply(raw)
		replies = []string{reply}
	} else {
		replies, err = parseBatchReply(raw, replyIDs)
	}
	if err != nil {
		// 输出格式错误只重问一次；单段仍失败时交给 best-effort 保留原文。
		retryInstruction := "\n\n上次输出格式无效。请严格遵守 system 中的输出要求，只返回完整译文正文，不要添加 JSON、标签、编号或说明。"
		if len(subset) > 1 {
			retryInstruction = "\n\n上次输出格式无效。请严格遵守 system 中的 tagged block 协议，为每个 item_id 输出且仅输出一个 block，不要添加解释。"
		}
		retryUser := user + retryInstruction
		raw, retryErr := generateForBatch(ctx, generator, activeSystem, retryUser, len(subset) > 1, sourceCharacterCount(subset), options.TailRetry)
		if retryErr != nil {
			return nil, nil, retryErr
		}
		if len(subset) == 1 {
			var reply string
			reply, err = parseSingleReply(raw)
			replies = []string{reply}
		} else {
			replies, err = parseBatchReply(raw, replyIDs)
		}
		if err != nil {
			return nil, nil, &formatError{err: err}
		}
	}

	targets := make(map[int]string, len(indexes))
	issueMap := make(map[int][]Issue, len(indexes))
	fallbackSingles := make([]int, 0)
	for position, index := range indexes {
		rawTarget := replies[position]
		current := Review(items[index].Source, protected[position], rawTarget, tokens[position], items[index])
		plainRetried := false
		for round := 0; round < options.RepairRounds && hasError(current); round++ {
			if len(subset) > 1 {
				break
			}
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			var candidate string
			if hasDirectTypstMathIssue(current) {
				candidate = repairDirectTypstMathOnce(ctx, generator, protected[position], rawTarget, current, items[index])
			}
			if strings.TrimSpace(candidate) != "" {
				candidateIssues := Review(items[index].Source, protected[position], candidate, tokens[position], items[index])
				if issueScore(candidateIssues) < issueScore(current) {
					rawTarget = candidate
					current = candidateIssues
					if !hasError(current) {
						break
					}
				}
			}
			// LeePDF's direct_typst route repeats the same plain-text request
			// once after a validation error. The item then follows the deferred
			// retry path; it is not sent an issue-specific rewrite prompt here.
			if !plainRetried && !options.TailRetry {
				plainRetried = true
				retryRaw, retryErr := generateForBatch(ctx, generator, activeSystem, user, false, sourceCharacterCount(subset), false)
				if retryErr != nil {
					return nil, nil, retryErr
				}
				retryTarget, parseErr := parseSingleReply(retryRaw)
				if parseErr != nil {
					return nil, nil, &formatError{err: parseErr}
				}
				rawTarget = retryTarget
				current = Review(items[index].Source, protected[position], rawTarget, tokens[position], items[index])
				continue
			}
			break
		}
		restored, _, _ := Restore(rawTarget, tokens[position])
		// 占位符清单对不上时宁可保留原文：代码/术语 token 丢了就意味着内容缺失，
		// 把丢字的译文贴回版面比一段没翻更危险（LeePDF 也把这类条目标为失败）。
		if placeholderLoss(current) {
			targets[index] = ""
			issueMap[index] = current
			if len(subset) > 1 {
				fallbackSingles = append(fallbackSingles, index)
			}
			continue
		}
		if hasError(current) {
			// LeePDF does not mark an unresolved quality-error output as translated.
			// Keep it out of the cache/render path so the bounded recovery stage can retry it.
			targets[index] = ""
			issueMap[index] = current
			if len(subset) > 1 {
				fallbackSingles = append(fallbackSingles, index)
			}
			continue
		}
		// 质检已记录缺失 token；这里再兜一层，避免界面上直接出现 <c0-xxx/> 这种内部标记。
		restored = tokenTagRE.ReplaceAllString(restored, "")
		targets[index] = strings.TrimSpace(restored)
		issueMap[index] = current
	}
	// LeePDF retries only the batch members rejected by per-item validation
	// through its single-item route. Keep already accepted neighbors untouched.
	for _, index := range fallbackSingles {
		singleTargets, singleIssues, singleErr := runBatch(ctx, generator, system, items, batchRange{start: index, end: index + 1}, options)
		if singleErr != nil || strings.TrimSpace(singleTargets[index]) == "" {
			continue
		}
		targets[index] = singleTargets[index]
		issueMap[index] = singleIssues[index]
	}
	return targets, issueMap, nil
}

func generateForBatch(ctx context.Context, generator Generator, system, user string, batch bool, sourceChars int, tailRetry bool) (string, error) {
	if tailRetry {
		if timed, ok := generator.(translationTailTimeoutGenerator); ok {
			return timed.GenerateTranslationTail(ctx, system, user, translationTemp, sourceChars)
		}
	}
	if batch {
		if timed, ok := generator.(translationBatchTimeoutGenerator); ok {
			return timed.GenerateTranslationBatch(ctx, system, user, translationTemp)
		}
		if timed, ok := generator.(timeoutGenerator); ok {
			return timed.GenerateWithTimeout(ctx, system, user, translationTemp, 45*time.Second)
		}
	} else if timed, ok := generator.(translationTimeoutGenerator); ok {
		return timed.GenerateTranslation(ctx, system, user, translationTemp, sourceChars)
	}
	return generator.Generate(ctx, system, user, translationTemp)
}

func retryDeferredTranslations(ctx context.Context, generator Generator, system string, items []Item, failed []int, options Options, result *Result) []int {
	allFailed := sortedUnique(append([]int(nil), failed...))
	if len(allFailed) == 0 || generator == nil {
		return allFailed
	}
	indices := make([]int, 0, len(allFailed))
	for _, index := range allFailed {
		if index < 0 || index >= len(items) || index >= len(result.Targets) || index >= len(result.Issues) {
			continue
		}
		if hasIssueKind(result.Issues[index], "translation_transport_failed") || hasIssueKind(result.Issues[index], "translation_validation_deferred") {
			indices = append(indices, index)
		}
	}
	if len(indices) == 0 {
		return allFailed
	}
	type retryOutcome struct {
		index  int
		target string
		issues []Issue
	}
	jobs := make(chan int, len(indices))
	outcomes := make(chan retryOutcome, len(indices))
	workerCount := min(concurrency, len(indices))
	var workers sync.WaitGroup
	for worker := 0; worker < workerCount; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				var target string
				var issues []Issue
				for attempt := 0; attempt < 3 && ctx.Err() == nil; attempt++ {
					if attempt > 0 && !waitRetryDelay(ctx, time.Duration(1<<uint(attempt))*time.Second) {
						break
					}
					tailOptions := options
					tailOptions.TailRetry = true
					tailOptions.BestEffort = true
					targets, issueMap, err := runBatch(ctx, generator, system, items, batchRange{start: index, end: index + 1}, tailOptions)
					if err != nil {
						if !isTransportFailure(generator, err) {
							break
						}
						continue
					}
					target = strings.TrimSpace(targets[index])
					issues = issueMap[index]
					if target != "" && !hasError(issues) {
						break
					}
				}
				if target != "" && !hasError(issues) {
					outcomes <- retryOutcome{index: index, target: target, issues: issues}
				}
			}
		}()
	}
	for _, index := range indices {
		jobs <- index
	}
	close(jobs)
	go func() { workers.Wait(); close(outcomes) }()
	recovered := map[int]bool{}
	for outcome := range outcomes {
		// A target may be delivered only after passing the same per-item checks
		// used by the main route.
		if strings.TrimSpace(outcome.target) == "" || hasError(outcome.issues) {
			continue
		}
		result.Targets[outcome.index] = outcome.target
		result.Issues[outcome.index] = outcome.issues
		recovered[outcome.index] = true
	}
	remaining := make([]int, 0, len(allFailed))
	for _, index := range allFailed {
		if !recovered[index] {
			if hasIssueKind(result.Issues[index], "translation_transport_failed") || hasIssueKind(result.Issues[index], "translation_validation_deferred") {
				result.Issues[index] = append(result.Issues[index], Issue{
					Kind: "translation_tail_exhausted", Severity: severityError,
					Message: "延迟重试预算已用尽，保留原文并结束该段恢复", Retryable: false,
				})
			}
			remaining = append(remaining, index)
		}
	}
	return remaining
}
func isTransportFailure(generator Generator, err error) bool {
	classifier, ok := generator.(transportErrorClassifier)
	return ok && classifier.IsTransportError(err)
}

func waitRetryDelay(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func sourceCharacterCount(items []Item) int {
	count := 0
	for index, item := range items {
		if index > 0 {
			count++
		}
		count += len([]rune(strings.Join(strings.Fields(item.Source), " ")))
	}
	return count
}

// finalUntranslatedRecovery follows LeePDF's last-resort path: one plain
// source block, deterministic temperature, two bounded attempts, then the
// normal source/token/number/English/truncation quality checks.
func finalUntranslatedRecovery(ctx context.Context, generator Generator, item Item) (string, []Issue, error) {
	protected, tokens := ProtectDirectMath(item.Source)
	protected, tokens = protectTerms(protected, tokens, item.Terms)
	system := BuildSystem()
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := generator.Generate(ctx, system, buildSingleUser(item, protected, Options{ContextMode: "off"}), 0.0)
		if err != nil {
			lastErr = err
			if ctx.Err() != nil {
				return "", nil, ctx.Err()
			}
			continue
		}
		target, err := parseSingleReply(raw)
		if err != nil {
			lastErr = err
			continue
		}
		issues := Review(item.Source, protected, target, tokens, item)
		if hasError(issues) {
			lastErr = fmt.Errorf("最终未译恢复未通过质量检查")
			continue
		}
		restored, _, _ := Restore(target, tokens)
		return strings.TrimSpace(restored), issues, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("最终未译恢复无译文")
	}
	return "", nil, lastErr
}

// parseSingleReply follows LeePDF's production plain-text response path,
// while accepting earlier ReadX JSON/tagged replies during transition.
func parseSingleReply(raw string) (string, error) {
	if parsed, err := parseBatchReply(raw, []string{"0"}); err == nil && len(parsed) == 1 {
		return parsed[0], nil
	}
	text := cleanPlainReply(raw)
	if text == "" {
		return "", fmt.Errorf("译文为空")
	}
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "<<<ITEM") {
		return "", fmt.Errorf("译文不是纯文本或可识别的兼容格式")
	}
	return text, nil
}

func placeholderLoss(issues []Issue) bool {
	for _, issue := range issues {
		switch issue.Kind {
		case "placeholder_mismatch", "unexpected_placeholder":
			return true
		}
	}
	return false
}

func hasDirectTypstMathIssue(issues []Issue) bool {
	for _, issue := range issues {
		switch issue.Kind {
		case "math_delimiter_unbalanced", "math_braces_unbalanced", "math_unrenderable":
			return true
		}
	}
	return false
}

func repairDirectTypstMathOnce(ctx context.Context, generator Generator, source, previous string, issues []Issue, item Item) string {
	var builder strings.Builder
	builder.WriteString("原文：\n")
	builder.WriteString(source)
	builder.WriteString("\n\n当前译文：\n")
	builder.WriteString(strings.TrimSpace(previous))
	builder.WriteString("\n\n校验错误：\n")
	for _, issue := range issues {
		if issue.Kind == "math_delimiter_unbalanced" || issue.Kind == "math_braces_unbalanced" || issue.Kind == "math_unrenderable" {
			builder.WriteString(issue.Message)
			builder.WriteByte('\n')
		}
	}
	builder.WriteString("\n请只输出修复后的译文正文：")
	system := `你是 PDF 翻译系统中的 LaTeX 数学语法修复器。

渲染器读的是 LaTeX，不要把公式改写成其他语法。

任务：
只修复“已有中文译文”中的 LaTeX 数学语法问题，使其可以被渲染。

必须遵守：
- 不要重新翻译。
- 不要扩写、删减或改写语义。
- 不要输出 JSON、Markdown、代码块、标签、解释或编号。
- 只输出修复后的译文正文。
- 优先修复 $...$ 数学分隔符不平衡、反斜杠命令拼写、花括号、上下标、普通美元符号转义。
- 如果某个 $变量明显是普通文本变量名而不是数学表达式，请写成 \\$变量。
- 如果某个数学片段来自原文，请尽量保持原文数学内容不变。
- 不要为了“更保险”而替换能正常渲染的写法：把 \\hbar、\\mathscr、\\left/\\right 等换成 Unicode 字符或近似命令，只会丢掉字体和尺寸信息。
- \\circled{...} 和 \\textcircled{...} 渲染不了，遇到时输出圈内的字符本身。`
	if strings.TrimSpace(item.StyleHint) != "" {
		system += "\n\n文档术语和风格约束：\n" + strings.TrimSpace(item.StyleHint)
	}
	raw, err := generator.Generate(ctx, system, builder.String(), 0.0)
	if err != nil {
		return ""
	}
	return cleanPlainReply(raw)
}

func hasIssueKind(issues []Issue, kind string) bool {
	for _, issue := range issues {
		if issue.Kind == kind {
			return true
		}
	}
	return false
}

// issuesForPrompt 只把可修复的问题交给模型；warning（例如英文残留提示）
// 留在结果里给界面看，不当作重译要求。
type batchReply struct {
	Translations []struct {
		ItemID flexibleID `json:"item_id"`
		Text   string     `json:"translated_text"`
	} `json:"translations"`
	Items []struct {
		Index int    `json:"i"`
		Text  string `json:"t"`
	} `json:"items"`
}

var taggedItemReplyRE = regexp.MustCompile(`(?s)<<<ITEM\s+item_id=([^\s>]+)\s*>>>\s*(.*?)\s*<<<END>>>`)

// flexibleID 接受字符串或数字：协议要求 item_id 是字符串，但模型经常省略引号。
type flexibleID string

func (id *flexibleID) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*id = flexibleID(text)
		return nil
	}
	var number json.Number
	if err := json.Unmarshal(data, &number); err == nil {
		*id = flexibleID(number.String())
		return nil
	}
	return fmt.Errorf("item_id 必须是字符串或数字")
}

// parseBatchReply 解析新协议，并兼容旧版的 {"items":[{"i":0,"t":"…"}]}。
// 旧格式的 i 是批内序号，不是全局段号。
func parseBatchReply(raw string, ids []string) ([]string, error) {
	if tagged := taggedItemReplyRE.FindAllStringSubmatch(raw, -1); len(tagged) > 0 {
		byID := make(map[string]string, len(tagged))
		for _, match := range tagged {
			id := strings.TrimSpace(match[1])
			if _, duplicate := byID[id]; duplicate {
				return nil, fmt.Errorf("译文 item_id %s 重复", id)
			}
			text := strings.TrimSpace(match[2])
			if text == "" {
				return nil, fmt.Errorf("第 %s 段译文为空", id)
			}
			byID[id] = text
		}
		out := make([]string, len(ids))
		if len(byID) != len(ids) {
			return nil, fmt.Errorf("译文段数不符（期望 %d，实际 %d），已放弃本批以免错位", len(ids), len(byID))
		}
		for index, id := range ids {
			value, ok := byID[id]
			if !ok {
				return nil, fmt.Errorf("译文缺少第 %s 段（item_id=%s）", id, id)
			}
			out[index] = value
		}
		return out, nil
	}
	payload := extractJSONObject(raw)
	var decoded batchReply
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		return nil, fmt.Errorf("译文不是合法 JSON: %w", err)
	}
	if len(decoded.Translations) > 0 {
		if len(decoded.Translations) != len(ids) {
			return nil, fmt.Errorf("译文段数不符（期望 %d，实际 %d），已放弃本批以免错位", len(ids), len(decoded.Translations))
		}
		byID := make(map[string]string, len(ids))
		for _, translation := range decoded.Translations {
			id := strings.TrimSpace(string(translation.ItemID))
			if id == "" {
				return nil, fmt.Errorf("译文缺少 item_id")
			}
			if _, duplicate := byID[id]; duplicate {
				return nil, fmt.Errorf("译文 item_id %s 重复", id)
			}
			byID[id] = translation.Text
		}
		out := make([]string, len(ids))
		for index, id := range ids {
			value, ok := byID[id]
			if !ok {
				return nil, fmt.Errorf("译文缺少第 %s 段（item_id=%s）", id, id)
			}
			if strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("第 %s 段译文为空", id)
			}
			out[index] = value
		}
		return out, nil
	}
	if len(decoded.Items) > 0 {
		if len(decoded.Items) != len(ids) {
			return nil, fmt.Errorf("译文段数不符（期望 %d，实际 %d），已放弃本批以免错位", len(ids), len(decoded.Items))
		}
		out := make([]string, len(ids))
		seen := make([]bool, len(ids))
		for _, item := range decoded.Items {
			if item.Index < 0 || item.Index >= len(ids) {
				return nil, fmt.Errorf("译文返回了越界序号 %d", item.Index)
			}
			if seen[item.Index] {
				return nil, fmt.Errorf("译文序号 %d 重复", item.Index)
			}
			seen[item.Index] = true
			if strings.TrimSpace(item.Text) == "" {
				return nil, fmt.Errorf("第 %d 段译文为空", item.Index+1)
			}
			out[item.Index] = item.Text
		}
		return out, nil
	}
	return nil, fmt.Errorf("译文段数不符（期望 %d，实际 0），已放弃本批以免错位", len(ids))
}

func mergeMaps(left, right map[int]string) map[int]string {
	out := make(map[int]string, len(left)+len(right))
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}

func mergeIssueMaps(left, right map[int][]Issue) map[int][]Issue {
	out := make(map[int][]Issue, len(left)+len(right))
	for key, value := range left {
		out[key] = value
	}
	for key, value := range right {
		out[key] = value
	}
	return out
}

func sortedUnique(values []int) []int {
	if len(values) < 2 {
		return values
	}
	seen := make(map[int]bool, len(values))
	out := values[:0]
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Ints(out)
	return out
}

func finalRecoveryLimitFromEnv() int {
	defaultLimit := 4
	switch strings.ToLower(strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_REPAIR_PROFILE"))) {
	case "quality", "strict", "full":
		defaultLimit = 64
	}
	raw := strings.TrimSpace(os.Getenv("RETAIN_TRANSLATION_FINAL_RECOVERY_MAX_ITEMS"))
	if raw == "" {
		return defaultLimit
	}
	limit, err := strconv.Atoi(raw)
	if err != nil {
		return defaultLimit
	}
	return max(0, limit)
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
