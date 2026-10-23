package latex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Toolchain 是本机某个可执行文件的探测结果。
type Toolchain struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Version string `json:"version"`
	// Usable=false 时 Reason 说明为什么不能用——界面要如实显示，
	// 而不是让用户对着一句「编译失败」猜（本机 latexmk 就缺 Perl）。
	Usable bool   `json:"usable"`
	Reason string `json:"reason,omitempty"`
}

// ToolchainReport 是「本机能不能编译」的完整回答。
type ToolchainReport struct {
	Engines   []Toolchain `json:"engines"`
	AuxTools  []Toolchain `json:"auxTools"`
	Preferred string      `json:"preferred"`
	// Strategy 说明实际会怎么编译：latexmk 优先，不可用时用内置多趟。
	Strategy string `json:"strategy"`
	// Hints 是给人看的下一步建议（比如「装 MiKTeX 后重启应用」）。
	Hints []string `json:"hints"`
}

// 探针结果缓存：探测要起进程，界面每次刷新不该都付这个代价。
var (
	toolchainCache   *ToolchainReport
	toolchainCacheAt time.Time
	toolchainMu      sync.Mutex
)

const toolchainCacheTTL = 60 * time.Second

// knownEngineNames 是允许调用的引擎白名单：用户选的值只在这里面匹配，
// 永远不把项目里的字符串当成要执行的命令（规格 §12）。
var knownEngineNames = map[string]bool{
	"pdflatex": true, "xelatex": true, "lualatex": true, "latexmk": true,
	"bibtex": true, "biber": true, "makeindex": true,
}

// engineCandidates 额外搜索这些目录：装完 TeX 常常没把 bin 放进 PATH
// （应用重启前 PATH 也不会更新），不主动找就会误报「没装 TeX」。
//
// macOS 尤其需要这一步：MacTeX 把可执行文件放在 /Library/TeX/texbin，
// 图形界面应用继承到的 PATH 里通常没有它。
func engineCandidates(name string) []string {
	var dirs []string
	switch runtime.GOOS {
	case "windows":
		if local := os.Getenv("LOCALAPPDATA"); local != "" {
			dirs = append(dirs,
				filepath.Join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"),
				filepath.Join(local, "Programs", "MiKTeX", "miktex", "bin"),
			)
		}
		dirs = append(dirs,
			`C:\texlive\2025\bin\windows`, `C:\texlive\2024\bin\windows`,
			`C:\Program Files\MiKTeX\miktex\bin\x64`,
		)
	case "darwin":
		dirs = append(dirs,
			"/Library/TeX/texbin", // MacTeX
			"/usr/local/texlive/2025/bin/universal-darwin",
			"/usr/local/texlive/2024/bin/universal-darwin",
			"/opt/homebrew/bin", // Homebrew（Apple Silicon）
			"/usr/local/bin",
		)
	default:
		dirs = append(dirs, "/usr/bin", "/usr/local/bin")
	}
	extension := ""
	if runtime.GOOS == "windows" {
		extension = ".exe"
	}
	out := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		out = append(out, filepath.Join(dir, name+extension))
	}
	return out
}

