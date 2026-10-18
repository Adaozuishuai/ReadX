package validate

import (
	"encoding/json"
	"fmt"
	"strings"
)

var experimentGroups = []string{"dataset", "acquisition", "training", "loss", "metrics", "results"}

// DecodeExperiment 与 TS decodeExperiment 一致：解码期检查六组必需数组。
// baselines 与旧 macOS 版一致为可选（缺省按空数组处理）。
func DecodeExperiment(text string) (ExperimentExtraction, error) {
	canonical, err := NormalizeJSONObject(text)
	if err != nil {
		return ExperimentExtraction{}, fmt.Errorf("实验抽取不是合法 JSON：%w", err)
	}
	text = canonical
	var probe any
	if err := json.Unmarshal([]byte(text), &probe); err != nil {
		return ExperimentExtraction{}, fmt.Errorf("实验抽取不是合法 JSON：%w", err)
	}
	obj, ok := probe.(map[string]any)
	if !ok {
		return ExperimentExtraction{}, fmt.Errorf("实验抽取必须是一个 JSON 对象。")
	}
	missing := []string{}
	for _, key := range experimentGroups {
		if _, isArray := obj[key].([]any); !isArray {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return ExperimentExtraction{}, fmt.Errorf("实验抽取缺少必需的组（或不是数组）：%s。（baselines 可选，其余六组都必须给出）", strings.Join(missing, "、"))
	}
	var out ExperimentExtraction
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return ExperimentExtraction{}, fmt.Errorf("实验抽取字段类型异常：%w", err)
	}
	return out, nil
}

// ValidateGenerated 与 TS validateGeneratedOutput 一致：按 kind 走对应解码 + 校验。
// 注意 results 分支**不含** validateBindings——绑定校验依赖图分析产物（S3 落地），
// 与旧版行为保持一致，避免把旧数据挡在门外。
func ValidateGenerated(kind, value, source string) error {
	switch kind {
	case "motivation", "method":
		return ValidateResearchNotes(value, source)
	case "reproduction":
		analysis, err := DecodeReproductionAnalysis(value)
		if err != nil {
			return err
		}
		return ValidateReproductionAnalysis(analysis, source)
	case "experiment":
		extraction, err := DecodeExperiment(value)
		if err != nil {
			return err
		}
		if err := ValidateExtraction(extraction, source); err != nil {
			return err
		}
		return ValidateConfiguration(extraction)
	case "results":
		analysis, err := DecodeResultsAnalysis(value)
		if err != nil {
			return err
		}
		return ValidateResults(analysis, source)
	default:
		return fmt.Errorf("未知生成物类型：%s", kind)
	}
}
