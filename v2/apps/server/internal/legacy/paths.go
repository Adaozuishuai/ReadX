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