// DetectToolchains 探测本机 TeX 工具链（带缓存）。
func DetectToolchains(ctx context.Context, refresh bool) ToolchainReport {
	toolchainMu.Lock()
	if !refresh && toolchainCache != nil && time.Since(toolchainCacheAt) < toolchainCacheTTL {
		cached := *toolchainCache
		toolchainMu.Unlock()
		return cached
	}
	toolchainMu.Unlock()

	report := ToolchainReport{Engines: []Toolchain{}, AuxTools: []Toolchain{}, Hints: []string{}}
	probe := func(name string) Toolchain {
		tool := Toolchain{Name: name}
		path, err := exec.LookPath(name)
		if err != nil {
			for _, candidate := range engineCandidates(name) {
				if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
					path = candidate
					break
				}
			}
		}
		if path == "" {
			tool.Reason = "没有在 PATH 或常见安装目录里找到"
			return tool
		}
		tool.Path = path
		tool.Usable = true
		tool.Version = probeVersion(ctx, path, versionArgs(name))
		if name == "latexmk" {
			// latexmk 是个 Perl 脚本：exe 在、Perl 不在时它照样「存在」但跑不起来。
			// 空跑一次才算真的可用（本机就是这种情况）。
			if err := probeRunnable(ctx, path, "-v"); err != nil {
				tool.Usable = false
				tool.Reason = shortenProbeError(err)
			}
		}
		return tool
	}

	for _, name := range []string{"pdflatex", "xelatex", "lualatex"} {
		report.Engines = append(report.Engines, probe(name))
	}
	for _, name := range []string{"bibtex", "biber", "latexmk"} {
		report.AuxTools = append(report.AuxTools, probe(name))
	}

	usableEngine := func() string {
		for _, tool := range report.Engines {
			if tool.Usable {
				return tool.Name
			}
		}
		return ""
	}
	for _, tool := range report.AuxTools {
		if tool.Name == "latexmk" && tool.Usable {
			report.Preferred = "latexmk"
		}
	}
	if report.Preferred == "" {
		report.Preferred = usableEngine()
		report.Strategy = "builtin-multipass"
	} else {
		report.Strategy = "latexmk"
	}
	if report.Preferred == "" {
		report.Strategy = "unavailable"
		report.Hints = append(report.Hints,
			"没有找到可用的 TeX 引擎。安装 MiKTeX 或 TeX Live 后重启 ReadX（应用启动时才会读到更新过的 PATH）。")
	}
	if report.Preferred != "" && report.Preferred != "latexmk" {
		for _, tool := range report.AuxTools {
			if tool.Name == "latexmk" && !tool.Usable && tool.Reason != "" {
				report.Hints = append(report.Hints,
					"latexmk 存在但不可用（"+tool.Reason+"），已改用内置多趟编译；装上 Perl 后会自动优先用 latexmk。")
			}
		}
	}
	// 中文文档要用 XeLaTeX/LuaLaTeX：pdflatex 直接编译中文会失败，早点说清楚。
	for _, tool := range report.Engines {
		if tool.Name == "xelatex" && !tool.Usable {
			report.Hints = append(report.Hints, "XeLaTeX 不可用：中文文档需要它（或 LuaLaTeX）。")
		}
	}

	toolchainMu.Lock()
	toolchainCache = &report
	toolchainCacheAt = time.Now()
	toolchainMu.Unlock()
	return report
}

func versionArgs(name string) []string {
	switch name {
	case "latexmk":
		return []string{"-v"}
	case "bibtex", "biber":
		return []string{"--version"}
	default:
		return []string{"--version"}
	}
}

func probeVersion(ctx context.Context, path string, args []string) string {
	runCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	output, err := exec.CommandContext(runCtx, path, args...).CombinedOutput()
	if err != nil && len(output) == 0 {
		return ""
	}
	text := strings.TrimSpace(string(output))
	if text == "" {
		return ""
	}
	// 只取第一行有意义的内容：版本号信息通常在头部，后面是版权声明。
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		return truncate(line, 120)
	}
	return ""
}

func probeRunnable(ctx context.Context, path string, args ...string) error {
	runCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(runCtx, path, args...).CombinedOutput()
	if err != nil {
		if len(output) > 0 {
			return errWithOutput{err: err, output: strings.TrimSpace(string(output))}
		}
		return err
	}
	return nil
}

type errWithOutput struct {
	err    error
	output string
}

func (e errWithOutput) Error() string { return e.err.Error() + ": " + e.output }
func (e errWithOutput) Unwrap() error { return e.err }

func shortenProbeError(err error) string {
	text := strings.TrimSpace(err.Error())
	// MiKTeX 的脚本引擎报错很长，取有信息量的那一句就够。
	if index := strings.Index(text, "could not find the script engine"); index >= 0 {
		return "缺少脚本引擎（Perl）"
	}
	return truncate(text, 160)
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…"
}

// resolveToolName 把项目里的引擎设置映射成白名单里的名字。
func resolveToolName(engine string) string {
	name := strings.ToLower(strings.TrimSpace(engine))
	if knownEngineNames[name] {
		return name
	}
	return "pdflatex"
}

// findTool 在探测结果里找可用工具。
func findTool(report ToolchainReport, name string) (Toolchain, bool) {
	for _, tool := range append(append([]Toolchain{}, report.Engines...), report.AuxTools...) {
		if tool.Name == name {
			return tool, tool.Usable
		}
	}
	return Toolchain{Name: name}, false
}

// sortedToolNames 只用于日志与测试的稳定输出。
func sortedToolNames(report ToolchainReport) []string {
	names := make([]string, 0, len(report.Engines)+len(report.AuxTools))
	for _, tool := range report.Engines {
		names = append(names, tool.Name)
	}
	for _, tool := range report.AuxTools {
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	return names
}
