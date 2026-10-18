package translate

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeGenerator struct {
	mu      sync.Mutex
	calls   int
	handler func(system, user string) (string, error)
}

func (g *fakeGenerator) Generate(_ context.Context, system, user string, _ float64) (string, error) {
	g.mu.Lock()
	g.calls++
	g.mu.Unlock()
	return g.handler(system, user)
}

func (g *fakeGenerator) callCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

type testPromptItem struct {
	ItemID        string `json:"item_id"`
	Source        string `json:"source_text"`
	ContextBefore string `json:"context_before"`
	ContextAfter  string `json:"context_after"`
	SourceNote    string `json:"source_note"`
	Terminology   []struct {
		Source string `json:"source"`
		Target string `json:"target"`
	} `json:"terminology"`
}

type parsedPrompt struct {
	Task  string           `json:"task"`
	Items []testPromptItem `json:"items"`
}

func promptItems(t *testing.T, user string) parsedPrompt {
	t.Helper()
	const startMarker, endMarker = "【当前原文开始】", "【当前原文结束】"
	start := strings.Index(user, startMarker)
	if start < 0 {
		return parsedPrompt{Items: []testPromptItem{{Source: user}}}
	}
	start += len(startMarker)
	end := strings.Index(user[start:], endMarker)
	if end < 0 {
		t.Fatalf("plain single prompt is missing its source end marker:\n%s", user)
	}
	item := testPromptItem{Source: strings.TrimSpace(user[start : start+end])}
	if marker := "前文上下文（仅供理解，禁止翻译进输出）："; strings.Contains(user, marker) {
		before := user[strings.Index(user, marker)+len(marker):]
		item.ContextBefore = strings.TrimSpace(strings.SplitN(before, "\n", 2)[0])
	}
	if marker := "后文上下文（仅供理解，禁止翻译进输出）："; strings.Contains(user, marker) {
		after := user[strings.Index(user, marker)+len(marker):]
		item.ContextAfter = strings.TrimSpace(strings.SplitN(after, "\n", 2)[0])
	}
	if strings.Contains(user, "当前原文是不完整片段") {
		item.SourceNote = "当前原文是不完整片段"
	}
	return parsedPrompt{Items: []testPromptItem{item}}
}

func translatedReply(items []testPromptItem) string {
	if len(items) == 0 {
		return ""
	}
	return "译:" + items[0].Source
}

func TestProtectRestoresLiterals(t *testing.T) {
	source := "Run `go test` then open https://example.com/a or mail a@b.io. Math $\\mathrm{Si}_2$ stays."
	protected, tokens := Protect(source)
	if strings.Contains(protected, "`go test`") || strings.Contains(protected, "https://example.com/a") {
		t.Fatalf("代码与链接没有被保护：%s", protected)
	}
	if strings.Contains(protected, "$\\mathrm{Si}_2$") {
		t.Fatalf("placeholder 路径中的公式应被保护：%s", protected)
	}
	if len(tokens) < 3 {
		t.Fatalf("应保护代码、链接、邮箱，实际 %d：%v", len(tokens), tokens)
	}
	restored, missing, unexpected := Restore(protected, tokens)
	if len(missing) != 0 || len(unexpected) != 0 {
		t.Fatalf("恢复失败 missing=%v unexpected=%v", missing, unexpected)
	}
	if !strings.Contains(restored, "`go test`") || !strings.Contains(restored, "https://example.com/a") || !strings.Contains(restored, "$\\mathrm{Si}_2$") {
		t.Fatalf("代码与链接没有还原：%s", restored)
	}
}

func TestProtectDirectMathMatchesRetainProductionInput(t *testing.T) {
	source := "Run `go test`, visit https://example.com/a, email a@b.io, and derive $x_1$."
	protected, tokens := ProtectDirectMath(source)
	if protected != source || len(tokens) != 0 {
		t.Fatalf("direct_typst should expose the source text to the model, got %q with tokens %v", protected, tokens)
	}
}

