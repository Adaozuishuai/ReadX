package validate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ResultCell 与 TS ResultCell 对应。
type ResultCell struct {
	ColumnID        string  `json:"columnID"`
	ValueText       string  `json:"valueText"`
	UncertaintyText *string `json:"uncertaintyText"`
}

// ResultColumn 与 TS ResultColumn 对应；单位是「被报告的事实」，不是从指标名推断的。
type ResultColumn struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Metric       string `json:"metric"`
	Unit         string `json:"unit"`
	Context      Field  `json:"context"`
	UnitEvidence *Field `json:"unitEvidence"`
}

// ResultRow 与 TS ResultRow 对应。
type ResultRow struct {
	ID       string       `json:"id"`
	Method   string       `json:"method"`
	Evidence Field        `json:"evidence"`
	Cells    []ResultCell `json:"cells"`
}

// ResultTable 与 TS ResultTable 对应。
type ResultTable struct {
	ID              string         `json:"id"`
	Caption         Field          `json:"caption"`
	Header          Field          `json:"header"`
	Protocol        Field          `json:"protocol"`
	Columns         []ResultColumn `json:"columns"`
	Rows            []ResultRow    `json:"rows"`
	PrimaryMethodID *string        `json:"primaryMethodID"`
}

// ResultDiscussion 与 TS ResultDiscussion 对应。
type ResultDiscussion struct {
	Evidence       Field   `json:"evidence"`
	Interpretation string  `json:"interpretation"`
	TableID        *string `json:"tableID"`
	VisualID       *string `json:"visualID"`
}

// ResultsAnalysis 与 TS ResultsAnalysis 对应。
type ResultsAnalysis struct {
	Tables         []ResultTable      `json:"tables"`
	Stability      []ResultDiscussion `json:"stability"`
	Ablation       []ResultDiscussion `json:"ablation"`
	Generalization []ResultDiscussion `json:"generalization"`
	Efficiency     []ResultDiscussion `json:"efficiency"`
	// Statistics 只允许「作者报告过的」统计检验；绝不生成 p 值。
	Statistics []Field  `json:"statistics"`
	Missing    []string `json:"missing"`
}

// Visual 是绑定校验用的最小视图描述（id + kind）。
type Visual struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
}

var resultsArrayKeys = []string{"tables", "stability", "ablation", "generalization", "efficiency", "statistics", "missing"}

