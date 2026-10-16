// Package catalog 的 repoaudit.go：移植旧版 windows/src/core/reproduction.ts 的 R-11 仓库依赖核对。
//
// 纯函数，不执行仓库代码、不发网络请求——清单只做「核对提示」，不做穷举。
package catalog

import (
	"strconv"
	"strings"
)

// DependencyFileNames 依赖声明文件（小写比较）。
var DependencyFileNames = map[string]bool{
	"requirements.txt": true, "environment.yml": true, "environment.yaml": true,
	"conda.yml": true, "conda.yaml": true, "setup.py": true, "pyproject.toml": true,
	"pipfile": true, "pipfile.lock": true, "package.json": true,
}

// DataURLHints 数据集下载线索。
var DataURLHints = []string{"drive.google.com", "zenodo", "huggingface.co", "figshare", "dropbox.com", "gdown"}

// WeightHints 权重 / 检查点线索。
var WeightHints = []string{"checkpoint", "weights", "pretrained", ".pth", ".ckpt"}

// CodeFile 移植所需的代码快照子集：只需要文件路径与逐行文本。
type CodeFile struct {
	Path  string
	Lines []string
}

// RepoDependencyCheck 一条仓库核对项。
type RepoDependencyCheck struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"` // 依赖 / 数据 / 权重
	Detail string `json:"detail"`
	Line   *int   `json:"line"`
	ID     string `json:"id"`
}

// RepoCheckID 与 TS repoCheckID 一致：kind|path[:line]。
func RepoCheckID(kind, path string, line *int) string {
	id := kind + "|" + path
	if line != nil {
		id += ":" + strconv.Itoa(*line)
	}
	return id
}

// RepoAuditChecks 与 TS repoAuditChecks 一致：从代码快照提取依赖声明文件与数据/权重下载指引。
func RepoAuditChecks(files []CodeFile) []RepoDependencyCheck {
	out := []RepoDependencyCheck{}
	for _, file := range files {
		segments := strings.Split(file.Path, "/")
		name := strings.ToLower(segments[len(segments)-1])
		if DependencyFileNames[name] {
			out = append(out, RepoDependencyCheck{
				Path: file.Path, Kind: "依赖",
				Detail: "发现依赖声明文件，需与论文环境声明核对并实际安装验证。",
				Line:   nil, ID: RepoCheckID("依赖", file.Path, nil),
			})
		}
		for offset, rawLine := range file.Lines {
			// 超长行（压缩过的 js、base64）不参与扫描，避免把整包内容当依赖。
			if len([]rune(rawLine)) >= 500 {
				continue
			}
			line := strings.TrimSpace(rawLine)
			lower := strings.ToLower(line)
			if !strings.Contains(lower, "http") {
				continue
			}
			isWeight := containsAny(lower, WeightHints)
			isData := containsAny(lower, DataURLHints) ||
				(strings.Contains(lower, "download") && (strings.Contains(lower, "data") || strings.Contains(lower, "dataset")))
			if isWeight {
				lineNumber := offset + 1
				out = append(out, newRepoCheck(file.Path, "权重", "疑似权重/检查点下载指引："+truncateRunes(line, 160), &lineNumber))
			} else if isData {
				lineNumber := offset + 1
				out = append(out, newRepoCheck(file.Path, "数据", "疑似数据集下载指引："+truncateRunes(line, 160), &lineNumber))
			}
		}
	}
	seen := map[string]bool{}
	deduped := []RepoDependencyCheck{}
	for _, check := range out {
		if seen[check.ID] {
			continue
		}
		seen[check.ID] = true
		deduped = append(deduped, check)
		if len(deduped) >= 12 { // 清单只做「核对提示」，不做穷举
			break
		}
	}
	return deduped
}

func newRepoCheck(path, kind, detail string, line *int) RepoDependencyCheck {
	return RepoDependencyCheck{Path: path, Kind: kind, Detail: detail, Line: line, ID: RepoCheckID(kind, path, line)}
}

func containsAny(haystack string, needles []string) bool {
	for _, needle := range needles {
		if strings.Contains(haystack, needle) {
			return true
		}
	}
	return false
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}
