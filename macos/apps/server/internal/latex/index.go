package latex

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Index 是项目的轻量索引：补全用的键，以及「用了但没定义」的键。
//
// 为什么要服务端算：补全需要全部 .bib 与 .tex 的内容，让前端为每个项目把所有源码
// 拉一遍既慢又浪费；而「引用了不存在的键」是编译必然报错的硬问题，
// 在这里一次扫描就能给出确定性结论，不必等编译失败。
type Index struct {
	Citations        []string `json:"citations"`
	Labels           []string `json:"labels"`
	UsedCitations    []string `json:"usedCitations"`
	UsedLabels       []string `json:"usedLabels"`
	MissingCitations []string `json:"missingCitations"`
	MissingLabels    []string `json:"missingLabels"`
	ScannedFiles     int      `json:"scannedFiles"`
}

var (
	bibEntryPattern = regexp.MustCompile(`@[A-Za-z]+\s*[{(]\s*([^,\s}]+)\s*,`)
	labelPattern    = regexp.MustCompile(`\\label\{([^}]+)\}`)
	citePattern     = regexp.MustCompile(`\\cite[a-zA-Z]*\s*(?:\[[^\]]*\])*\s*\{([^}]+)\}`)
	refPattern      = regexp.MustCompile(`\\(?:ref|eqref|autoref|cref|Cref)\{([^}]+)\}`)
)

// 单文件扫描上限：索引是给补全用的，超大文件（例如别人塞进来的日志）直接跳过。
const maxIndexFileBytes = 4 << 20

func (s *Service) Index(ctx context.Context, projectID string) (*Index, error) {
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	index := &Index{
		Citations: []string{}, Labels: []string{},
		UsedCitations: []string{}, UsedLabels: []string{},
		MissingCitations: []string{}, MissingLabels: []string{},
	}
	citations := map[string]bool{}
	labels := map[string]bool{}
	usedCitations := map[string]bool{}
	usedLabels := map[string]bool{}

	var walk func(dir string) error
	walk = func(dir string) error {
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				return nil
			}
			return readErr
		}
		for _, entry := range entries {
			full := filepath.Join(dir, entry.Name())
			info, infoErr := entry.Info()
			if infoErr != nil || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				if err := walk(full); err != nil {
					return err
				}
				continue
			}
			if info.Size() > maxIndexFileBytes {
				continue
			}
			extension := strings.ToLower(filepath.Ext(entry.Name()))
			switch extension {
			case ".bib", ".tex":
			default:
				continue
			}
			content, readErr := os.ReadFile(full)
			if readErr != nil {
				continue
			}
			index.ScannedFiles++
			text := string(content)
			if extension == ".bib" {
				for _, match := range bibEntryPattern.FindAllStringSubmatch(text, -1) {
					if key := strings.TrimSpace(match[1]); key != "" {
						citations[key] = true
					}
				}
				continue
			}
			for _, match := range labelPattern.FindAllStringSubmatch(stripTeXComments(text), -1) {
				if key := strings.TrimSpace(match[1]); key != "" {
					labels[key] = true
				}
			}
			body := stripTeXComments(text)
			for _, match := range citePattern.FindAllStringSubmatch(body, -1) {
				for _, key := range strings.Split(match[1], ",") {
					if trimmed := strings.TrimSpace(key); trimmed != "" {
						usedCitations[trimmed] = true
					}
				}
			}
			for _, match := range refPattern.FindAllStringSubmatch(body, -1) {
				for _, key := range strings.Split(match[1], ",") {
					if trimmed := strings.TrimSpace(key); trimmed != "" {
						usedLabels[trimmed] = true
					}
				}
			}
		}
		return nil
	}
	if err := walk(srcDir); err != nil {
		return nil, err
	}

	index.Citations = sortedKeys(citations)
	index.Labels = sortedKeys(labels)
	index.UsedCitations = sortedKeys(usedCitations)
	index.UsedLabels = sortedKeys(usedLabels)
	// 缺失 = 用了但项目里没有定义。这正是编译时会报 "undefined citation/reference" 的那批。
	index.MissingCitations = difference(index.UsedCitations, citations)
	index.MissingLabels = difference(index.UsedLabels, labels)
	return index, nil
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func difference(used []string, defined map[string]bool) []string {
	out := []string{}
	for _, key := range used {
		if !defined[key] {
			out = append(out, key)
		}
	}
	return out
}

// stripTeXComments 去掉注释行：注释里的 \cite/\label 不该参与索引，
// 否则用户会看到一堆「引用了不存在的键」的假警报。
func stripTeXComments(text string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if index := strings.IndexByte(line, '%'); index >= 0 {
			// 只处理非转义的 %：`\%` 是字面百分号。
			escaped := index > 0 && line[index-1] == '\\'
			if !escaped {
				line = line[:index]
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}
