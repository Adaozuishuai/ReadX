package latex

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Diagnostic 是一条能直接点回源码的诊断信息。
type Diagnostic struct {
	Severity string `json:"severity"` // error | warning | info
	File     string `json:"file,omitempty"`
	Line     int    `json:"line,omitempty"`
	Message  string `json:"message"`
	// Source 是「谁报的」：LaTeX、Package lineno、Class IEEEtran…
	// 有些警告来自宏包而不是用户正文，标出来能省掉「我这一行看着没问题」的困惑。
	Source string `json:"source,omitempty"`
	// LocationSource 说明位置是怎么来的：
//   - "log"    —— 日志行直接给出的 file:line（最可信）；
//   - "search" —— 在项目源码里找到了这个引用键（\cite/\ref 的键），位置是确定的；
//   - "" —— 没有位置。警告常常说不出文件，硬猜会把人带错地方。
	LocationSource string `json:"locationSource,omitempty"`
	// Snippet 是出错处的源码片段（TeX 日志里的 l.NN 行，可能左边被截断）。
	Snippet string `json:"snippet,omitempty"`
	// Raw 是原始日志行：解析可能不完美，保留原文供用户自己判断。
	Raw string `json:"raw,omitempty"`
}

// LogSummary 是编译日志的解析结果。
type LogSummary struct {
	Errors      int          `json:"errors"`
	Warnings    int          `json:"warnings"`
	Diagnostics []Diagnostic `json:"diagnostics"`
	// NeedsBibtex / NeedsBiber / Rerun 供多趟编译决策使用。
	NeedsBibtex bool `json:"needsBibtex"`
	NeedsBiber  bool `json:"needsBiber"`
	Rerun       bool `json:"rerun"`
	// Pages 从日志里读出的页数（"Output written on x.pdf (3 pages"），没有则为 0。
	Pages int `json:"pages"`
	// MissingCitations / MissingReferences 是编译亲口说的「没找到」，
	// 比静态检查更权威。
	MissingCitations  []string `json:"missingCitations"`
	MissingReferences []string `json:"missingReferences"`
}

const maxDiagnostics = 200

var (
	// -file-line-error 格式：main.tex:12: Undefined control sequence.
	fileLineError = regexp.MustCompile(`^(?:\./)?([^:\n]+?):(\d+):\s*(.*)$`)
	// 传统格式：! Undefined control sequence. 后面跟 l.42
	bangError = regexp.MustCompile(`^!\s*(.*)$`)
	// 出错处的源码片段：l.42 \foo，长行会被 TeX 从左边截断成 l.42 ...foo。
	lineNumber = regexp.MustCompile(`^l\.(\d+)\s*(.*)$`)
	// Output written on main.pdf (3 pages, 12345 bytes).
	outputWritten = regexp.MustCompile(`Output written on .*?\((\d+) pages?`)
	// 警告要连「谁报的」一起取：Package lineno Warning: ...
	latexWarning = regexp.MustCompile(`^((?:LaTeX|Package\s+\S+|Class\s+\S+|pdfTeX))\s+Warning:\s*(.*)$`)
	// 警告自己带的输入行号：... undefined on input line 42.
	onInputLine = regexp.MustCompile(`(?i)\bon input line (\d+)`)
	// LaTeX Warning: Citation `foo' on page 1 undefined on input line 42.
	undefinedCitation  = regexp.MustCompile("Citation `([^']+)' .*undefined")
	undefinedReference = regexp.MustCompile("Reference `([^']+)' .*undefined")
	// 「有未定义引用」同样意味着必须再跑一趟：这一趟刚生成的 .aux/.bbl 要等下一趟才生效。
	rerunHint = regexp.MustCompile(`(?i)re-?run to get|there were undefined (?:references|citations)|label\(s\) may have changed`)
	overfull  = regexp.MustCompile(`^(Overfull|Underfull) \\([hv])box`)
	// 盒子溢出信息里的行号范围：Overfull \hbox ... at lines 40--42
	overfullLines = regexp.MustCompile(`at lines (\d+)`)
)

