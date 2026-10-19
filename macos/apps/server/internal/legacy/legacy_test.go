package legacy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArxivKeyMatchesLegacyTS(t *testing.T) {
	cases := []struct{ in, want string }{
		{"2209.14540", "2209.14540"},
		{"2209.14540v1", "2209.14540"},
		{"2209.14540v12", "2209.14540"},
		{"https://arxiv.org/abs/2209.14540v3", "2209.14540"},
		{"http://arxiv.org/abs/2401.00135", "2401.00135"},
		{"https://arxiv.org/pdf/2401.00135.pdf", "2401.00135"},
		{"arxiv:2401.00135", "2401.00135"},
		{"  2401.00135  ", "2401.00135"},
		{"2401.00135 v1", "2401.00135"},
		{"", ""},
	}
	for _, c := range cases {
		if got := ArxivKey(c.in); got != c.want {
			t.Fatalf("ArxivKey(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestDOIKey(t *testing.T) {
	for _, in := range []string{"https://doi.org/10.1234/X", "DOI:10.1234/x", "10.1234/x"} {
		if got := DOIKey(in); got != "10.1234/x" {
			t.Fatalf("DOIKey(%q) = %q", in, got)
		}
	}
}

func TestEntryKeyPrefersArxivThenID(t *testing.T) {
	if got := (Entry{Arxiv: "2209.14540v1", ID: "2022-naf"}).Key(); got != "2209.14540" {
		t.Fatalf("有 arxiv 时应用 arxiv，实际 %q", got)
	}
	if got := (Entry{ID: "intratomo-2021"}).Key(); got != "intratomo-2021" {
		t.Fatalf("无 arxiv 时应回落到 id，实际 %q", got)
	}
	if got := (Entry{}).Key(); got != "" {
		t.Fatalf("两者皆无应返回空串，实际 %q", got)
	}
}

func TestReadQueueShapes(t *testing.T) {
	dir := t.TempDir()
	object := filepath.Join(dir, "object.json")
	array := filepath.Join(dir, "array.json")
	broken := filepath.Join(dir, "broken.json")
	missing := filepath.Join(dir, "missing.json")
	stringAuthors := filepath.Join(dir, "string-authors.json")

	write := func(path, body string) {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(object, `{"papers":[{"id":"a","title":"A","year":"2021"},{"id":"b","title":"B"}]}`)
	write(array, `[{"id":"c","title":"C"}]`)
	write(broken, `{"papers":[`)
	write(stringAuthors, `{"papers":[{"id":"d","title":"D","authors":"X, Y","year":2024}]}`)

	entries, err := ReadQueue(object)
	if err != nil || len(entries) != 2 || entries[0].Key() != "a" {
		t.Fatalf("papers 形态解析失败: %v %v", entries, err)
	}
	entries, err = ReadQueue(array)
	if err != nil || len(entries) != 1 || entries[0].Key() != "c" {
		t.Fatalf("顶层数组形态解析失败: %v %v", entries, err)
	}
	if _, err := ReadQueue(broken); err == nil {
		t.Fatal("损坏 JSON 必须报错，不能当作空队列")
	}
	entries, err = ReadQueue(missing)
	if err != nil || entries != nil {
		t.Fatalf("文件不存在应视为空队列: %v %v", entries, err)
	}

	// authors 写成字符串、year 写成数字：都要容错而不是整批失败。
	entries, err = ReadQueue(stringAuthors)
	if err != nil {
		t.Fatalf("宽容解析失败: %v", err)
	}
	if len(entries) != 1 || len(entries[0].Authors) != 2 || entries[0].Authors[1] != "Y" {
		t.Fatalf("字符串 authors 应拆成数组，实际 %#v", entries)
	}
	if entries[0].ResolvedYear() != 2024 {
		t.Fatalf("数字 year 也应被取出，实际 %d", entries[0].ResolvedYear())
	}
}

func TestYearPreference(t *testing.T) {
	if got := (Entry{Published: "2026-08-24", Year: "2021"}).ResolvedYear(); got != 2026 {
		t.Fatalf("published 优先，实际 %d", got)
	}
	if got := (Entry{Year: "2021"}).ResolvedYear(); got != 2021 {
		t.Fatalf("year 回落失败，实际 %d", got)
	}
	if got := (Entry{Year: "在线首发"}).ResolvedYear(); got != 0 {
		t.Fatalf("无四位年份应得 0，实际 %d", got)
	}
	if got := (Entry{Published: "to appear 2019 later"}).ResolvedYear(); got != 0 {
		t.Fatalf("年份不在开头时不猜，实际 %d", got)
	}
}

func TestSplitPages(t *testing.T) {
	text := "前言丢弃\n=== Page 1 ===\n第一页 A\n=== Page 2 ===\n第二页 B\n=== Page 3 ===\n第三页 C"
	pages := SplitPages(text)
	if len(pages) != 3 {
		t.Fatalf("应切出 3 页，实际 %d", len(pages))
	}
	if pages[0].Number != 1 || pages[2].Number != 3 {
		t.Fatalf("页码解析错误: %v", pages)
	}
	if !contains(pages[1].Text, "第二页") {
		t.Fatalf("页内容错误: %q", pages[1].Text)
	}
	if contains(pages[0].Text, "前言") {
		t.Fatalf("首个标记前的内容不应进入任何页: %q", pages[0].Text)
	}
	if !contains(pages[2].Text, "第三页") {
		t.Fatalf("末页应取到文本结尾: %q", pages[2].Text)
	}
	if got := SplitPages("完全没有标记"); len(got) != 0 {
		t.Fatalf("无标记时应返回空，实际 %v", got)
	}
	// 页码乱序与重复：按页号排序，重复只留第一次。
	messy := SplitPages("=== Page 2 ===\nB\n=== Page 1 ===\nA\n=== Page 2 ===\nB-dup")
	if len(messy) != 2 || messy[0].Number != 1 || messy[1].Number != 2 {
		t.Fatalf("乱序/重复页处理错误: %v", messy)
	}
	if !contains(messy[1].Text, "B\n") || contains(messy[1].Text, "B-dup") {
		t.Fatalf("重复页应保留首次出现: %q", messy[1].Text)
	}
}

func TestReadTextCache(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "none-v3.txt")
	if pages, found, err := ReadTextCache(missing); err != nil || found || pages != nil {
		t.Fatalf("缺文件应返回 (nil,false,nil)，实际 %v %v %v", pages, found, err)
	}
	empty := filepath.Join(dir, "empty-v3.txt")
	if err := os.WriteFile(empty, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, found, err := ReadTextCache(empty); err != nil || found {
		t.Fatalf("空文件应视为无缓存: %v %v", found, err)
	}
	legacy := filepath.Join(dir, "legacy-v3.txt")
	if err := os.WriteFile(legacy, []byte("整篇没有页标记"), 0o600); err != nil {
		t.Fatal(err)
	}
	pages, found, err := ReadTextCache(legacy)
	if err != nil || !found || len(pages) != 1 || pages[0].Number != 1 {
		t.Fatalf("无标记的旧缓存应降级为单页: %v %v %v", pages, found, err)
	}
}

func TestPageHashStableAndDistinct(t *testing.T) {
	a := PageHash("同一内容")
	if b := PageHash("同一内容"); a != b {
		t.Fatal("同内容哈希必须一致")
	}
	if PageHash("同一内容 ") == a {
		t.Fatal("多一个空格就该变化，否则缓存更新检测失效")
	}
}

func TestIsOCRText(t *testing.T) {
	if !IsOCRText([]Page{{Number: 1, Text: "开头 " + OCRMarker + " 结尾"}}) {
		t.Fatal("含 OCR 标记应识别为 OCR 文本")
	}
	if IsOCRText([]Page{{Number: 1, Text: "正常文本层"}}) {
		t.Fatal("正常文本不应被判为 OCR")
	}
}

func TestPDFFileLookup(t *testing.T) {
	root := t.TempDir()
	paths := NewPaths(root)
	if err := os.MkdirAll(paths.LibraryDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"2209.14540.pdf", "NAF-2022-arxiv-2209.14540.pdf", "other.pdf", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(paths.LibraryDir(), name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if got, ok := paths.PDFFile("2209.14540"); !ok || filepath.Base(got) != "2209.14540.pdf" {
		t.Fatalf("完全同名应优先，实际 %q %v", got, ok)
	}
	if got, ok := paths.PDFFile("9999.00001"); ok || got != "" {
		t.Fatalf("不存在的键不应命中: %q %v", got, ok)
	}
	if got, ok := paths.PDFFile(""); ok || got != "" {
		t.Fatalf("空键应直接拒绝: %q %v", got, ok)
	}
	// 只有一个「包含但不等于」的文件时才用模糊匹配。
	fuzzyRoot := t.TempDir()
	fuzzy := NewPaths(fuzzyRoot)
	if err := os.MkdirAll(fuzzy.LibraryDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fuzzy.LibraryDir(), "NAF-2209.14540.pdf"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, ok := fuzzy.PDFFile("2209.14540"); !ok || filepath.Base(got) != "NAF-2209.14540.pdf" {
		t.Fatalf("包含匹配应作为兜底，实际 %q %v", got, ok)
	}
}

func TestPathsLayoutMatchesLegacy(t *testing.T) {
	paths := NewPaths(filepath.Join(string(filepath.Separator), "repo"))
	checks := map[string]string{
		paths.QueueFile():        "/repo/queue.json",
		paths.TextDir():          "/repo/library/text",
		paths.DataDir():          "/repo/app/data",
		paths.V2Dir():            "/repo/app/data/v2",
		paths.TextCacheFile("k"): "/repo/library/text/k-v3.txt",
		paths.ReadingFile("k"):   "/repo/app/data/readings/k.json",
		paths.LibraryStateFile(): "/repo/app/data/library.json",
		paths.ProgressFile():     "/repo/app/data/progress.json",
	}
	for got, want := range checks {
		if filepath.ToSlash(got) != want {
			t.Fatalf("路径应为 %s，实际 %s", want, got)
		}
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

func TestSafeFileStem(t *testing.T) {
	cases := []struct{ in, want string }{
		{"2209.14540", "2209.14540"},
		{"intratomo-2021", "intratomo-2021"},
		{"a b/c\\d", "a_b_c_d"},
		{"论文 2026", "2026"},
		{"...", "annotation"},
		{"", "annotation"},
		{strings.Repeat("a", 200), strings.Repeat("a", 80)},
	}
	for _, c := range cases {
		if got := SafeFileStem(c.in); got != c.want {
			t.Fatalf("SafeFileStem(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

// 列表接口用 LibraryPDFIndex 每请求只读一次目录，匹配结果必须与逐步调用的
// PDFFile 完全一致（含"包含匹配"回退），否则列表上的 HasPDF 会和详情页不一致。
func TestLibraryPDFIndexMatchesPDFFile(t *testing.T) {
	paths := NewPaths(t.TempDir())
	if err := os.MkdirAll(paths.LibraryDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"NAF-2209.14540.pdf", "2209.14540.pdf", "other.pdf", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(paths.LibraryDir(), name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	index := paths.LibraryPDFIndex()
	for _, key := range []string{"2209.14540", "14540", "NAF-2209.14540", "other", "OTHER", "missing", ""} {
		wantPath, wantOK := paths.PDFFile(key)
		gotPath, gotOK := index.Match(key)
		if wantOK != gotOK || wantPath != gotPath {
			t.Fatalf("key %q: PDFFile=(%q,%v) 与 index.Match=(%q,%v) 不一致", key, wantPath, wantOK, gotPath, gotOK)
		}
	}

	// 目录不存在时两者都返回未命中，而不是 panic。
	missing := NewPaths(filepath.Join(t.TempDir(), "nope"))
	if _, ok := missing.LibraryPDFIndex().Match("2209.14540"); ok {
		t.Fatal("目录不存在时不应命中")
	}
}
