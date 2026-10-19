// Package legacy 读取旧版 windows/ 的数据布局：queue.json、library/text 逐页缓存、
// app/data 下的 JSON 状态。v2 只读这些文件，绝不写回——避免两版同时改一份数据。
package legacy

import (
	"os"
	"path/filepath"
	"strings"
)

type Paths struct {
	Root string
}

func NewPaths(root string) Paths { return Paths{Root: root} }

func (p Paths) QueueFile() string  { return filepath.Join(p.Root, "queue.json") }
func (p Paths) PapersDir() string  { return filepath.Join(p.Root, "papers") }
func (p Paths) LibraryDir() string { return filepath.Join(p.Root, "library") }
func (p Paths) TextDir() string    { return filepath.Join(p.LibraryDir(), "text") }
func (p Paths) DataDir() string    { return filepath.Join(p.Root, "app", "data") }
func (p Paths) ConfigFile() string { return filepath.Join(p.Root, "app", "config.json") }

func (p Paths) LibraryStateFile() string { return filepath.Join(p.DataDir(), "library.json") }
func (p Paths) ProgressFile() string     { return filepath.Join(p.DataDir(), "progress.json") }
func (p Paths) ProfileFile() string      { return filepath.Join(p.DataDir(), "profile.json") }
func (p Paths) ReadingsDir() string      { return filepath.Join(p.DataDir(), "readings") }
func (p Paths) V2Dir() string            { return filepath.Join(p.DataDir(), "v2") }

// TextCacheFile 与旧版 store.pdfTextPath 同名同格式（v3 是按页带标记的抽取文本）。
// SafeFileStem 把论文键压成可放进下载文件名的片段。键本身已过 safekey 校验，
// 但导出文件名要再挡一次控制字符与超长名，避免 Content-Disposition 被塞进奇怪内容。
func SafeFileStem(key string) string {
	stem := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '-' || r == '_' || r == '.':
			return r
		default:
			return '_'
		}
	}, key)
	stem = strings.Trim(stem, "._")
	if stem == "" {
		stem = "annotation"
	}
	if len(stem) > 80 {
		stem = stem[:80]
	}
	return stem
}

func (p Paths) TextCacheFile(key string) string {
	return filepath.Join(p.TextDir(), key+"-v3.txt")
}

func (p Paths) ReadingFile(key string) string {
	return filepath.Join(p.ReadingsDir(), key+".json")
}

// PDFFile 找该论文的本地 PDF：旧版按文件名包含 key 匹配（arXiv id 命名）。
// 完全同名优先，其次大小写不敏感的包含匹配。
func (p Paths) PDFFile(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	entries, err := os.ReadDir(p.LibraryDir())
	if err != nil {
		return "", false
	}
	var fallback string
	needle := strings.ToLower(key)
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(name), ".pdf") {
			continue
		}
		if !strings.Contains(strings.ToLower(name), needle) {
			continue
		}
		candidate := filepath.Join(p.LibraryDir(), name)
		if strings.EqualFold(strings.TrimSuffix(name, filepath.Ext(name)), key) {
			return candidate, true
		}
		if fallback == "" {
			fallback = candidate
		}
	}
	return fallback, fallback != ""
}

// LibraryPDFIndex 是 library/ 目录的一次快照，匹配规则与 PDFFile 完全一致。
//
// 列表接口要对每一行回答"有没有 PDF"。逐行调用 PDFFile 会每行重读一次目录，
// 几百篇论文就是 O(篇数 × 文件数) 次目录枚举；这里改为每请求读一次。
type LibraryPDFIndex struct {
	// pdfs 是 library/ 下的 PDF 文件名（ReadDir 的字典序，与 PDFFile 的遍历顺序一致）。
	pdfs []string
	dir  string
}

// LibraryPDFIndex 读取一次目录。目录不存在时返回空索引（与 PDFFile 的失败语义一致）。
func (p Paths) LibraryPDFIndex() LibraryPDFIndex {
	entries, err := os.ReadDir(p.LibraryDir())
	if err != nil {
		return LibraryPDFIndex{dir: p.LibraryDir()}
	}
	pdfs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".pdf") {
			continue
		}
		pdfs = append(pdfs, entry.Name())
	}
	return LibraryPDFIndex{pdfs: pdfs, dir: p.LibraryDir()}
}

// Match 与 PDFFile 同规则：完全同名优先，其次第一个大小写不敏感的包含匹配。
func (idx LibraryPDFIndex) Match(key string) (string, bool) {
	if key == "" {
		return "", false
	}
	needle := strings.ToLower(key)
	var fallback string
	for _, name := range idx.pdfs {
		if !strings.Contains(strings.ToLower(name), needle) {
			continue
		}
		candidate := filepath.Join(idx.dir, name)
		if strings.EqualFold(strings.TrimSuffix(name, filepath.Ext(name)), key) {
			return candidate, true
		}
		if fallback == "" {
			fallback = candidate
		}
	}
	return fallback, fallback != ""
}
