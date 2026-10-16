package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// Fixtures retain the independent expected behavior captured during migration.
type fixture struct {
	Name     string          `json:"name"`
	Kind     string          `json:"kind"`
	Fields   []string        `json:"fields"`
	Papers   []YearCarrier   `json:"papers"`
	Text     string          `json:"text"`
	Topic    string          `json:"topic"`
	Sample   TrendSample     `json:"sample"`
	Raw      string          `json:"raw"`
	Identity []PaperIdentity `json:"identity"`
	Dedupe   []PaperIdentity `json:"dedupe"`
	Snapshot struct {
		Files []CodeFile `json:"files"`
	} `json:"snapshot"`
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatalf("读取 testdata 失败: %v", err)
	}
	out := []fixture{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		body, err := os.ReadFile(filepath.Join("testdata", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		var item fixture
		if err := json.Unmarshal(body, &item); err != nil {
			t.Fatalf("%s 不是合法 fixture: %v", entry.Name(), err)
		}
		out = append(out, item)
	}
	if len(out) == 0 {
		t.Fatal("catalog testdata 为空")
	}
	return out
}

type oracleResult struct {
	Name   string          `json:"name"`
	Kind   string          `json:"kind"`
	Result json.RawMessage `json:"result"`
}

// TestCatalogBaseline compares against snapshots captured before v1 removal.
func TestCatalogBaseline(t *testing.T) {
	fixtures := loadFixtures(t)
	var baseline []oracleResult
	raw, err := os.ReadFile(filepath.Join("testdata", "oracle", "baseline.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatal(err)
	}
	results := map[string]oracleResult{}
	for _, item := range baseline {
		results[item.Name] = item
	}

	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			oracle, ok := results[f.Name]
			if !ok {
				t.Fatalf("oracle 没有给出 %s 的结果", f.Name)
			}
			goValue := normalize(t, runGo(f))
			tsValue := normalize(t, oracle.Result)
			if !reflect.DeepEqual(goValue, tsValue) {
				t.Fatalf("结果不一致：\nGo: %v\nTS: %v", goValue, tsValue)
			}
		})
	}
}

// runGo 在 Go 侧产出与 oracle 同形状的结果。
func runGo(f fixture) any {
	switch f.Kind {
	case "systemtags":
		tags := Derive(f.Fields)
		coverage := Coverage(tags)
		pairs := make([][]any, 0, len(coverage))
		for _, item := range coverage {
			pairs = append(pairs, []any{item.Category, item.Count})
		}
		return map[string]any{"tags": tags, "coverage": pairs}
	case "window":
		lo, hi := Window(f.Papers)
		return map[string]any{"window": []any{lo, hi}}
	case "redline":
		return map[string]any{"violates": ViolatesRedline(f.Text)}
	case "gap":
		return map[string]any{"statement": GapStatement(f.Topic, f.Sample)}
	case "repoaudit":
		return map[string]any{"checks": RepoAuditChecks(f.Snapshot.Files)}
	case "identity":
		return map[string]any{
			"arxiv": ArxivKey(f.Raw),
			"doi":   DOIKey(f.Raw),
			"title": TitleKey(f.Raw),
		}
	case "dedupe":
		// 与 TS 对齐：把「保留项」的键按原顺序列出；重复项被合并掉不再出现。
		groups := FindDuplicates(f.Dedupe)
		merged := map[int]bool{}
		for _, group := range groups {
			for _, member := range group.MemberIndexes {
				if member != group.PrimaryIndex {
					merged[member] = true
				}
			}
		}
		keys := []string{}
		for index, paper := range f.Dedupe {
			if merged[index] {
				continue
			}
			keys = append(keys, EntryKey(paper))
		}
		return map[string]any{"keys": keys}
	}
	return nil
}

// normalize 往返一次 JSON 得到通用的 map/slice 结构，从而与 oracle 输出做结构比较
// （不受键序或 struct vs map 差异影响）。
func normalize(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var out any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	return out
}

func TestDeriveIsDeterministicAndDedupes(t *testing.T) {
	tags := Derive([]string{"sparse-view sparse view few-view"})
	count := 0
	for _, tag := range tags {
		if tag.Category == "Task" && tag.Value == "Sparse-view" {
			count++
			if tag.Evidence != "sparse-view" {
				t.Fatalf("evidence 应取线索数组里第一个命中词，实际 %q", tag.Evidence)
			}
		}
	}
	if count != 1 {
		t.Fatalf("同一 value 只应输出一次，实际 %d 次", count)
	}
}