// unwrapLogLines 还原 MiKTeX/TeX 按 79 列做的折行。
//
// 不做这一步会漏掉关键信息：带 -output-directory 时，
// "Output written on C:/.../build/<id>/main.pdf (2 pages," 会被折断，
// 页数就永远解析不出来（真踩过）。
//
// 判据必须只看**上一条物理行**的长度：TeX 折行时那一段正好 79 个字符。
// 如果用「已拼接行的长度」判断，第一行（版本信息，本身就超过 79 字符）之后
// 会一路吞掉整份日志，所有诊断都解析不出来（也真踩过）。
func unwrapLogLines(text string) []string {
	rawLines := strings.Split(text, "\n")
	lines := make([]string, 0, len(rawLines))
	previousWasWrapped := false
	for _, raw := range rawLines {
		line := strings.TrimRight(raw, "\r")
		if previousWasWrapped && len(lines) > 0 {
			lines[len(lines)-1] += line
		} else {
			lines = append(lines, line)
		}
		previousWasWrapped = len(line) >= 79
	}
	return lines
}

// ParseLogText 解析 .log 文本。
//
// 原则是「宁可少报也不要错报」：认不出的行不猜，只把确定是错误/警告的行报出来，
// 并尽量带上文件、行号与源码片段——界面上要能点回具体那一行。
func ParseLogText(text string) LogSummary {
	summary := LogSummary{Diagnostics: []Diagnostic{}, MissingCitations: []string{}, MissingReferences: []string{}}
	lines := unwrapLogLines(text)

	currentFile := ""
	errors, warnings := 0, 0
	// pending 是「已经知道是错误、但还没拿到行号或源码片段」的那一条。
	var pending *Diagnostic

	flush := func() {
		if pending == nil {
			return
		}
		diagnostic := *pending
		pending = nil
		if diagnostic.Severity == "error" {
			errors++
		} else if diagnostic.Severity == "warning" {
			warnings++
		}
		if len(summary.Diagnostics) < maxDiagnostics {
			summary.Diagnostics = append(summary.Diagnostics, diagnostic)
		}
	}
	start := func(diagnostic Diagnostic) {
		flush()
		copied := diagnostic
		pending = &copied
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		// 页数优先：它在日志靠后的位置，且可能被折行（已还原）。
		if match := outputWritten.FindStringSubmatch(line); match != nil {
			if pages, err := strconv.Atoi(match[1]); err == nil {
				summary.Pages = pages
			}
		}
		if strings.Contains(line, `\bibdata{`) || strings.Contains(line, `\citation{`) ||
			strings.Contains(line, `\bibstyle{`) {
			summary.NeedsBibtex = true
		}
		if strings.Contains(line, "Please (re)run Biber") || strings.Contains(line, `\abx@aux@`) {
			summary.NeedsBiber = true
		}
		if rerunHint.MatchString(line) {
			summary.Rerun = true
		}
		if match := undefinedCitation.FindStringSubmatch(line); match != nil {
			summary.MissingCitations = appendUnique(summary.MissingCitations, strings.TrimSpace(match[1]))
		}
		if match := undefinedReference.FindStringSubmatch(line); match != nil {
			summary.MissingReferences = appendUnique(summary.MissingReferences, strings.TrimSpace(match[1]))
		}

		// 括号栈：记录最近出现的源文件，供没有文件名的 ! 错误归属使用。
		if strings.HasPrefix(trimmed, "(") {
			if candidate := extractTexPath(trimmed); candidate != "" {
				currentFile = candidate
			}
		}

		// 源码片段行（l.NN）：只挂到**错误**上。
		//
		// 真实日志里 l.NN 是 TeX 对错误的上下文输出；曾经把警告也接上去，
		// 于是给一条整篇级的宏包警告凭空造出了一个行号（用户看到的就是「行号移位」）。
		if match := lineNumber.FindStringSubmatch(trimmed); match != nil {
			number, _ := strconv.Atoi(match[1])
			snippet := strings.TrimSpace(match[2])
			if pending != nil && pending.Severity == "error" {
				if pending.Line == 0 {
					pending.Line = number
				}
				pending.Snippet = snippet
				flush()
				continue
			}
			// 与任何错误都不对应：不单独造一条诊断，也不要污染警告。
			continue
		}

		if match := fileLineError.FindStringSubmatch(trimmed); match != nil {
			file := normalizeLogPath(match[1])
			number, _ := strconv.Atoi(match[2])
			message := strings.TrimSpace(match[3])
			if message == "" {
				continue
			}
			start(Diagnostic{
				Severity: classifyLogMessage(message),
				File:     file,
				Line:     number,
				Message:  message,
				Raw:      trimmed,
				// 位置直接写在日志行上，这是最可信的一种。
				LocationSource: locationLog,
			})
			continue
		}

		if match := bangError.FindStringSubmatch(trimmed); match != nil {
			message := strings.TrimSpace(match[1])
			message = strings.TrimPrefix(message, "LaTeX Error:")
			start(Diagnostic{Severity: "error", File: currentFile, Message: strings.TrimSpace(message), Raw: trimmed})
			continue
		}

		if match := latexWarning.FindStringSubmatch(trimmed); match != nil {
			source := strings.TrimSpace(match[1])
			message := strings.TrimSpace(match[2])
			if message == "" {
				continue
			}
			diagnostic := Diagnostic{Severity: "warning", Source: source, Message: message, Raw: trimmed}
			// 警告的位置只能来自它自己写的那句话，而且**只取行号，不认文件**：
			//   - 「on input line N」说的是行号，可信；
			//   - 文件却常常是错的：natbib/LaTeX 是把未定义引用攒到**跑完之后**统一打印的，
			//     那时「最近打开过的文件」只是最后一个被读的 .tex（真实 CVPR 模板上，
			//     引用明明在 sec/1_intro.tex，却被算到了 sec/0_abstract.tex）。
			// 指错地方的危害大于不给地方：用户会去翻一个根本没错的文件。
			if match := onInputLine.FindStringSubmatch(message); match != nil {
				if number, convErr := strconv.Atoi(match[1]); convErr == nil {
					diagnostic.Line = number
				}
			}
			start(diagnostic)
			continue
		}
		if overfull.MatchString(trimmed) {
			// 盒子溢出信息里自己带行号范围（"... at lines 40--42"），同样只取行号：
			// 文件归属一样不可靠（同样是攒到跑完再打印）。
			diagnostic := Diagnostic{Severity: "info", Source: "TeX", Message: trimmed, Raw: trimmed}
			if match := overfullLines.FindStringSubmatch(trimmed); match != nil {
				if number, convErr := strconv.Atoi(match[1]); convErr == nil {
					diagnostic.Line = number
				}
			}
			start(diagnostic)
			continue
		}

		// 其它行：如果是正在等待的结果的续行（TeX 会把消息拆行），接上去；
		// 否则当作普通日志，不产生诊断。
		if pending != nil && pending.Raw != "" && strings.HasPrefix(line, " ") {
			pending.Message = strings.TrimSpace(pending.Message + " " + trimmed)
			continue
		}
		flush()
	}
	flush()

	summary.Errors = errors
	summary.Warnings = warnings
	return summary
}