// DecodeResultsAnalysis 与 TS decodeResultsAnalysis 一致：去围栏、解析、检查必需数组字段。
// 缺字段在解码期就报错，而不是让后续校验崩在 nil 切片上。
func DecodeResultsAnalysis(raw string) (ResultsAnalysis, error) {
	text := strings.TrimSpace(raw)
	if strings.HasPrefix(text, "```") {
		lines := strings.Split(text, "\n")
		if len(lines) >= 2 {
			text = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	var probe any
	if err := json.Unmarshal([]byte(text), &probe); err != nil {
		return ResultsAnalysis{}, fmt.Errorf("结果分析不是合法 JSON：%w", err)
	}
	obj, ok := probe.(map[string]any)
	if !ok {
		return ResultsAnalysis{}, fmt.Errorf("结果分析必须是一个 JSON 对象。")
	}
	missing := []string{}
	for _, key := range resultsArrayKeys {
		if _, isArray := obj[key].([]any); !isArray {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return ResultsAnalysis{}, fmt.Errorf("结果分析缺少必需的字段（或不是数组）：%s。", strings.Join(missing, "、"))
	}
	var out ResultsAnalysis
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return ResultsAnalysis{}, fmt.Errorf("结果分析字段类型异常：%w", err)
	}
	return out, nil
}

// DiscussionGroups 与 TS discussionGroups 一致（顺序影响校验顺序）。
func DiscussionGroups(a ResultsAnalysis) []struct {
	ID    string
	Items []ResultDiscussion
} {
	return []struct {
		ID    string
		Items []ResultDiscussion
	}{
		{"稳定性 / 多数据集", a.Stability},
		{"消融", a.Ablation},
		{"泛化", a.Generalization},
		{"效率", a.Efficiency},
	}
}

func allDiscussions(a ResultsAnalysis) []ResultDiscussion {
	out := []ResultDiscussion{}
	for _, group := range DiscussionGroups(a) {
		out = append(out, group.Items...)
	}
	return out
}

// ValidateBindings 与 TS validateBindings 一致：解读必须绑定真实存在的表或图，表必须有解读。
func ValidateBindings(a ResultsAnalysis, visuals []Visual) error {
	tables := map[string]bool{}
	for _, t := range a.Tables {
		tables[t.ID] = true
	}
	figures := map[string]bool{}
	for _, v := range visuals {
		if v.Kind == "figure" {
			figures[v.ID] = true
		}
	}
	for _, item := range allDiscussions(a) {
		hasTable := item.TableID != nil
		hasVisual := item.VisualID != nil
		boundExists := false
		if hasTable {
			boundExists = tables[*item.TableID]
		} else if hasVisual {
			boundExists = figures[*item.VisualID]
		}
		if hasTable == hasVisual || !boundExists {
			return fmt.Errorf("每条结果解读必须绑定一张实际存在的表或图，不能悬空或同时绑定多个对象。")
		}
	}
	boundTables := map[string]bool{}
	for _, d := range allDiscussions(a) {
		if d.TableID != nil {
			boundTables[*d.TableID] = true
		}
	}
	for id := range tables {
		if !boundTables[id] {
			return fmt.Errorf("结果表缺少紧邻该表的解读。")
		}
	}
	return nil
}

var strictNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

// CellValue 与 TS cellValue 一致：只接受纯数字记法且有限。
func CellValue(cell ResultCell) (float64, bool) {
	if !strictNumber.MatchString(cell.ValueText) {
		return 0, false
	}
	value, err := strconv.ParseFloat(cell.ValueText, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// ValidateResults 与 TS validateResults 逐条对应，含位置敏感的列顺序校验。
func ValidateResults(a ResultsAnalysis, source string) error {
	fields := append([]Field{}, a.Statistics...)
	for _, group := range DiscussionGroups(a) {
		for _, discussion := range group.Items {
			fields = append(fields, discussion.Evidence)
		}
	}

	if len(a.Tables) == 0 && len(fields) == 0 {
		return fmt.Errorf("没有表格或有依据的结果分析")
	}
	seenIDs := map[string]bool{}
	for _, t := range a.Tables {
		if seenIDs[t.ID] {
			return fmt.Errorf("结果表 ID 重复")
		}
		seenIDs[t.ID] = true
	}

	for _, table := range a.Tables {
		fields = append(fields, table.Caption, table.Header, table.Protocol)
		for _, column := range table.Columns {
			fields = append(fields, column.Context)
		}
		for _, row := range table.Rows {
			fields = append(fields, row.Evidence)
		}
		for _, column := range table.Columns {
			if column.UnitEvidence != nil {
				fields = append(fields, *column.UnitEvidence)
			}
		}

		if table.PrimaryMethodID != nil {
			found := false
			for _, row := range table.Rows {
				if row.ID == *table.PrimaryMethodID {
					found = true
				}
			}
			if !found {
				return fmt.Errorf("本文方法不在该表的方法行中：%s", *table.PrimaryMethodID)
			}
		}
		columnIDsUnique := map[string]bool{}
		for _, column := range table.Columns {
			columnIDsUnique[column.ID] = true
		}
		rowIDsUnique := map[string]bool{}
		for _, row := range table.Rows {
			rowIDsUnique[row.ID] = true
		}
		if table.Caption.Page == nil || table.Header.Page == nil || len(table.Columns) == 0 ||
			len(table.Rows) < 2 || len(columnIDsUnique) != len(table.Columns) || len(rowIDsUnique) != len(table.Rows) {
			return fmt.Errorf("表格缺少表头、方法行或唯一标识：%s", table.ID)
		}

		for _, column := range table.Columns {
			if column.ID == "" || column.Label == "" || column.Metric == "" || column.Context.Page == nil {
				return fmt.Errorf("列缺少原文上下文：%s", column.ID)
			}
			if column.Unit != "论文未说明" {
				unitSource := column.Context
				if column.UnitEvidence != nil {
					unitSource = *column.UnitEvidence
				}
				excerpt := ""
				if unitSource.Excerpt != nil {
					excerpt = *unitSource.Excerpt
				}
				if !strings.Contains(Normalized(excerpt), Normalized(column.Unit)) || column.Unit == "" {
					return fmt.Errorf("列单位未被其摘录支持：%s", column.ID)
				}
			}
		}

		columnIDSet := map[string]bool{}
		for _, column := range table.Columns {
			columnIDSet[column.ID] = true
		}
		for _, row := range table.Rows {
			cellIDSet := map[string]bool{}
			for _, cell := range row.Cells {
				cellIDSet[cell.ColumnID] = true
			}
			sameSet := len(cellIDSet) == len(columnIDSet)
			if sameSet {
				for id := range cellIDSet {
					if !columnIDSet[id] {
						sameSet = false
						break
					}
				}
			}
			rowExcerpt := ""
			if row.Evidence.Excerpt != nil {
				rowExcerpt = *row.Evidence.Excerpt
			}
			if row.Evidence.Page == nil || row.Method == "" ||
				!strings.Contains(Normalized(rowExcerpt), Normalized(row.Method)) ||
				!sameSet || len(row.Cells) != len(table.Columns) {
				return fmt.Errorf("行标签或单元格不完整：%s", row.ID)
			}

			rowNumbers := Numbers(rowExcerpt)
			for _, cell := range row.Cells {
				value, okValue := CellValue(cell)
				_ = value
				cellNumbers := Numbers(cell.ValueText)
				supported := len(cellNumbers) > 0
				if supported {
					for n := range cellNumbers {
						if !rowNumbers[n] {
							supported = false
							break
						}
					}
				}
				if !okValue || !supported {
					return fmt.Errorf("单元格数字未匹配方法行：%s/%s = %s", row.ID, cell.ColumnID, cell.ValueText)
				}
				if cell.UncertaintyText != nil && len(*cell.UncertaintyText) > 0 {
					for n := range Numbers(*cell.UncertaintyText) {
						if !rowNumbers[n] {
							return fmt.Errorf("不确定性数值未匹配方法行：%s", row.ID)
						}
					}
				}
			}

			// 位置敏感校验：集合语义拦不住列置换（实测转置后可整体通过）。
			// 按表头列顺序在行摘录里顺序查找各单元格数值，拦住列错位。
			excerpt := Normalized(rowExcerpt)
			cursor := 0
			for _, column := range table.Columns {
				var cell *ResultCell
				for i := range row.Cells {
					if row.Cells[i].ColumnID == column.ID {
						cell = &row.Cells[i]
						break
					}
				}
				if cell == nil {
					continue
				}
				needle := Normalized(cell.ValueText)
				at := -1
				if needle != "" {
					at = strings.Index(excerpt[cursor:], needle)
					if at >= 0 {
						at += cursor
					}
				}
				if at < 0 {
					return fmt.Errorf("单元格数值未按表头列顺序排列，疑似列错位：%s/%s = %s。请对照 PDF 原表逐列核对后再输出。", row.ID, column.ID, cell.ValueText)
				}
				cursor = at + len(needle)
			}
		}
	}

	// 收尾：把所有收集到的字段再过一遍通用证据校验（与 TS 完全一致）。
	synthetic := ExperimentExtraction{Dataset: fields}
	return ValidateExtraction(synthetic, source)
}

// SortedKeys 用于复现指纹的稳定序列化（按键名递归排序）。
func sortedKeys(value any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sortedKeys(item))
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := map[string]any{}
		for _, key := range keys {
			out[key] = sortedKeys(typed[key])
		}
		return out
	default:
		return value
	}
}

// StableJSON 与 TS stableJSON 一致：递归按键排序后序列化。
func StableJSON(value any) string {
	body, err := json.Marshal(sortedKeys(value))
	if err != nil {
		return ""
	}
	return string(body)
}
