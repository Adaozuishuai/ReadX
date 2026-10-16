package validate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// PruneResult 是本地修剪层的产物：修剪后的 JSON、被降级条目清单、以及是否收敛。
type PruneResult struct {
	Value   string
	Demoted []string
}

const unknownValue = "论文未说明"

// PruneGenerated 与 TS pruneGenerated 逐条对应：把校验器当 oracle，
// 逐条剔除/降级过不了逐字核验的条目，直到整体通过或确认无法安全收敛。
// 返回 nil 表示「修剪也救不回来」，调用方走未核验保存通道（带可见标注）。
func PruneGenerated(kind, text, source string) *PruneResult {
	var obj map[string]any
	raw := strings.TrimSpace(text)
	if start := strings.Index(raw, "{"); start >= 0 {
		if end := strings.LastIndex(raw, "}"); end > start {
			raw = raw[start : end+1]
		}
	}
	if err := json.Unmarshal([]byte(raw), &obj); err != nil || obj == nil {
		return nil
	}
	demoted := []string{}

	fieldValid := func(field any) bool {
		converted, ok := toField(field)
		if !ok {
			return false
		}
		return ValidateExtraction(ExperimentExtraction{Dataset: []Field{converted}}, source) == nil
	}

	switch kind {
	case "experiment":
		groups := []string{"dataset", "acquisition", "training", "loss", "metrics", "baselines"}
		for _, group := range append(append([]string{}, groups...), "results") {
			if _, ok := obj[group].([]any); !ok {
				obj[group] = []any{}
			}
		}
		if results, _ := obj["results"].([]any); len(results) > 0 {
			demoted = append(demoted, "结果数值不属于实验配置（归「结果分析」面板）")
			obj["results"] = []any{}
		}
		for _, group := range groups {
			items, _ := obj[group].([]any)
			kept := []any{}
			for _, item := range items {
				asMap, ok := item.(map[string]any)
				if !ok {
					demoted = append(demoted, fmt.Sprintf("%s：形状无效的条目已剔除", group))
					continue
				}
				if _, hasKey := asMap["k"].(string); !hasKey {
					demoted = append(demoted, fmt.Sprintf("%s：形状无效的条目已剔除", group))
					continue
				}
				if fieldValid(asMap) {
					kept = append(kept, asMap)
					continue
				}
				demoted = append(demoted, fmt.Sprintf("%s：「%s」无法逐字核验，已标为「%s」", group, asMap["k"], unknownValue))
				kept = append(kept, map[string]any{"k": asMap["k"], "v": unknownValue, "page": nil, "excerpt": nil})
			}
			obj[group] = kept
		}
		if err := ValidateGenerated("experiment", mustJSON(obj), source); err != nil {
			return nil
		}
		return &PruneResult{Value: prettyJSON(obj), Demoted: demoted}

	case "results":
		return pruneResults(obj, source, &demoted, fieldValid)
	}
	return nil
}

var (
	missingFieldsRe = regexp.MustCompile(`缺少必需的字段（或不是数组）：([^。]+)。`)
	tableStructRe   = regexp.MustCompile(`(?:本文方法不在该表的方法行中|表格缺少表头、方法行或唯一标识)：(.+)$`)
	columnRe        = regexp.MustCompile(`(?:列缺少原文上下文|列单位未被其摘录支持)：(.+)$`)
	rowRe           = regexp.MustCompile(`(?:行标签或单元格不完整|不确定性数值未匹配方法行)：(.+)$`)
	cellRe          = regexp.MustCompile(`(?:单元格数字未匹配方法行|单元格数值未按表头列顺序排列[^：]*)：([^/；\s]+)/([^ =；]+)`)
	quotedKeyRe     = regexp.MustCompile(`「([^」]+)」`)
)

var discussionKeys = []string{"stability", "ablation", "generalization", "efficiency"}