// ParseLogFile 读日志文件；文件不存在时返回空结果而不是错误——
// 编译可能连日志都没生成就失败了，那是 exit code 的事。
func ParseLogFile(path string) LogSummary {
	content, err := os.ReadFile(path)
	if err != nil {
		return LogSummary{Diagnostics: []Diagnostic{}, MissingCitations: []string{}, MissingReferences: []string{}}
	}
	return ParseLogText(string(content))
}

func classifyLogMessage(message string) string {
	lower := strings.ToLower(message)
	switch {
	case strings.HasPrefix(lower, "warning"), strings.Contains(lower, "warning:"):
		return "warning"
	case strings.HasPrefix(lower, "overfull"), strings.HasPrefix(lower, "underfull"):
		return "info"
	default:
		return "error"
	}
}

// 位置来源标记。
const (
	// locationLog：位置直接来自日志行。
	locationLog = "log"
	// locationSearch：位置来自在项目源码里查找引用键。
	locationSearch = "search"
)

// resolveKeyLocations 把「未定义引用/引文」定位到真正使用这个键的文件与行。
//
// 为什么值得做：这类警告是 natbib/LaTeX 在**跑完之后**统一打印的，日志里既没有文件名，
// 括号栈给的「最近打开的文件」也常常是错的（真实 CVPR 模板上，引用在 sec/1_intro.tex，
// 却被算到 sec/0_abstract.tex）。与其猜，不如在项目源码里把这个键找出来——
// \cite{key}/\ref{key} 写在哪一行是确定的事实。
func resolveKeyLocations(srcDir string, diagnostics []Diagnostic) []Diagnostic {
	patterns := []*regexp.Regexp{undefinedCitation, undefinedReference}
	keys := map[string]bool{}
	for _, diagnostic := range diagnostics {
		if diagnostic.File != "" {
			continue
		}
		for _, pattern := range patterns {
			if match := pattern.FindStringSubmatch(diagnostic.Message); match != nil {
				keys[strings.TrimSpace(match[1])] = true
			}
		}
	}
	if len(keys) == 0 {
		return diagnostics
	}
	locations := searchKeyLocations(srcDir, keys)
	if len(locations) == 0 {
		return diagnostics
	}
	resolved := make([]Diagnostic, 0, len(diagnostics))
	for _, diagnostic := range diagnostics {
		if diagnostic.File == "" {
			for _, pattern := range patterns {
				match := pattern.FindStringSubmatch(diagnostic.Message)
				if match == nil {
					continue
				}
				if location, ok := locations[strings.TrimSpace(match[1])]; ok {
					diagnostic.File = location.File
					diagnostic.Line = location.Line
					diagnostic.LocationSource = locationSearch
					break
				}
			}
		}
		resolved = append(resolved, diagnostic)
	}
	return resolved
}