func TestReviewFlagsNumbersPlaceholdersAndEnglish(t *testing.T) {
	if issues := Review("We use 50 views.", "We use 50 views.", "我们使用 50 个视角。", nil); len(issues) != 0 {
		t.Fatalf("正常译文不应报问题：%v", issues)
	}
	if issues := Review("We use 50 views.", "We use 50 views.", "我们使用多个视角。", nil); !hasIssueKind(issues, "number_missing") {
		t.Fatalf("丢失数字应被检出：%v", issues)
	}
	source := "This paper studies sparse view reconstruction from projections and proposes a practical method for cone beam computed tomography."
	if issues := Review(source, source, source, nil); !hasIssueKind(issues, "english_residue") {
		t.Fatalf("整段英文未翻译应被检出：%v", issues)
	}
	protected, tokens := Protect("Run `go test` before committing.")
	if issues := Review("Run `go test` before committing.", protected, "提交前先跑一遍。", tokens, Item{MathMode: "placeholder"}); !hasIssueKind(issues, "placeholder_mismatch") {
		t.Fatalf("丢掉代码占位符应被检出：%v", issues)
	}
}

func TestDirectTypstRenderErrorUsesMathRepairPrompt(t *testing.T) {
	var systemPrompt, userPrompt string
	generator := &fakeGenerator{handler: func(system, user string) (string, error) {
		systemPrompt, userPrompt = system, user
		return "修复后的译文 $\\frac{a}{b}$", nil
	}}
	issues := []Issue{{
		Kind: "math_unrenderable", Severity: severityError,
		Message: "公式渲染器无法排版：$\\mathrm{H_aC_aH_b}$（Double subscripts）", Retryable: true,
	}}
	if !hasDirectTypstMathIssue(issues) {
		t.Fatal("math_unrenderable should enter the direct Typst repair path")
	}
	got := repairDirectTypstMathOnce(context.Background(), generator, "源文", "当前译文", issues, Item{StyleHint: "保留术语 C"})
	if got != "修复后的译文 $\\frac{a}{b}$" {
		t.Fatalf("unexpected repaired text %q", got)
	}
	for _, fragment := range []string{"LaTeX 数学语法修复器", "保留术语 C"} {
		if !strings.Contains(systemPrompt, fragment) {
			t.Fatalf("system prompt omitted %q: %s", fragment, systemPrompt)
		}
	}
	for _, fragment := range []string{"当前译文", issues[0].Message, "只输出修复后的译文正文"} {
		if !strings.Contains(userPrompt, fragment) {
			t.Fatalf("repair request omitted %q: %s", fragment, userPrompt)
		}
	}
}

