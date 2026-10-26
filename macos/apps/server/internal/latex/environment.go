package latex

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// latexmk starts engines and bibliography tools by name. Finder may omit their
// directories even after we have detected the tools by absolute path. Extend
// only this build's environment, preserving the user's explicit PATH first.
func texProcessEnvironment(report ToolchainReport) []string {
	env := make([]string, 0, len(os.Environ())+1)
	pathKey, pathValue := "PATH", ""
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok && (key == "PATH" || runtime.GOOS == "windows" && strings.EqualFold(key, "PATH")) {
			pathKey, pathValue = key, value
			continue
		}
		env = append(env, entry)
	}
	dirs := filepath.SplitList(pathValue)
	seen := make(map[string]bool)
	normalize := func(dir string) string {
		dir = filepath.Clean(dir)
		if runtime.GOOS == "windows" {
			return strings.ToLower(dir)
		}
		return dir
	}
	for _, dir := range dirs {
		seen[normalize(dir)] = true
	}
	for _, tools := range [][]Toolchain{report.Engines, report.AuxTools} {
		for _, tool := range tools {
			if !tool.Usable || !filepath.IsAbs(tool.Path) {
				continue
			}
			dir := filepath.Dir(tool.Path)
			key := normalize(dir)
			if !seen[key] {
				seen[key] = true
				dirs = append(dirs, dir)
			}
		}
	}
	return append(env, pathKey+"="+strings.Join(dirs, string(os.PathListSeparator)))
}
