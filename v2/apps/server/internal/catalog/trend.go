// Package catalog 的 trend.go：移植旧版 windows/src/core/trend.ts 的 Trend / Research Gap 证据契约。
//
// PRD 硬约束（TS 原文照搬）：必须展示时间窗口、论文数量/样本数、证据集合；
// 「只能输出证据支持的潜在空白，不能把缺少检索证据的内容包装成首次」；
// 样本不足时**拒绝给出趋势判断**，只报告计数与缺口语义，而不是输出一个看起来很像结论的百分比。
package catalog

import (
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// YearCarrier 是提取时间窗口所需的最小字段集：published 优先，回退 year。
type YearCarrier struct {
	Published *string
	Year      *string
}

// TrendSample 参与统计的论文 + 时间窗口。窗口本身是一等公民，不是隐含前提。
type TrendSample struct {
	// Labels 是参与统计的论文标识（顺序无关）；只用于计数与窗口。
	Labels      []string `json:"papers"`
	WindowStart *string  `json:"windowStart"`
	WindowEnd   *string  `json:"windowEnd"`
}

// Window 与 TS window 一致地提取时间窗口：
// 取 published 前缀 4 个字符里**所有的数字字符**，恰好凑满 4 位才采用；
// published 缺失或不合格时回退 year；两者都不合格则年份未知（不编造）。
func Window(papers []YearCarrier) (*string, *string) {
	years := []string{}
	for _, paper := range papers {
		for _, candidate := range []*string{paper.Published, paper.Year} {
			if candidate == nil {
				continue
			}
			digits := []rune{}
			for index, ch := range []rune(*candidate) {
				if index >= 4 {
					break
				}
				if unicode.IsNumber(ch) {
					digits = append(digits, ch)
				}
			}
			if len(digits) == 4 {
				years = append(years, string(digits))
				break
			}
		}
	}
	if len(years) == 0 {
		return nil, nil
	}
	lo, hi := years[0], years[0]
	for _, year := range years {
		if year < lo {
			lo = year
		}
		if year > hi {
			hi = year
		}
	}
	return &lo, &hi
}

// Sample 与 TS sample 一致。
func Sample(labels []string, years []YearCarrier) TrendSample {
	lo, hi := Window(years)
	return TrendSample{Labels: labels, WindowStart: lo, WindowEnd: hi}
}

// IsWindowBounded 与 TS isWindowBounded 一致。
func IsWindowBounded(sample TrendSample) bool {
	return sample.WindowStart != nil && sample.WindowEnd != nil
}

// MinimumSample 低于该样本量不下趋势判断。PRD 风险表点名「样本少导致伪趋势」，
// 取 5 作为保守下限：少于 5 篇只能报告计数，不能声称「升温 / 新兴」。
const MinimumSample = 5

// TrendFinding 一条趋势结论。Claim 与 Caveat 分离，UI 必须同时展示。
type TrendFinding struct {
	Topic       string
	Count       int
	Sample      TrendSample
	Evidence    []SystemTag
	IsSupported bool
	Claim       string
	Caveat      string
}

// Disclosure 给 UI 用的完整描述：时间窗 + 样本数 + 证据集合，三样缺一不可。
func Disclosure(finding TrendFinding) string {
	window := "时间窗口未知"
	if IsWindowBounded(finding.Sample) {
		window = *finding.Sample.WindowStart + " ~ " + *finding.Sample.WindowEnd
	}
	parts := []string{}
	for _, tag := range finding.Evidence {
		parts = append(parts, tag.Value+"("+strconv.Itoa(finding.Count)+")")
	}
	return "时间窗口：" + window + " · 样本数：" + strconv.Itoa(finding.Count) + " 篇 · 证据：" + strings.Join(parts, "、")
}

// Findings 按系统标签聚合，产出带完整披露信息的趋势条目。
//
// tagsOf 是「论文下标 -> 系统标签」的派生函数（注入以保持本模块不依赖具体匹配实现）；
// years 给出各论文的年份，用于时间窗口披露。排序：count 降序，同 count 按 topic 升序。
func Findings(labels []string, years []YearCarrier, tagsOf func(index int, label string) []SystemTag) []TrendFinding {
	sample := Sample(labels, years)

	type group struct {
		tag     SystemTag
		members []string
	}
	groups := map[string]*group{}
	order := []string{}
	for index, label := range labels {
		for _, tag := range tagsOf(index, label) {
			id := tag.Category + "|" + tag.Value
			if existing, ok := groups[id]; ok {
				existing.members = append(existing.members, label)
				continue
			}
			groups[id] = &group{tag: tag, members: []string{label}}
			order = append(order, id)
		}
	}

	out := []TrendFinding{}
	for _, id := range order {
		item := groups[id]
		count := len(item.members)
		supported := count >= MinimumSample
		claim := strconv.Itoa(count) + " 篇论文涉及 " + item.tag.Value
		var caveat string
		if supported {
			windowStart, windowEnd := "?", "?"
			if sample.WindowStart != nil {
				windowStart = *sample.WindowStart
			}
			if sample.WindowEnd != nil {
				windowEnd = *sample.WindowEnd
			}
			caveat = "仅为计数与证据集合，不代表该方向「升温」或「首次」；时间窗口 " +
				windowStart + "–" + windowEnd + " 内共 " + strconv.Itoa(len(sample.Labels)) + " 篇。"
		} else {
			claim += "（样本不足，不下趋势判断）"
			caveat = "样本数 " + strconv.Itoa(count) + " < " + strconv.Itoa(MinimumSample) +
				"：不下趋势判断，只报告计数与证据集合；请扩大检索范围后重试。"
		}
		out = append(out, TrendFinding{
			Topic:       item.tag.Value,
			Count:       count,
			Sample:      sample,
			Evidence:    []SystemTag{item.tag},
			IsSupported: supported,
			Claim:       claim,
			Caveat:      caveat,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count == out[j].Count {
			return out[i].Topic < out[j].Topic
		}
		return out[i].Count > out[j].Count
	})
	return out
}

// GapStatement Research Gap 只能表述为「检索范围内未见」，不得表述为「无人做过 / 首次」。
func GapStatement(topic string, sample TrendSample) string {
	windowText := "当前"
	if IsWindowBounded(sample) {
		windowText = *sample.WindowStart + "–" + *sample.WindowEnd
	}
	return "在 " + windowText + " 的 " + strconv.Itoa(len(sample.Labels)) + " 篇检索范围内，未发现针对「" + topic +
		"」的直接工作。这是检索范围内的缺口，不等于该方向无人研究，也不构成「首次」声明。"
}

// ForbiddenPhrases PRD 红线：不能声称首次。
var ForbiddenPhrases = []string{"首次", "首个", "first to", "no one has", "无人研究过", "前所未有的"}

// NegationMarkers 否定前缀：出现在禁用语之前时，该处属于「声明不构成首次」，不算违规。
var NegationMarkers = []string{"不构成", "不代表", "不是", "不等于", "并非", "不得", "不能", "禁止", "无「", "不存在", "no claim of", "not the first"}

// ViolatesRedline 输出前自检：命中红线措辞即视为不合规；跳过否定语境。
// 只看禁用语之前最多 12 个字符的窗口，窗口内出现任一否定标记即放行。
// 同一禁用语出现多次时逐个判断，只要有一个在非否定语境里出现就算违规。
func ViolatesRedline(text string) bool {
	lower := []rune(strings.ToLower(text))
	for _, phrase := range ForbiddenPhrases {
		needle := []rune(strings.ToLower(phrase))
		from := 0
		for {
			at := findRunes(lower, needle, from)
			if at < 0 {
				break
			}
			windowStart := at - 12
			if windowStart < 0 {
				windowStart = 0
			}
			prefix := strings.ToLower(string(lower[windowStart:at]))
			if !anyMarker(prefix) {
				return true
			}
			from = at + len(needle)
		}
	}
	return false
}

func anyMarker(prefix string) bool {
	for _, marker := range NegationMarkers {
		if strings.Contains(prefix, strings.ToLower(marker)) {
			return true
		}
	}
	return false
}

// findRunes 在 rune 数组里从 from 开始查找子序列，返回下标或 -1。
func findRunes(haystack, needle []rune, from int) int {
	if len(needle) == 0 {
		return from
	}
	last := len(haystack) - len(needle)
	for i := from; i <= last; i++ {
		if i < 0 {
			continue
		}
		ok := true
		for j := 0; j < len(needle); j++ {
			if haystack[i+j] != needle[j] {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}
