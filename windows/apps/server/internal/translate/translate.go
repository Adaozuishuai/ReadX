// Package translate 是 ReadX 的全文翻译引擎。常规段落链对齐 LeePDF：
// 低风险正文走 tagged 合批，其余走单段纯文本；统一使用 0.2 温度、按需提供
// 邻段上下文、保护字面量和行内公式，再逐条质检和带问题清单修复。ReadX 输入来自 PaddleOCR，因而没有
// LeePDF 的 Mathpix 公式分段、文档术语准备和完整分类阶段所需的结构化数据。
package translate

import "context"

// Item 是一个待翻译段落。
//
// ContextBefore / ContextAfter 只用于消歧：LeePDF 的实测结论是整页上下文
// 会诱导模型把邻段内容并进当前译文，所以默认只在「当前段落是半句」「跨栏/跨页
// 续接」时注入，且提示词明确禁止借用。
type Item struct {
	ItemID                    string
	PageIndex                 int
	Source                    string
	MathMode                  string
	HeavyFormulaSplitApplied  bool
	ContinuationGroup         string
	ContinuationSignature     string
	ContextBefore             string
	ContextAfter              string
	Continuation              bool
	Role                      string
	BlockType                 string
	PolicyTranslate           bool
	SemanticRole              string
	StructureRole             string
	LayoutRole                string
	StyleHint                 string
	Terms                     []Term
	LineTexts                 []string
	FormulaTexts              []string
	CrossColumnMergeSuspected bool
	ReadingOrderUnreliable    bool
	StructureUnreliable       bool
}

// Term mirrors LeePDF glossary levels. preserve keeps the source spelling;
// canonical enforces the configured target; preferred is a matched-only hint.
type Term struct {
	Source              string
	Target              string
	Level               string
	Note                string
	MatchMode           string
	Context             string
	Category            string          `json:"category,omitempty"`
	Treatment           string          `json:"treatment,omitempty"`
	Annotate            bool            `json:"annotate,omitempty"`
	ReviewStatus        string          `json:"review_status,omitempty"`
	PrescanTarget       string          `json:"prescan_target,omitempty"`
	FirstOccurrence     bool            `json:"first_occurrence,omitempty"`
	FirstOccurrenceID   string          `json:"first_occurrence_item_id,omitempty"`
	FirstOccurrencePage *int            `json:"first_occurrence_page_index,omitempty"`
	Votes               int             `json:"votes,omitempty"`
	ConflictCandidates  []TermCandidate `json:"conflict_candidates,omitempty"`
	Frequency           int             `json:"frequency,omitempty"`
}

type TermCandidate struct {
	Target string `json:"target"`
	Votes  int    `json:"votes"`
}

// Options 控制一次翻译任务。
type Options struct {
	// ContextMode: needed（默认）/ all / off。
	ContextMode string
	// BestEffort 为 true 时，单段格式异常不会中止整篇翻译，而是保留空译文。
	BestEffort bool
	// RepairRounds 是质检不过后的单条重译轮数；0 表示默认 2 轮。
	RepairRounds int
	// TailRetry selects LeePDF's deferred retry timeout profile.
	TailRetry bool
}

// Issue 是一条质检结果。
type Issue struct {
	Kind      string `json:"kind"`
	Severity  string `json:"severity"` // error 阻断修复；warning 记录下来
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Result 是一次翻译任务的结果。Targets 与输入 Items 等长、同序。
type Result struct {
	Targets []string
	Failed  []int
	Issues  [][]Issue
}

// Generator 是最小的模型调用接口，*ai.Client 满足它。
type Generator interface {
	Generate(ctx context.Context, system, user string, temperature float64) (string, error)
}

// ProgressFunc 汇报已完成的段落数。
type ProgressFunc func(completed, total, start, end int)

const (
	batchChars      = 2400
	batchItems      = 8
	concurrency     = 3
	defaultRepair   = 2
	maxRepairRounds = 3
	// LeePDF's translation executor defaults to temperature=0.2 for normal
	// translation requests; deterministic repair/classification paths use 0.0.
	translationTemp = 0.2
)

func normalizedOptions(options Options) Options {
	if options.RepairRounds <= 0 {
		options.RepairRounds = defaultRepair
	}
	if options.RepairRounds > maxRepairRounds {
		options.RepairRounds = maxRepairRounds
	}
	if options.ContextMode == "" {
		options.ContextMode = "needed"
	}
	return options
}