func TestTranslatePreservesOrderAndBatchesConcurrently(t *testing.T) {
	var active, maxActive atomic.Int32
	generator := &fakeGenerator{handler: func(_, user string) (string, error) {
		current := active.Add(1)
		for {
			old := maxActive.Load()
			if current <= old || maxActive.CompareAndSwap(old, current) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		defer active.Add(-1)
		return translatedReply(promptItems(t, user).Items), nil
	}}
	items := make([]Item, 48)
	for index := range items {
		items[index] = Item{Source: fmt.Sprintf("paragraph-%02d", index)}
	}
	result, err := Translate(context.Background(), generator, items, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if maxActive.Load() < 2 || maxActive.Load() > concurrency {
		t.Fatalf("期望有限并发（2–%d），实际 %d", concurrency, maxActive.Load())
	}
	for index, item := range items {
		if result.Targets[index] != "译:"+item.Source {
			t.Fatalf("第 %d 段错位：%q", index, result.Targets[index])
		}
	}
	if len(result.Failed) != 0 {
		t.Fatalf("不应有失败段：%v", result.Failed)
	}
}

func TestTranslateDoesNotRetryPerItemNumericWarning(t *testing.T) {
	var repairCalls atomic.Int32
	// 数值一致性由 RetainPDF 的全文 QA 负责；逐段检查只留提示，不触发模型重译。
	generator := &fakeGenerator{handler: func(system, user string) (string, error) {
		if strings.Contains(user, "【当前原文开始】") {
			return "我们使用多个视角训练。", nil
		}
		repairCalls.Add(1)
		if !strings.Contains(user, "50") {
			t.Errorf("重译提示词里应包含丢失的数字：%s", user)
		}
		return "我们使用 50 个视角训练。", nil
	}}
	result, err := Translate(context.Background(), generator, []Item{{Source: "We train using 50 views."}}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Targets[0] != "我们使用多个视角训练。" {
		t.Fatalf("单段数值提示不应覆盖译文，实际 %q（issues=%v）", result.Targets[0], result.Issues[0])
	}
	if repairCalls.Load() != 0 {
		t.Fatalf("单段数值提示不应触发重译，调用数 %d", repairCalls.Load())
	}
	if !hasIssueKind(result.Issues[0], "number_missing") {
		t.Fatalf("应保留全文数值 QA 的提示：%v", result.Issues[0])
	}
}

func TestTranslateBestEffortIsolatesMalformedItem(t *testing.T) {
	generator := &fakeGenerator{handler: func(_, user string) (string, error) {
		if strings.Contains(user, "bad-paragraph") {
			return "", nil
		}
		if strings.Contains(user, "【当前原文开始】") {
			return translatedReply(promptItems(t, user).Items), nil
		}
		return "", nil
	}}
	result, err := Translate(context.Background(), generator, []Item{
		{Source: "good-a"},
		{Source: "bad-paragraph"},
		{Source: "good-b"},
	}, Options{BestEffort: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Failed) != 1 || result.Failed[0] != 1 {
		t.Fatalf("未定位坏段：%v", result.Failed)
	}
	if result.Targets[0] != "译:good-a" || result.Targets[1] != "" || result.Targets[2] != "译:good-b" {
		t.Fatalf("部分译文顺序或回退错误：%v", result.Targets)
	}
}

func TestContextInjectionOnlyForIncompleteParagraphs(t *testing.T) {
	seen := map[string]string{}
	generator := &fakeGenerator{handler: func(_, user string) (string, error) {
		parsed := promptItems(t, user)
		for _, item := range parsed.Items {
			seen[item.Source] = item.ContextBefore + "|" + item.ContextAfter + "|" + item.SourceNote
		}
		return translatedReply(parsed.Items), nil
	}}
	_, err := Translate(context.Background(), generator, []Item{
		{Source: "Complete sentence.", ContextBefore: "A", ContextAfter: "B"},
		{Source: "a fragment without terminal punctuation", ContextBefore: "A", ContextAfter: "B"},
	}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	complete := seen["Complete sentence."]
	if strings.HasPrefix(complete, "A|B|") {
		t.Fatalf("完整句子不应注入上下文：%q", complete)
	}
	fragment := seen["a fragment without terminal punctuation"]
	if !strings.Contains(fragment, "A|B|") || !strings.Contains(fragment, "不完整") {
		t.Fatalf("半句应注入上下文并提示照翻半句：%q", fragment)
	}
}

func TestBudgetUsesWavesNotBatches(t *testing.T) {
	cases := []struct {
		segments int
		want     time.Duration
	}{
		{0, 10 * time.Minute},
		{1, 10 * time.Minute},
		{24, 10 * time.Minute},
		{2000, 2 * time.Hour},
		{100000, 2 * time.Hour},
	}
	for _, testCase := range cases {
		if got := Budget(testCase.segments); got != testCase.want {
			t.Fatalf("%d 段的预算应为 %s，实际 %s", testCase.segments, testCase.want, got)
		}
	}
}

func TestTranslateDirectTypstKeepsSourceLiteralsInPrompt(t *testing.T) {
	var sawLiteral bool
	generator := &fakeGenerator{handler: func(_, user string) (string, error) {
		sawLiteral = strings.Contains(user, "`go test`")
		return "运行测试。", nil
	}}
	result, err := Translate(context.Background(), generator, []Item{{Source: "Run `go test` now."}}, Options{RepairRounds: 1})
	if err != nil {
		t.Fatal(err)
	}
	if result.Targets[0] != "运行测试。" || !sawLiteral {
		t.Fatalf("direct_typst should send source literals without placeholder tokens, target=%q sawLiteral=%v", result.Targets[0], sawLiteral)
	}
}
