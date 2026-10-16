package validate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

// ReproductionItem 与 TS ReproductionItem 对应。
type ReproductionItem struct {
	Finding    Field  `json:"finding"`
	Assessment string `json:"assessment"`
	Action     string `json:"action"`
}

// ReproductionAnalysis 与 TS ReproductionAnalysis 对应：五组都必须给出。
type ReproductionAnalysis struct {
	Resources   []ReproductionItem `json:"resources"`
	Environment []ReproductionItem `json:"environment"`
	Cost        []ReproductionItem `json:"cost"`
	Missing     []ReproductionItem `json:"missing"`
	Risks       []ReproductionItem `json:"risks"`
}

var reproductionGroupKeys = []string{"resources", "environment", "cost", "missing", "risks"}

// ReproductionGroups 与 TS reproductionGroups 一致：五组的稳定顺序与中文标题。
func ReproductionGroups(x ReproductionAnalysis) []struct {
	ID    string
	Label string
	Items []ReproductionItem
} {
	return []struct {
		ID    string
		Label string
		Items []ReproductionItem
	}{
		{"resources", "资源 · 数据 / 代码 / 权重", x.Resources},
		{"environment", "环境 · 依赖 / 特殊算子", x.Environment},
		{"cost", "训练成本 · 时间 / 显存", x.Cost},
		{"missing", "关键缺失 · 几何 / 预处理 / 参数", x.Missing},
		{"risks", "风险 · 实现 / 评测协议", x.Risks},
	}
}

// DecodeReproductionAnalysis 与 TS 一致：解码期就检查五组是否齐全且为数组，
// 否则「模型少给一组」会变成后续 nil 切片上的崩溃而不是可读错误。
func DecodeReproductionAnalysis(raw string) (ReproductionAnalysis, error) {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "```") {
		lines := strings.Split(text, "\n")
		if len(lines) >= 2 {
			text = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	var probe any
	if err := json.Unmarshal([]byte(text), &probe); err != nil {
		return ReproductionAnalysis{}, fmt.Errorf("复现分析不是合法 JSON：%w", err)
	}
	obj, ok := probe.(map[string]any)
	if !ok {
		return ReproductionAnalysis{}, fmt.Errorf("复现分析必须是一个 JSON 对象。")
	}
	missing := []string{}
	for _, key := range reproductionGroupKeys {
		if _, isArray := obj[key].([]any); !isArray {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return ReproductionAnalysis{}, fmt.Errorf("复现分析缺少必需的组（或该组不是数组）：%s。五组都必须给出。", strings.Join(missing, "、"))
	}
	var out ReproductionAnalysis
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return ReproductionAnalysis{}, fmt.Errorf("复现分析字段类型异常：%w", err)
	}
	return out, nil
}

// Fingerprint 与 TS fingerprint 一致：先按键名递归排序再 sha256，
// 否则模型换个字段顺序就会把同一内容判成「新版分析」，已核对进度被整批清空。
func Fingerprint(x ReproductionAnalysis) string {
	body, err := json.Marshal(x)
	if err != nil {
		return ""
	}
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	sum := sha256.Sum256([]byte(StableJSON(parsed)))
	return hex.EncodeToString(sum[:])
}

// ValidateReproductionAnalysis 与 TS 逐条对应：
// 未知也须给出核对行动（page 可为 null，但 assessment/action 不能空白）。
func ValidateReproductionAnalysis(analysis ReproductionAnalysis, source string) error {
	problems := []string{}
	available := map[int]bool{}
	for _, p := range Pages(source) {
		available[p.Number] = true
	}
	for _, group := range ReproductionGroups(analysis) {
		// 清单只做「核对提示」，不做穷举：每组 1–4 项。
		if len(group.Items) == 0 || len(group.Items) > 4 {
			problems = append(problems, fmt.Sprintf("%s：须有 1–4 项，未知也须给出核对行动", group.Label))
		}
		titles := map[string]bool{}
		for _, item := range group.Items {
			titles[item.Finding.K] = true
		}
		if len(titles) != len(group.Items) {
			problems = append(problems, fmt.Sprintf("%s：字段标题重复", group.Label))
		}
		for _, item := range group.Items {
			title := item.Finding.K
			if strings.TrimSpace(title) == "" || strings.TrimSpace(item.Assessment) == "" || strings.TrimSpace(item.Action) == "" {
				problems = append(problems, fmt.Sprintf("%s：缺少字段、分析或核对行动", title))
			}
			if err := ValidateExtraction(ExperimentExtraction{Dataset: []Field{item.Finding}}, source); err != nil {
				problems = append(problems, err.Error())
			}
			// 分析/行动里出现的每个 Page N 都必须真实存在；引用不存在的页码比不引用更危险。
			for _, ref := range Citations(item.Assessment + "\n" + item.Action) {
				if !available[ref] {
					problems = append(problems, fmt.Sprintf("%s：分析或行动引用了不存在的页码", title))
					break
				}
			}
		}
	}
	if len(problems) > 0 {
		return &ValidationError{Message: strings.Join(problems, "；"), Problems: problems}
	}
	return nil
}