func pruneResults(obj map[string]any, source string, demoted *[]string, fieldValid func(any) bool) *PruneResult {
	for _, group := range append([]string{"tables"}, append(append([]string{}, discussionKeys...), "statistics", "missing")...) {
		if _, ok := obj[group].([]any); !ok {
			obj[group] = []any{}
		}
	}

	tables := func() []map[string]any {
		out := []map[string]any{}
		for _, item := range obj["tables"].([]any) {
			if asMap, ok := item.(map[string]any); ok {
				out = append(out, asMap)
			}
		}
		return out
	}
	setTables := func(items []map[string]any) {
		converted := []any{}
		for _, item := range items {
			converted = append(converted, item)
		}
		obj["tables"] = converted
	}

	dropTable := func(id, why string) {
		kept := []map[string]any{}
		for _, table := range tables() {
			if stringValue(table["id"]) == id {
				continue
			}
			kept = append(kept, table)
		}
		setTables(kept)
		for _, group := range discussionKeys {
			items, _ := obj[group].([]any)
			filtered := []any{}
			for _, item := range items {
				asMap, _ := item.(map[string]any)
				if asMap != nil && stringValue(asMap["tableID"]) == id {
					continue
				}
				filtered = append(filtered, item)
			}
			obj[group] = filtered
		}
		*demoted = append(*demoted, fmt.Sprintf("%s：表 %s 及其解读已剔除", why, id))
	}
	dropColumn := func(columnID string) bool {
		for _, table := range tables() {
			columns, _ := table["columns"].([]any)
			found := false
			for _, column := range columns {
				if asMap, _ := column.(map[string]any); asMap != nil && stringValue(asMap["id"]) == columnID {
					found = true
				}
			}
			if !found {
				continue
			}
			keptColumns := []any{}
			for _, column := range columns {
				if asMap, _ := column.(map[string]any); asMap != nil && stringValue(asMap["id"]) == columnID {
					continue
				}
				keptColumns = append(keptColumns, column)
			}
			table["columns"] = keptColumns
			rows, _ := table["rows"].([]any)
			for _, row := range rows {
				asMap, _ := row.(map[string]any)
				if asMap == nil {
					continue
				}
				cells, _ := asMap["cells"].([]any)
				keptCells := []any{}
				for _, cell := range cells {
					if asCell, _ := cell.(map[string]any); asCell != nil && stringValue(asCell["columnID"]) == columnID {
						continue
					}
					keptCells = append(keptCells, cell)
				}
				asMap["cells"] = keptCells
			}
			*demoted = append(*demoted, fmt.Sprintf("列 %s 摘录未过核验：该列已剔除", columnID))
			return true
		}
		return false
	}
	dropRow := func(rowID string) bool {
		for _, table := range tables() {
			rows, _ := table["rows"].([]any)
			found := false
			for _, row := range rows {
				if asMap, _ := row.(map[string]any); asMap != nil && stringValue(asMap["id"]) == rowID {
					found = true
				}
			}
			if !found {
				continue
			}
			keptRows := []any{}
			for _, row := range rows {
				if asMap, _ := row.(map[string]any); asMap != nil && stringValue(asMap["id"]) == rowID {
					continue
				}
				keptRows = append(keptRows, row)
			}
			table["rows"] = keptRows
			*demoted = append(*demoted, fmt.Sprintf("行 %s 摘录/数字未过核验：该行已剔除", rowID))
			return true
		}
		return false
	}

	for round := 0; round < 80; round++ {
		err := ValidateGenerated("results", mustJSON(obj), source)
		if err == nil {
			return &PruneResult{Value: prettyJSON(obj), Demoted: *demoted}
		}
		message := err.Error()
		if strings.Contains(message, "没有表格或有依据的结果分析") {
			// 全部条目被剔除后的诚实空态：一条「论文未说明」占位，降级清单说明原因。
			obj["statistics"] = []any{map[string]any{"k": "结果分析", "v": unknownValue, "page": nil, "excerpt": nil}}
			obj["tables"] = []any{}
			*demoted = append(*demoted, "全部结果条目均未通过逐字核验，面板保持未知（逐条清单见下）")
			continue
		}
		if match := missingFieldsRe.FindStringSubmatch(message); match != nil {
			for _, group := range strings.Split(match[1], "、") {
				if _, ok := obj[group].([]any); !ok {
					obj[group] = []any{}
				}
			}
			continue
		}
		if strings.Contains(message, "结果表 ID 重复") {
			seen := map[string]bool{}
			kept := []map[string]any{}
			for _, table := range tables() {
				id := stringValue(table["id"])
				if seen[id] {
					*demoted = append(*demoted, fmt.Sprintf("重复 id 的表 %s 已剔除", id))
					continue
				}
				seen[id] = true
				kept = append(kept, table)
			}
			setTables(kept)
			continue
		}
		if match := tableStructRe.FindStringSubmatch(message); match != nil {
			dropTable(strings.TrimSpace(match[1]), "表格结构无效")
			continue
		}
		if match := columnRe.FindStringSubmatch(message); match != nil {
			dropColumn(strings.TrimSpace(match[1]))
			continue
		}
		if match := rowRe.FindStringSubmatch(message); match != nil {
			if !dropRow(strings.TrimSpace(match[1])) {
				return nil
			}
			continue
		}
		if match := cellRe.FindStringSubmatch(message); match != nil {
			if !dropRow(strings.TrimSpace(match[1])) {
				return nil
			}
			continue
		}
		if match := quotedKeyRe.FindStringSubmatch(message); match != nil {
			key := match[1]
			if strings.Contains(key, "：") {
				key = strings.TrimSpace(strings.Split(key, "：")[0])
			} else {
				key = strings.TrimSpace(key)
			}
			// 统计项：降级为未知而不是整条丢弃。
			if statistics, ok := obj["statistics"].([]any); ok {
				acted := false
				for _, item := range statistics {
					asMap, _ := item.(map[string]any)
					if asMap != nil && stringValue(asMap["k"]) == key {
						asMap["v"] = unknownValue
						asMap["page"] = nil
						asMap["excerpt"] = nil
						*demoted = append(*demoted, fmt.Sprintf("统计「%s」未过核验：已标为「%s」", key, unknownValue))
						acted = true
						break
					}
				}
				if acted {
					continue
				}
			}
			acted := false
			for _, group := range discussionKeys {
				items, _ := obj[group].([]any)
				kept := []any{}
				removed := false
				for _, item := range items {
					asMap, _ := item.(map[string]any)
					evidence, _ := asMap["evidence"].(map[string]any)
					if asMap != nil && evidence != nil && stringValue(evidence["k"]) == key {
						removed = true
						continue
					}
					kept = append(kept, item)
				}
				if removed {
					obj[group] = kept
					*demoted = append(*demoted, fmt.Sprintf("解读「%s」摘录未过核验：该条解读已剔除", key))
					acted = true
					break
				}
			}
			if acted {
				continue
			}
			for _, table := range tables() {
				caption, _ := table["caption"].(map[string]any)
				header, _ := table["header"].(map[string]any)
				protocol, _ := table["protocol"].(map[string]any)
				if stringValue(fieldKey(caption)) == key || stringValue(fieldKey(header)) == key || stringValue(fieldKey(protocol)) == key {
					dropTable(stringValue(table["id"]), "表题/表头摘录未过核验")
					acted = true
					break
				}
				columns, _ := table["columns"].([]any)
				matchedColumn := ""
				for _, column := range columns {
					asMap, _ := column.(map[string]any)
					context, _ := asMap["context"].(map[string]any)
					unitEvidence, _ := asMap["unitEvidence"].(map[string]any)
					if stringValue(fieldKey(context)) == key || stringValue(fieldKey(unitEvidence)) == key {
						matchedColumn = stringValue(asMap["id"])
						break
					}
				}
				if matchedColumn != "" {
					dropColumn(matchedColumn)
					acted = true
					break
				}
				rows, _ := table["rows"].([]any)
				matchedRow := ""
				for _, row := range rows {
					asMap, _ := row.(map[string]any)
					evidence, _ := asMap["evidence"].(map[string]any)
					if stringValue(fieldKey(evidence)) == key {
						matchedRow = stringValue(asMap["id"])
						break
					}
				}
				if matchedRow != "" {
					dropRow(matchedRow)
					acted = true
					break
				}
			}
			if acted {
				continue
			}
			// 报错元素定位不到：无法安全收敛，交给未核验通道。
			return nil
		}
		return nil
	}
	return nil
}

func fieldKey(field map[string]any) any {
	if field == nil {
		return nil
	}
	return field["k"]
}

func stringValue(value any) string {
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func toField(value any) (Field, bool) {
	asMap, ok := value.(map[string]any)
	if !ok {
		return Field{}, false
	}
	body, err := json.Marshal(asMap)
	if err != nil {
		return Field{}, false
	}
	var field Field
	if err := json.Unmarshal(body, &field); err != nil {
		return Field{}, false
	}
	return field, true
}

func mustJSON(value any) string {
	body, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(body)
}

func prettyJSON(value any) string {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "{}"
	}
	return string(body)
}