type keyLocation struct {
	File string
	Line int
}

// searchKeyLocations 在项目内的 .tex 里找这些键第一次出现的位置。
//
// 只看 .tex：引用键本来就写在正文里；.bib 里的键是「被引用的对象」，不是使用位置。
func searchKeyLocations(srcDir string, keys map[string]bool) map[string]keyLocation {
	found := map[string]keyLocation{}
	command := regexp.MustCompile(`\\(?:cite|citep|citet|citeauthor|citeyear|ref|eqref|pageref|autoref|nameref|[cC]ref|label)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}`)
	_ = filepath.WalkDir(srcDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() {
			// 编译产物与隐藏目录不看：那不是用户写的正文。
			name := entry.Name()
			if name == "build" || name == "snapshots" || strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.EqualFold(filepath.Ext(path), ".tex") {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		relative, err := filepath.Rel(srcDir, path)
		if err != nil {
			return nil
		}
		relative = filepath.ToSlash(relative)
		for index, line := range strings.Split(string(content), "\n") {
			commentAt := strings.Index(line, "%")
			for _, match := range command.FindAllStringSubmatchIndex(line, -1) {
				// 注释里的引用不算使用位置。
				if commentAt >= 0 && commentAt < match[0] {
					continue
				}
				for _, key := range strings.Split(line[match[2]:match[3]], ",") {
					trimmed := strings.TrimSpace(key)
					if !keys[trimmed] {
						continue
					}
					if _, exists := found[trimmed]; !exists {
						found[trimmed] = keyLocation{File: relative, Line: index + 1}
					}
				}
			}
		}
		return nil
	})
	return found
}

// extractTexPath 从 "(./sections/method.tex" 这类片段里取出源文件路径。
func extractTexPath(line string) string {
	for _, prefix := range []string{"(./", "("} {
		index := strings.Index(line, prefix)
		if index < 0 {
			continue
		}
		rest := line[index+len(prefix):]
		for _, extension := range []string{".tex", ".sty", ".cls", ".ltx"} {
			if end := strings.Index(rest, extension); end >= 0 {
				candidate := rest[:end+len(extension)]
				if strings.Contains(candidate, " ") {
					continue
				}
				if normalized := normalizeLogPath(candidate); normalized != "" {
					return normalized
				}
			}
		}
	}
	return ""
}

// normalizeLogPath 把日志里的路径变成项目内相对路径（与 API 的 path 参数一致）。
func normalizeLogPath(path string) string {
	cleaned := strings.TrimSpace(strings.TrimPrefix(path, "./"))
	cleaned = strings.ReplaceAll(cleaned, "\\", "/")
	if index := strings.Index(cleaned, ":/"); index >= 0 {
		cleaned = cleaned[index+2:]
	}
	cleaned = strings.TrimPrefix(cleaned, "/")
	if _, err := NormalizeRelative(cleaned); err != nil {
		return ""
	}
	return cleaned
}

func appendUnique(list []string, value string) []string {
	if value == "" {
		return list
	}
	for _, existing := range list {
		if existing == value {
			return list
		}
	}
	return append(list, value)
}