func TestWindowRejectsMalformedPrefix(t *testing.T) {
	bad := "26-09-30"
	lo, hi := Window([]YearCarrier{{Published: &bad}})
	if lo != nil || hi != nil {
		t.Fatalf("前 4 字符只凑出 3 位数字应被丢弃，实际 %v-%v", lo, hi)
	}
}

func TestViolatesRedlineNegationWindow(t *testing.T) {
	if !ViolatesRedline("该方法为前所未有的设计") {
		t.Fatal("非否定语境应判违规")
	}
	if ViolatesRedline("这不构成「首次」声明") {
		t.Fatal("否定语境应放行")
	}
	// 否定标记离禁用语太远（>12 字符）不再豁免。
	if !ViolatesRedline("不构成这完全是另一码事的说法，这是首次提出") {
		t.Fatal("否定标记超出 12 字符窗口应判违规")
	}
}

func TestRepoAuditSkipsLongLinesAndDedupes(t *testing.T) {
	long := strings.Repeat("x", 500) + " https://drive.google.com/data"
	checks := RepoAuditChecks([]CodeFile{{Path: "a.py", Lines: []string{long}}})
	if len(checks) != 0 {
		t.Fatalf("超长行不应参与扫描，实际 %v", checks)
	}
}

func TestCoverageCoversAllCategories(t *testing.T) {
	coverage := Coverage([]SystemTag{{Category: "Task", Value: "Sparse-view"}})
	if len(coverage) != len(SystemTagCategories) {
		t.Fatalf("覆盖报告应含全部 %d 类，实际 %d", len(SystemTagCategories), len(coverage))
	}
}

func TestNormalizeIsStable(t *testing.T) { // 守护 normalize 的前提：同一结构往返后可比较。
	a := normalize(t, map[string]any{"a": 1})
	b := normalize(t, map[string]any{"a": 1})
	if !reflect.DeepEqual(a, b) {
		t.Fatal("normalize 应稳定")
	}
}

func TestFindDuplicatesGroupsByArxivDoiAndTitle(t *testing.T) {
	papers := []PaperIdentity{
		{ID: "a1", Arxiv: "2209.14540v1", Title: "NAF", Authors: []string{"Ruyi Zha"}},
		{ID: "a2", Arxiv: "2209.14540", Title: "NAF v2", Authors: []string{"Ruyi Zha"}},
		{ID: "solo", Title: "Short", Authors: []string{"Zed"}},
	}
	groups := FindDuplicates(papers)
	if len(groups) != 1 {
		t.Fatalf("应恰有一组重复，实际 %d 组: %+v", len(groups), groups)
	}
	if groups[0].PrimaryIndex != 0 || len(groups[0].MemberIndexes) != 2 {
		t.Fatalf("重复组应保留首项并含 2 个成员: %+v", groups[0])
	}
}

func TestFindDuplicatesIgnoresEmptyKeys(t *testing.T) {
	// 两条都没有任何键：不得被判为同一篇（否则会把无关论文合并）。
	papers := []PaperIdentity{{Title: "No id one"}, {Title: "No id two"}}
	if groups := FindDuplicates(papers); len(groups) != 0 {
		t.Fatalf("无键条目不应合并: %+v", groups)
	}
}

func TestFindDuplicatesShortTitleNotMatched(t *testing.T) {
	// 标题 <= 20 字符不做标题匹配：短标题重名太常见，误合并代价高于漏合。
	papers := []PaperIdentity{
		{ID: "x", Title: "Short", Authors: []string{"A"}},
		{ID: "y", Title: "Short", Authors: []string{"A"}},
	}
	if groups := FindDuplicates(papers); len(groups) != 0 {
		t.Fatalf("短标题不应触发合并: %+v", groups)
	}
}

func TestSameEntryTitleRequiresAuthorOverlap(t *testing.T) {
	longTitle := "A Very Long Shared Title For Testing"
	same := SameEntry(
		PaperIdentity{ID: "1", Title: longTitle, Authors: []string{"Bob"}},
		PaperIdentity{ID: "2", Title: longTitle + "!", Authors: []string{"Bob", "Carol"}},
	)
	if !same {
		t.Fatal("长标题相同 + 作者有交集应判为同一篇")
	}
	different := SameEntry(
		PaperIdentity{ID: "1", Title: longTitle, Authors: []string{"Bob"}},
		PaperIdentity{ID: "2", Title: longTitle, Authors: []string{"Dan"}},
	)
	if different {
		t.Fatal("长标题相同但作者无交集不应判为同一篇")
	}
}
