package validate

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type fixture struct {
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Source  string          `json:"source"`
	Payload json.RawMessage `json:"payload"`
	Visuals []Visual        `json:"visuals"`
	Expect  struct {
		OK bool `json:"ok"`
	} `json:"expect"`
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
		t.Fatal("testdata 为空：先跑 node scripts/gen-fixtures.mjs")
	}
	return out
}

// runGoValidator 在 Go 侧执行与 oracle 完全相同的校验序列。
func runGoValidator(f fixture) error {
	switch f.Kind {
	case "extraction":
		var extraction ExperimentExtraction
		if err := json.Unmarshal(f.Payload, &extraction); err != nil {
			return err
		}
		if err := ValidateExtraction(extraction, f.Source); err != nil {
			return err
		}
		return ValidateConfiguration(extraction)
	case "evidence":
		var output string
		if err := json.Unmarshal(f.Payload, &output); err != nil {
			return err
		}
		return ValidateEvidence(output, f.Source)
	case "results":
		analysis, err := DecodeResultsAnalysis(string(f.Payload))
		if err != nil {
			return err
		}
		if err := ValidateBindings(analysis, f.Visuals); err != nil {
			return err
		}
		return ValidateResults(analysis, f.Source)
	case "reproduction":
		analysis, err := DecodeReproductionAnalysis(string(f.Payload))
		if err != nil {
			return err
		}
		return ValidateReproductionAnalysis(analysis, f.Source)
	case "idea":
		var evidence IdeaEvidence
		if err := json.Unmarshal(f.Payload, &evidence); err != nil {
			return err
		}
		return ValidateIdeaEvidence(evidence, f.Source)
	default:
		return &ValidationError{Message: "未知 fixture kind: " + f.Kind}
	}
}

// TestFixtureExpectations 不依赖 node：fixture 自带的期望值先钉住 Go 侧行为。
func TestFixtureExpectations(t *testing.T) {
	for _, f := range loadFixtures(t) {
		if strings.HasPrefix(f.Kind, "prune-") {
			continue // 修剪层由 TestPruneBaseline 覆盖
		}
		t.Run(f.Name, func(t *testing.T) {
			err := runGoValidator(f)
			if f.Expect.OK && err != nil {
				t.Fatalf("期望通过，实际报错: %v", err)
			}
			if !f.Expect.OK && err == nil {
				t.Fatal("期望报错，实际通过")
			}
		})
	}
}

type oracleVerdict struct {
	Name  string `json:"name"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// TestValidationBaseline preserves the independently captured migration contract.
func TestValidationBaseline(t *testing.T) {
	fixtures := loadFixtures(t)
	var baseline []oracleVerdict
	raw, err := os.ReadFile(filepath.Join("testdata", "oracle", "baseline.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatal(err)
	}
	verdicts := map[string]oracleVerdict{}
	for _, item := range baseline {
		verdicts[item.Name] = item
	}

	for _, f := range fixtures {
		if strings.HasPrefix(f.Kind, "prune-") {
			continue
		}
		t.Run(f.Name, func(t *testing.T) {
			verdict, ok := verdicts[f.Name]
			if !ok {
				t.Fatalf("oracle 没有给出 %s 的判定", f.Name)
			}
			goErr := runGoValidator(f)
			goOK := goErr == nil
			if goOK != verdict.OK {
				t.Fatalf("判定不一致：Go=%v TS=%v（Go err=%v；TS err=%s）", goOK, verdict.OK, goErr, verdict.Error)
			}
			goMessage := ""
			if goErr != nil {
				goMessage = goErr.Error()
			}
			if goMessage != verdict.Error {
				t.Fatalf("错误文案不一致：\nGo: %s\nTS: %s", goMessage, verdict.Error)
			}
		})
	}
}

type pruneVerdict struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Pruned *struct {
		Value   any      `json:"value"`
		Demoted []string `json:"demoted"`
	} `json:"pruned"`
}

// TestPruneBaseline checks content and demotions without a legacy runtime.
func TestPruneBaseline(t *testing.T) {
	fixtures := []fixture{}
	for _, f := range loadFixtures(t) {
		if strings.HasPrefix(f.Kind, "prune-") {
			fixtures = append(fixtures, f)
		}
	}
	var baseline []pruneVerdict
	raw, err := os.ReadFile(filepath.Join("testdata", "oracle", "baseline.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &baseline); err != nil {
		t.Fatal(err)
	}
	verdicts := map[string]pruneVerdict{}
	for _, item := range baseline {
		verdicts[item.Name] = item
	}

	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			verdict, ok := verdicts[f.Name]
			if !ok {
				t.Fatalf("oracle 没有给出 %s 的判定", f.Name)
			}
			kind := strings.TrimPrefix(f.Kind, "prune-")
			goPruned := PruneGenerated(kind, string(f.Payload), f.Source)

			if (goPruned == nil) != (verdict.Pruned == nil) {
				t.Fatalf("收敛性不一致：Go=%v TS=%v", goPruned != nil, verdict.Pruned != nil)
			}
			if goPruned == nil {
				return
			}
			var goValue any
			if err := json.Unmarshal([]byte(goPruned.Value), &goValue); err != nil {
				t.Fatalf("Go 修剪结果不是合法 JSON: %v", err)
			}
			if !reflect.DeepEqual(goValue, verdict.Pruned.Value) {
				t.Fatalf("修剪结果不一致：\nGo: %s\nTS: %s", goPruned.Value, mustJSON(verdict.Pruned.Value))
			}
			if !reflect.DeepEqual(goPruned.Demoted, verdict.Pruned.Demoted) {
				t.Fatalf("降级清单不一致：\nGo: %v\nTS: %v", goPruned.Demoted, verdict.Pruned.Demoted)
			}
		})
	}
}

func TestNormalizedMatchesKnownCases(t *testing.T) {
	cases := []struct{ in, want string }{
		{"ＡＢＣ", "abc"},                    // 全角 → NFKC
		{"Bag-of-words", "bagofwords"},    // 词中连字符去掉
		{"attenu-\nation", "attenuation"}, // 跨行断词
		{"33.05 − 29.10", "33.05-29.10"},  // Unicode 负号归一
		{"a  b\nc", "abc"},                // 空白全去
	}
	for _, c := range cases {
		if got := Normalized(c.in); got != c.want {
			t.Fatalf("Normalized(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestNumbersExcludesWordEmbeddedDigits(t *testing.T) {
	numbers := Numbers("IntraTomo3D uses RTX3090 and 1.2GB with 5×10 - 4 views")
	for _, want := range []string{"3090", "1.2", "5", "-4"} {
		if !numbers[want] {
			t.Fatalf("应保留 %q，实际集合 %v", want, keys(numbers))
		}
	}
	if numbers["3"] {
		t.Fatalf("方法名 IntraTomo3D 里的 3 必须被排除，实际 %v", keys(numbers))
	}
}

func keys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sortStrings(out)
	return out
}

func sortStrings(items []string) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && items[j] < items[j-1]; j-- {
			items[j], items[j-1] = items[j-1], items[j]
		}
	}
}
