package citation

import (
	"strings"
	"testing"
	"time"
)

func TestArxivID(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   string
	}{
		{"abs 链接", []string{"https://arxiv.org/abs/2209.14540v1"}, "2209.14540"},
		{"pdf 链接", []string{"https://arxiv.org/pdf/2209.14540"}, "2209.14540"},
		{"arXiv 前缀", []string{"arXiv:2209.14540"}, "2209.14540"},
		{"裸号", []string{"2209.14540v2"}, "2209.14540v2"},
		{"旧式编号", []string{"https://arxiv.org/abs/cs/0701001"}, "cs/0701001"},
		{"DOI 里没有 arXiv 号", []string{"10.1007/978-3-031-16443-9_5"}, ""},
		{"多个值取第一个命中的", []string{"", "arXiv:1234.56789", "arXiv:9999.99999"}, "1234.56789"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ArxivID(tc.values...); got != tc.want {
				t.Fatalf("ArxivID(%v) = %q, want %q", tc.values, got, tc.want)
			}
		})
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name      string
		work      Work
		wantKind  Kind
		wantField string
	}{
		{"会议关键词", Work{Venue: "Proceedings of the IEEE Conference on Computer Vision"}, KindInProceedings, "booktitle"},
		{"已知会议缩写", Work{Venue: "ECCV 2022"}, KindInProceedings, "booktitle"},
		{"期刊关键词", Work{Venue: "IEEE Transactions on Medical Imaging"}, KindArticle, "journal"},
		{"期刊名", Work{Venue: "Nature"}, KindArticle, "journal"},
		{"中文期刊", Work{Venue: "中华放射学杂志"}, KindArticle, "journal"},
		{"无从判断的会场", Work{Venue: "Somewhere 2024"}, KindMisc, "howpublished"},
		{"只有 arXiv 号", Work{ArxivID: "2209.14540"}, KindMisc, "howpublished"},
		{"什么都没有", Work{}, KindMisc, "howpublished"},
		{"有会场时不以 arXiv 优先", Work{Venue: "ECCV 2022", ArxivID: "2209.14540"}, KindInProceedings, "booktitle"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Classify(tc.work)
			if got.Kind != tc.wantKind || got.Field != tc.wantField {
				t.Fatalf("Classify(%q) = (%s, %s), want (%s, %s)", tc.work.Venue, got.Kind, got.Field, tc.wantKind, tc.wantField)
			}
			if strings.TrimSpace(got.Basis) == "" {
				t.Fatal("判定依据不能为空：界面要披露它是怎么判的")
			}
		})
	}
}

func TestCiteKeyDeduplicates(t *testing.T) {
	used := map[string]int{}
	work := Work{Key: "2209.14540", Title: "NAF: Neural Attenuation Fields", Authors: []string{"Ruyi Zha"}, Year: 2022}
	first := CiteKey(work, used)
	if first != "zha2022naf" {
		t.Fatalf("首个 citekey = %q, want zha2022naf", first)
	}
	if second := CiteKey(work, used); second != "zha2022nafa" {
		t.Fatalf("冲突时应加后缀，得到 %q", second)
	}
	if third := CiteKey(work, used); third != "zha2022nafb" {
		t.Fatalf("第三个冲突应继续加后缀，得到 %q", third)
	}
}

func TestCiteKeyFallsBackToDocumentKey(t *testing.T) {
	used := map[string]int{}
	// 中文姓名与纯符号标题都取不到 ASCII 片段：退回文档键，不能生成空 bibkey。
	key := CiteKey(Work{Key: "cn-paper-1", Title: "《稀疏视角重建》", Authors: []string{"张三"}}, used)
	if !strings.HasPrefix(key, "cnpaper") {
		t.Fatalf("兜底 citekey = %q，期望来自文档键", key)
	}
	if key := CiteKey(Work{Key: "doc-2"}, used); key == "" || key[0] >= '0' && key[0] <= '9' {
		t.Fatalf("纯数字开头的 bibkey 不合法：%q", key)
	}
}

func TestBibTeXEscapesAndDiscloses(t *testing.T) {
	out := BibTeX([]Work{{
		Key:      "k1",
		Title:    "R&D costs: 50% of x_1 #2",
		Authors:  []string{"Ada Lovelace", "Ruyi Zha"},
		Year:     2022,
		Venue:    "ECCV 2022",
		DOI:      "10.1000/xyz",
		URL:      "https://example.org/paper",
		ArxivID:  "2209.14540",
		Keywords: []string{"CBCT", "sparse view"},
	}}, time.Unix(0, 0))
	for _, want := range []string{
		"@inproceedings{lovelace2022rd,",
		`title = {R\&D costs: 50\% of x\_1 \#2}`,
		"author = {Ada Lovelace and Ruyi Zha}",
		"booktitle = {ECCV 2022}",
		"eprint = {2209.14540}",
		"archivePrefix = {arXiv}",
		"keywords = {CBCT, sparse view}",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("BibTeX 缺少 %q\n---\n%s", want, out)
		}
	}
	if strings.Contains(out, "{50\\% of x_1") {
		t.Fatal("下划线没有被转义")
	}
}

func TestBibTeXMultiLineFieldsAreFlattened(t *testing.T) {
	out := BibTeX([]Work{{Key: "k", Title: "line one\nline two", Authors: []string{"A B"}, Year: 2020}}, time.Unix(0, 0))
	if !strings.Contains(out, "title = {line one line two}") {
		t.Fatalf("换行没有被压平：\n%s", out)
	}
}

func TestRISShape(t *testing.T) {
	out := RIS([]Work{{
		Key:     "k1",
		Title:   "Line\nBreak",
		Authors: []string{"Ada Lovelace"},
		Year:    2022,
		Venue:   "IEEE Transactions on Medical Imaging",
		DOI:     "10.1000/xyz",
	}}, time.Unix(0, 0))
	for _, want := range []string{
		"TY  - JOUR",
		"AU  - Ada Lovelace",
		"TI  - Line Break",
		"PY  - 2022",
		"JO  - IEEE Transactions on Medical Imaging",
		"DO  - 10.1000/xyz",
		"ER  - ",
	} {
		if !strings.Contains(out, want+"\n") {
			t.Fatalf("RIS 缺少 %q\n---\n%s", want, out)
		}
	}
	// 一篇一条记录：ER 只出现一次。
	if strings.Count(out, "ER  - ") != 1 {
		t.Fatalf("ER 行数不对：%d", strings.Count(out, "ER  - "))
	}
	if strings.Contains(out, "TY  - CONF") {
		t.Fatal("期刊论文不应输出 CONF")
	}
}

func TestSortedKeywords(t *testing.T) {
	got := SortedKeywords([]string{"sparse view", " CBCT "}, []string{"CBCT", ""})
	want := []string{"CBCT", "sparse view"}
	if len(got) != len(want) {
		t.Fatalf("去重失败：%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排序/去重不对：%v", got)
		}
	}
}
