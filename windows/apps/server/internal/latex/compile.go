package latex

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// BuildTimeout 是状态机里比 projects.go 多出来的一个：TeX 编译可能卡在
// 交互式提问上，超时被中止与「失败」在界面上要区分对待。
const BuildTimeout BuildStatus = "timeout"

// ErrBuildInProgress 表示同一个项目已有编译在跑。
var ErrBuildInProgress = errors.New("这个项目已有编译在进行中")

const (
	// maxConcurrentBuilds：同时最多两个编译。TeX 编译吃满一个核，
	// 放开了只会让所有编译都变慢，还会把用户机器拖住。
	maxConcurrentBuilds = 2
	// maxPasses：内置多趟的上限。正常文档 2~3 趟足够（交叉引用 + 参考文献）。
	//
	// 上限是 6 而不是 4，是因为实测过一份真实 CVPR 模板（评审模式，带 lineno 行号
	// 与 hyperref pagebackref）：同一个目录里要跑到第 5 趟才不再要求重跑，
	// 第 4 趟还在喊。循环本身是「日志不再要求重跑就停」，所以这个上限只在
	// 文档反复要求时才起作用，不会让普通文档多跑。
	maxPasses = 6
	// DefaultBuildTimeout 是单次编译的总时限。
	DefaultBuildTimeout = 5 * time.Minute
	// keptBuilds 是每个项目保留的编译记录数（更老的连目录一起清掉）。
	keptBuilds = 10
)

// Build 是一次编译的完整记录。
type Build struct {
	ID           string      `json:"id"`
	ProjectID    string      `json:"projectId"`
	Revision     string      `json:"revision"`
	Status       BuildStatus `json:"status"`
	Reason       string      `json:"reason,omitempty"`
	Engine       string      `json:"engine"`
	MainFile     string      `json:"mainFile"`
	StartedAt    time.Time   `json:"startedAt"`
	FinishedAt   time.Time   `json:"finishedAt"`
	ExitCode     int         `json:"exitCode"`
	ErrorCount   int         `json:"errorCount"`
	WarningCount int         `json:"warningCount"`
	Pages        int         `json:"pages"`
	Message      string      `json:"message,omitempty"`
	// Diagnostics 由日志现场解析得到，不入库：日志才是权威，改解析规则后历史记录也受益。
	Diagnostics []Diagnostic `json:"diagnostics"`
	HasPDF      bool         `json:"hasPdf"`
	HasLog      bool         `json:"hasLog"`
	// Stale=true 表示这份产物对应的源码已经不是当前磁盘内容（界面要提示重新编译）。
	Stale             bool     `json:"stale"`
	MissingCitations  []string `json:"missingCitations"`
	MissingReferences []string `json:"missingReferences"`
}

// BuildOptions 允许前端只覆盖本次编译的引擎（项目设置是默认值）。
type BuildOptions struct {
	Engine  string
	Timeout time.Duration
}

type buildRegistry struct {
	mu      sync.Mutex
	cancels map[string]context.CancelFunc
	active  map[string]string // projectID -> buildID
}

var registry = &buildRegistry{cancels: map[string]context.CancelFunc{}, active: map[string]string{}}

var buildSlots = make(chan struct{}, maxConcurrentBuilds)

func safeIDSegment(value string) error {
	if value == "" || strings.ContainsAny(value, `/\`) || value == "." || value == ".." {
		return fmt.Errorf("%w: 非法的编号 %q", ErrUnsafePath, value)
	}
	return nil
}

// StartBuild 记录一次编译并异步执行，立即返回可轮询的 Build。
func (s *Service) StartBuild(ctx context.Context, projectID string, options BuildOptions) (*Build, error) {
	project, err := s.Get(ctx, projectID)
	if err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	mainPath, err := ResolveUnder(srcDir, project.MainFile)
	if err != nil {
		return nil, err
	}
	if info, statErr := os.Stat(mainPath); statErr != nil || info.IsDir() {
		return nil, fmt.Errorf("根文档 %s 不存在：请先在工具栏里重新指定", project.MainFile)
	}

	report := DetectToolchains(ctx, false)
	engine := resolveToolName(project.Engine)
	if options.Engine != "" {
		engine = resolveToolName(options.Engine)
	}
	strategy := report.Strategy
	if strategy == "unavailable" {
		message := "本机没有可用的 TeX 引擎，无法编译。"
		if len(report.Hints) > 0 {
			message += " " + report.Hints[0]
		}
		return nil, errors.New(message)
	}
	if strategy == "latexmk" {
		if _, ok := findTool(report, "latexmk"); !ok {
			strategy = "builtin-multipass"
		}
	}
	if strategy != "latexmk" {
		if _, ok := findTool(report, engine); !ok {
			// 选中的引擎不可用：换成能用的那个，并把这件事说清楚。
			fallback, ok := findTool(report, report.Preferred)
			if !ok {
				return nil, errors.New("本机没有可用的 TeX 引擎：" + engine + " 与首选引擎都不可用")
			}
			engine = fallback.Name
		}
	}

	registry.mu.Lock()
	if existing, busy := registry.active[projectID]; busy {
		registry.mu.Unlock()
		return nil, fmt.Errorf("%w（%s）", ErrBuildInProgress, existing)
	}
	buildID, idErr := newID()
	if idErr != nil {
		registry.mu.Unlock()
		return nil, fmt.Errorf("生成编译编号失败: %w", idErr)
	}
	registry.active[projectID] = buildID
	registry.mu.Unlock()

	revision, err := s.Manifest(ctx, projectID)
	if err != nil {
		registry.release(projectID)
		return nil, err
	}
	buildDir, err := s.BuildDir(projectID, buildID)
	if err != nil {
		registry.release(projectID)
		return nil, err
	}
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		registry.release(projectID)
		return nil, fmt.Errorf("创建编译目录失败: %w", err)
	}
	// 沿用上一次构建的辅助文件（.aux/.bbl/.toc…）。
	//
	// 为什么必须这么做：TeX 的交叉引用、目录、以及评审模式的**页边行号**（lineno）
	// 都要靠上一趟留下的 .aux 才能算对。以前每次编译都用全新的空目录，于是像 lineno
	// 这种「两趟才成立」的功能永远从零开始——实测真实 CVPR 模板：同一个目录里第 3 趟
	// 行号参照就对上了、第 5 趟彻底稳定；每次都换目录则永远停在「re-run to get it right」，
	// 页边行号也就一直可能是错位的。
	// 只搬辅助文件，绝不搬 PDF/日志：产物必须是这一次的，否则失败时会看到上一次的旧 PDF。
	if err := s.seedAuxiliaryFiles(projectID, buildID, buildDir); err != nil {
		registry.release(projectID)
		return nil, fmt.Errorf("沿用上次编译的辅助文件失败: %w", err)
	}

	build := &Build{
		ID: buildID, ProjectID: projectID, Revision: revision,
		Status: BuildQueued, Engine: func() string {
			if strategy == "latexmk" {
				return "latexmk"
			}
			return engine
		}(),
		MainFile:  project.MainFile,
		StartedAt: time.Now().UTC(),
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO latex_builds (id, project_id, revision, status, reason, engine, main_file, started_at, finished_at, exit_code, error_count, warning_count, log_path, pdf_path, message)
		VALUES (?, ?, ?, ?, '', ?, ?, ?, '', 0, 0, 0, '', '', '')`,
		build.ID, build.ProjectID, build.Revision, string(build.Status), build.Engine, build.MainFile, formatTime(build.StartedAt))
	if err != nil {
		registry.release(projectID)
		return nil, fmt.Errorf("记录编译失败: %w", err)
	}
	if err := s.SetLastBuild(ctx, projectID, build.ID, false); err != nil {
		registry.release(projectID)
		return nil, err
	}

	timeout := options.Timeout
	if timeout <= 0 || timeout > 15*time.Minute {
		timeout = DefaultBuildTimeout
	}
	// 编译在后台跑：HTTP 请求不该被一次 30 秒的编译占住。
	runCtx, cancel := context.WithTimeout(context.Background(), timeout)
	registry.mu.Lock()
	registry.cancels[build.ID] = cancel
	registry.mu.Unlock()

	go func() {
		defer func() {
			cancel()
			registry.mu.Lock()
			delete(registry.cancels, build.ID)
			delete(registry.active, projectID)
			registry.mu.Unlock()
			s.pruneBuilds(context.Background(), projectID)
		}()
		buildSlots <- struct{}{}
		defer func() { <-buildSlots }()
		s.executeBuild(runCtx, build, project, report, strategy, engine, srcDir, buildDir)
	}()

	return build, nil
}

func (r *buildRegistry) release(projectID string) {
	r.mu.Lock()
	delete(r.active, projectID)
	r.mu.Unlock()
}

// executeBuild 真正跑编译：latexmk 可用时交给它，否则按需多趟。
func (s *Service) executeBuild(ctx context.Context, build *Build, project *Project, report ToolchainReport, strategy, engineName, srcDir, buildDir string) {
	s.updateBuildStatus(context.Background(), build.ID, BuildRunning, "", 0, 0, 0, "")
	jobName := strings.TrimSuffix(filepath.Base(project.MainFile), filepath.Ext(project.MainFile))
	logPath := filepath.Join(buildDir, jobName+".log")
	pdfPath := filepath.Join(buildDir, jobName+".pdf")
	stdoutPath := filepath.Join(buildDir, "readx-build.out")

	var exitCode int
	var runErr error
	if strategy == "latexmk" {
		tool, _ := findTool(report, "latexmk")
		args := latexmkArguments(engineName, project.MainFile, buildDir)
		exitCode, runErr = s.runProcess(ctx, tool.Path, args, srcDir, stdoutPath)
	} else {
		exitCode, runErr = s.builtinMultiPass(ctx, report, engineName, project.MainFile, jobName, srcDir, buildDir, stdoutPath)
	}

	// 只报最后一趟：日志文件每趟都被覆盖，最后一趟才是「成品对应的那份日志」。
	// （曾经把每一趟的诊断合并起来，结果同一批未定义引用被四趟各报一遍，
	// 一条警告变成 28 条——用户看到的就是纯粹的噪声。）
	summary := ParseLogFile(logPath)
	// 未定义引用这类警告在日志里没有文件，但键写在哪个文件哪一行是确定的事实：
	// 在项目源码里找出来，界面才点得准（找不到就保持「没有位置」，不猜）。
	summary.Diagnostics = resolveKeyLocations(srcDir, summary.Diagnostics)
	status := BuildSucceeded
	reason := ""
	message := ""
	switch {
	case runErr != nil && ctx.Err() == context.DeadlineExceeded:
		status, reason = BuildTimeout, "编译超过时限被中止"
	case runErr != nil && ctx.Err() == context.Canceled:
		status, reason = BuildCancelled, "编译被取消"
	case runErr != nil:
		status, reason = BuildFailed, shortenRunError(runErr)
	}
	if _, statErr := os.Stat(pdfPath); statErr != nil {
		if status == BuildSucceeded {
			status = BuildFailed
			reason = "编译进程正常退出，但没有生成 PDF"
		}
		if summary.Errors > 0 {
			message = firstErrorMessage(summary)
		} else {
			message = "没有生成 PDF，请查看编译日志。"
		}
	}
	if status == BuildSucceeded && summary.Errors > 0 {
		// 有错误却生成了 PDF：产物可用但必须说清楚，不能报「成功」了事。
		status = BuildFailed
		reason = "编译过程中有错误"
		message = firstErrorMessage(summary)
	}
	if status == BuildSucceeded {
		if len(summary.MissingCitations) > 0 || len(summary.MissingReferences) > 0 {
			message = "编译成功，但存在未定义的引用（见诊断列表）。"
		} else if summary.Warnings > 0 {
			message = "编译成功，有警告（见诊断列表）。"
		}
	}
	if message == "" && status == BuildFailed {
		message = shortenRunError(runErr)
		if message == "" {
			message = "编译失败，请查看日志。"
		}
	}

	finished := time.Now().UTC()
	build.Status = status
	build.Reason = reason
	build.Message = message
	build.FinishedAt = finished
	build.ExitCode = exitCode
	build.ErrorCount = summary.Errors
	build.WarningCount = summary.Warnings
	build.Pages = summary.Pages
	build.Diagnostics = summary.Diagnostics
	build.MissingCitations = summary.MissingCitations
	build.MissingReferences = summary.MissingReferences
	build.HasLog = fileExists(logPath)
	build.HasPDF = fileExists(pdfPath)

	s.updateBuildStatus(context.Background(), build.ID, status, reason, exitCode, summary.Errors, summary.Warnings, message)
	// 产物路径按「项目目录内的相对路径」存：换机器、换数据根之后依然能对上。
	artifact := func(name string) string {
		return filepath.ToSlash(filepath.Join("build", filepath.Base(buildDir), name))
	}
	_, _ = s.db.ExecContext(context.Background(), `
		UPDATE latex_builds SET finished_at = ?, log_path = ?, pdf_path = ?, diagnostics = ? WHERE id = ?`,
		formatTime(finished), artifact(jobName+".log"), artifact(jobName+".pdf"), encodeDiagnostics(summary.Diagnostics), build.ID)
	if status == BuildSucceeded {
		_ = s.SetLastBuild(context.Background(), build.ProjectID, build.ID, true)
	}
	s.Touch(context.Background(), build.ProjectID)
}

// latexmkArguments 不读取项目中的 Perl 配置，并明确选择用户指定的引擎。
func latexmkArguments(engine, mainFile, buildDir string) []string {
	mode := "-pdf"
	switch Engine(engine) {
	case EngineXeLaTeX:
		mode = "-pdfxe"
	case EngineLuaLaTeX:
		mode = "-pdflua"
	}
	return []string{
		"-norc", mode, "-interaction=nonstopmode", "-file-line-error", "-synctex=1",
		"-outdir=" + buildDir, mainFile,
	}
}

// builtinMultiPass 内置多趟：引擎 →（需要时）bibtex/biber → 再跑，直到日志说不用再跑。
func (s *Service) builtinMultiPass(ctx context.Context, report ToolchainReport, engineName, mainFile, jobName, srcDir, buildDir, stdoutPath string) (int, error) {
	tool, ok := findTool(report, engineName)
	if !ok {
		return 1, errors.New("引擎不可用：" + engineName)
	}
	bibtexTool, hasBibtex := findTool(report, "bibtex")
	biberTool, hasBiber := findTool(report, "biber")

	exitCode := 0
	var lastErr error
	bibliographyRun := false
	passes := 0
	for passes < maxPasses {
		passes++
		code, runErr := s.runProcess(ctx, tool.Path, []string{
			"-interaction=nonstopmode", "-file-line-error", "-synctex=1",
			"-output-directory=" + buildDir, mainFile,
		}, srcDir, stdoutPath)
		exitCode = code
		if runErr != nil {
			lastErr = runErr
			// 超时/取消立即收手；真正的排版错误留给日志解析去讲。
			if ctx.Err() != nil {
				return code, runErr
			}
		}
		summary := ParseLogFile(filepath.Join(buildDir, jobName+".log"))
		auxPath := filepath.Join(buildDir, jobName+".aux")

		// 参考文献：.bcf 存在说明用了 biblatex（要 biber），否则看 .aux。
		needsBiber := fileExists(filepath.Join(buildDir, jobName+".bcf")) && hasBiber
		needsBibtex := !needsBiber && !bibliographyRun && hasBibtex &&
			(fileExists(auxPath) && auxNeedsBibtex(auxPath))
		if needsBiber {
			bibliographyRun = true
			// biber/bibtex 从源码目录跑，参数指向 build 目录里的控制文件（不带扩展名）：
			// 这样 .bib 与 \input 的相对路径与正常编译完全一致。
			relative := filepath.Join("..", "build", filepath.Base(buildDir), jobName)
			if _, runErr := s.runProcess(ctx, biberTool.Path, []string{relative}, srcDir, stdoutPath); runErr != nil {
				lastErr = runErr
			}
			continue
		}
		if needsBibtex {
			bibliographyRun = true
			relative := filepath.Join("..", "build", filepath.Base(buildDir), jobName)
			if _, runErr := s.runProcess(ctx, bibtexTool.Path, []string{relative}, srcDir, stdoutPath); runErr != nil {
				lastErr = runErr
			}
			continue
		}
		if summary.Errors > 0 {
			// 有错误就别再跑：多趟只会重复同样的错误，浪费时间。
			return exitCode, lastErr
		}
		if summary.Rerun && passes < maxPasses {
			// 日志说还要再跑就跑：这是 TeX 自己的判据。别自作聪明加「按 .aux 指纹提前收手」——
			// 试过，结果停在了参考文献生效之前的那一趟，交叉引用反而没稳定。
			continue
		}
		break
	}
	return exitCode, lastErr
}

// seedAuxiliaryFiles 把本项目上一次构建目录里的辅助文件复制到这次的新目录。
//
// 为什么必须这么做：TeX 的交叉引用、目录、以及评审模式的**页边行号**（lineno）
// 都要靠上一趟留下的 .aux 才能算对。以前每次编译都用全新的空目录，于是像 lineno
// 这种「要两趟才成立」的功能永远从零开始——实测真实 CVPR 模板：同一个目录里第 3 趟
// 行号参照就对上了、第 5 趟彻底稳定；每次都换目录则永远停在「re-run to get it right」，
// 页边行号也就一直可能错位。
//
// 只搬辅助文件（白名单扩展名）：PDF、日志、synctex 属于「这一次的产物」，搬了 PDF
// 会让编译失败时显示出上一次的旧结果，那是最坏的一种谎报。
func (s *Service) seedAuxiliaryFiles(projectID, buildID, buildDir string) error {
	parent := filepath.Dir(buildDir)
	entries, err := os.ReadDir(parent)
	if err != nil {
		// 第一次编译时 build 目录可能还不存在：不是错误。
		return nil
	}
	previous := ""
	previousTime := time.Time{}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == buildID {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			continue
		}
		if previous == "" || info.ModTime().After(previousTime) {
			previous = filepath.Join(parent, entry.Name())
			previousTime = info.ModTime()
		}
	}
	if previous == "" {
		return nil
	}
	for _, name := range auxiliaryFileNames(previous) {
		if err := copyFile(filepath.Join(previous, name), filepath.Join(buildDir, name), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// auxiliaryFileNames 列出值得沿用的辅助文件。
//
// 用白名单而不是「除 PDF/日志以外全部」：TeX 家族会往输出目录里写各种东西，
// 白名单能让「搬了什么」始终是可解释的。
func auxiliaryFileNames(dir string) []string {
	allowed := map[string]bool{
		".aux": true, ".bbl": true, ".blg": true, ".brf": true, ".bcf": true,
		".xml": true, ".toc": true, ".lof": true, ".lot": true, ".out": true,
		".idx": true, ".ind": true, ".ilg": true, ".glo": true, ".gls": true,
		".glg": true, ".acn": true, ".acr": true, ".alg": true, ".nav": true,
		".snm": true, ".vrb": true, ".loa": true, ".lol": true, ".thm": true,
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		// 排除我们自己的文件：readx-build.out（引擎 stdout）的扩展名正好是 .out，
		// 而 hyperref 的书签文件 main.out 是需要沿用的——只能按名字前缀区分。
		if strings.HasPrefix(strings.ToLower(name), "readx-") {
			continue
		}
		if allowed[strings.ToLower(filepath.Ext(name))] {
			names = append(names, name)
		}
	}
	return names
}

// encodeDiagnostics / decodeDiagnostics 是诊断列表的落库格式。
//
// 落库只为了一件事：读取时不再重新解析日志，从而保证「数字与列表」永远是同一份
// （列表来自最后一趟日志，计数也来自最后一趟日志）。
//
// 落库的原因是「数字与列表必须同源」：error_count/warning_count 是多趟合并的结果，
// 而列表以前是读取时重新解析最后一趟日志得到的，于是界面出现「28 个警告」只列一条。
func encodeDiagnostics(diagnostics []Diagnostic) string {
	if diagnostics == nil {
		diagnostics = []Diagnostic{}
	}
	encoded, err := json.Marshal(diagnostics)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}

func decodeDiagnostics(raw string) []Diagnostic {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "[]" {
		return []Diagnostic{}
	}
	var diagnostics []Diagnostic
	if err := json.Unmarshal([]byte(trimmed), &diagnostics); err != nil {
		// 库里的 JSON 坏了不该让整个构建读不出来：退回空列表，由调用方决定是否重新解析日志。
		return []Diagnostic{}
	}
	if diagnostics == nil {
		return []Diagnostic{}
	}
	return diagnostics
}

// runProcess 起一个外部进程，输出追加到日志文件；超时/取消时连同子进程一起结束。
func (s *Service) runProcess(ctx context.Context, path string, args []string, workDir, outputPath string) (int, error) {
	command := exec.CommandContext(ctx, path, args...)
	command.Dir = workDir
	// MiKTeX 每次都会提示「未检查更新」之类的噪声，一起收进日志里备查。
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		defer output.Close()
		command.Stdout = output
		command.Stderr = output
	}
	// Windows 上杀掉父进程不会带走子进程（TeX 会 fork 出别的程序），
	// 用 taskkill 整棵树收掉，避免留下跑满 CPU 的孤儿进程。
	if runtime.GOOS == "windows" {
		command.Cancel = func() error {
			if command.Process == nil {
				return nil
			}
			kill := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(command.Process.Pid))
			if killErr := kill.Run(); killErr != nil {
				return command.Process.Kill()
			}
			return nil
		}
	}
	runErr := command.Run()
	code := 0
	if command.ProcessState != nil {
		code = command.ProcessState.ExitCode()
	}
	if runErr != nil && code == 0 {
		code = 1
	}
	return code, runErr
}

// auxNeedsBibtex 看 .aux 里有没有 \citation/\bibdata：没有就别白跑一趟 bibtex。
func auxNeedsBibtex(path string) bool {
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	text := string(content)
	return strings.Contains(text, `\citation{`) || strings.Contains(text, `\bibdata{`)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func formatTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func shortenRunError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if exitErr, ok := err.(*exec.ExitError); ok {
		text = fmt.Sprintf("编译进程退出码 %d", exitErr.ExitCode())
	}
	return truncate(strings.TrimSpace(text), 200)
}

func firstErrorMessage(summary LogSummary) string {
	for _, diagnostic := range summary.Diagnostics {
		if diagnostic.Severity == "error" {
			if diagnostic.File != "" && diagnostic.Line > 0 {
				return fmt.Sprintf("%s:%d: %s", diagnostic.File, diagnostic.Line, diagnostic.Message)
			}
			if diagnostic.File != "" {
				return diagnostic.File + ": " + diagnostic.Message
			}
			return diagnostic.Message
		}
	}
	return ""
}

func (s *Service) updateBuildStatus(ctx context.Context, buildID string, status BuildStatus, reason string, exitCode, errors, warnings int, message string) {
	_, _ = s.db.ExecContext(ctx, `
		UPDATE latex_builds SET status = ?, reason = ?, exit_code = ?, error_count = ?, warning_count = ?, message = ?
		WHERE id = ?`, string(status), reason, exitCode, errors, warnings, message, buildID)
}

// CancelBuild 取消一次编译（连同子进程）。
func (s *Service) CancelBuild(ctx context.Context, buildID string) error {
	registry.mu.Lock()
	cancel, ok := registry.cancels[buildID]
	registry.mu.Unlock()
	if !ok {
		build, err := s.Build(ctx, buildID)
		if err != nil {
			return err
		}
		if build.Status == BuildQueued || build.Status == BuildRunning {
			// 有记录但找不到取消函数：说明进程已经结束或服务重启过，如实说明。
			return errors.New("这次编译已经不在运行中")
		}
		return errors.New("这次编译已经结束，无需取消")
	}
	cancel()
	return nil
}

// Build 读取一次编译记录（含现场解析的诊断）。
func (s *Service) Build(ctx context.Context, buildID string) (*Build, error) {
	if err := safeIDSegment(buildID); err != nil {
		return nil, err
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT id, project_id, revision, status, reason, engine, main_file, started_at, finished_at,
		       exit_code, error_count, warning_count, log_path, pdf_path, message, diagnostics
		FROM latex_builds WHERE id = ?`, buildID)
	build, err := scanBuild(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: 找不到这次编译", ErrNotFound)
		}
		return nil, err
	}
	s.decorateBuild(ctx, build)
	return build, nil
}

// Builds 列出某个项目的编译历史（含现场解析的诊断）。
func (s *Service) Builds(ctx context.Context, projectID string, limit int) ([]*Build, error) {
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 50 {
		limit = keptBuilds
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, project_id, revision, status, reason, engine, main_file, started_at, finished_at,
		       exit_code, error_count, warning_count, log_path, pdf_path, message, diagnostics
		FROM latex_builds WHERE project_id = ? ORDER BY started_at DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	builds := []*Build{}
	for rows.Next() {
		build, scanErr := scanBuild(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		builds = append(builds, build)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Rows 关掉之后再解析日志：连接池只有一个连接，边读边查会互相等死。
	for _, build := range builds {
		s.decorateBuild(ctx, build)
	}
	return builds, nil
}

func scanBuild(row interface {
	Scan(dest ...any) error
}) (*Build, error) {
	var (
		build    Build
		status   string
		started  string
		finished sql.NullString
		logPath  sql.NullString
		pdfPath  sql.NullString
		diagJSON sql.NullString
		reason   sql.NullString
		message  sql.NullString
		engine   sql.NullString
		mainFile sql.NullString
		revision sql.NullString
	)
	if err := row.Scan(&build.ID, &build.ProjectID, &revision, &status, &reason, &engine, &mainFile,
		&started, &finished, &build.ExitCode, &build.ErrorCount, &build.WarningCount, &logPath, &pdfPath, &message, &diagJSON); err != nil {
		return nil, err
	}
	build.Status = BuildStatus(status)
	build.Reason = reason.String
	build.Engine = engine.String
	build.MainFile = mainFile.String
	build.Revision = revision.String
	build.Message = message.String
	build.StartedAt = parseTime(started)
	build.FinishedAt = parseTime(finished.String)
	// 诊断从库里读回来：计数与列表必须同源（见 0009 迁移）。
	build.Diagnostics = decodeDiagnostics(diagJSON.String)
	// 产物是否存在由 decorateBuild 统一判断：路径依赖项目目录，
	// 存在数据库里的只是文件名，读的时候拼不出完整路径。
	return &build, nil
}

func parseTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

// decorateBuild 补上不由数据库保存的部分：诊断、产物存在性、源码是否已过期。
func (s *Service) decorateBuild(ctx context.Context, build *Build) {
	buildDir, err := s.BuildDir(build.ProjectID, build.ID)
	if err != nil {
		return
	}
	jobName := strings.TrimSuffix(filepath.Base(build.MainFile), filepath.Ext(build.MainFile))
	logPath := filepath.Join(buildDir, jobName+".log")
	pdfPath := filepath.Join(buildDir, jobName+".pdf")
	build.HasLog = fileExists(logPath)
	build.HasPDF = fileExists(pdfPath)
	if build.HasLog {
		// 日志解析只是补充：诊断以库里那份为准（它是多趟合并后的结果，与计数同源）。
		// 旧记录没有存诊断时才拿最后一趟日志凑一份——那是「尽力而为」，
		// 所以不覆盖已经存在的列表。
		summary := ParseLogFile(logPath)
		if len(build.Diagnostics) == 0 {
			build.Diagnostics = summary.Diagnostics
		}
		if build.Pages == 0 {
			build.Pages = summary.Pages
		}
		if len(summary.MissingCitations) > 0 {
			build.MissingCitations = summary.MissingCitations
		}
		if len(summary.MissingReferences) > 0 {
			build.MissingReferences = summary.MissingReferences
		}
	}
	if build.Diagnostics == nil {
		build.Diagnostics = []Diagnostic{}
	}
	// 这些切片必须以 [] 的形式出现在 JSON 里：Go 的 nil slice 会序列化成 null，
	// 前端读 .length 就会直接把整个界面打崩（真发生过）。
	if build.MissingCitations == nil {
		build.MissingCitations = []string{}
	}
	if build.MissingReferences == nil {
		build.MissingReferences = []string{}
	}
	if current, manifestErr := s.Manifest(ctx, build.ProjectID); manifestErr == nil {
		// 产物对应的源码指纹与当前磁盘不一致 → 界面应提示「已过期，请重新编译」。
		build.Stale = current != build.Revision
	}
}

// BuildLog 返回编译日志全文（供界面查看与复制）。
func (s *Service) BuildLog(ctx context.Context, buildID string) (string, error) {
	build, err := s.Build(ctx, buildID)
	if err != nil {
		return "", err
	}
	buildDir, err := s.BuildDir(build.ProjectID, build.ID)
	if err != nil {
		return "", err
	}
	jobName := strings.TrimSuffix(filepath.Base(build.MainFile), filepath.Ext(build.MainFile))
	content, readErr := os.ReadFile(filepath.Join(buildDir, jobName+".log"))
	if readErr != nil {
		// 没有 .log 时退回进程输出：至少让用户看到引擎说了什么。
		fallback, fallbackErr := os.ReadFile(filepath.Join(buildDir, "readx-build.out"))
		if fallbackErr != nil {
			return "", fmt.Errorf("%w: 这次编译没有留下日志", ErrNotFound)
		}
		return string(fallback), nil
	}
	return string(content), nil
}

// BuildPDFPath 返回编译出的 PDF 路径（供预览与下载）。
func (s *Service) BuildPDFPath(ctx context.Context, buildID string) (string, *Build, error) {
	build, err := s.Build(ctx, buildID)
	if err != nil {
		return "", nil, err
	}
	buildDir, err := s.BuildDir(build.ProjectID, build.ID)
	if err != nil {
		return "", nil, err
	}
	jobName := strings.TrimSuffix(filepath.Base(build.MainFile), filepath.Ext(build.MainFile))
	path := filepath.Join(buildDir, jobName+".pdf")
	if !fileExists(path) {
		return "", build, fmt.Errorf("%w: 这次编译没有生成 PDF", ErrNotFound)
	}
	return path, build, nil
}

// pruneBuilds 只保留最近的若干次编译产物，避免磁盘被历史 aux 文件堆满。
func (s *Service) pruneBuilds(ctx context.Context, projectID string) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id FROM latex_builds WHERE project_id = ? ORDER BY started_at DESC`, projectID)
	if err != nil {
		return
	}
	var stale []string
	index := 0
	for rows.Next() {
		var id string
		if scanErr := rows.Scan(&id); scanErr != nil {
			break
		}
		index++
		if index > keptBuilds {
			stale = append(stale, id)
		}
	}
	rows.Close()
	for _, id := range stale {
		if dir, dirErr := s.BuildDir(projectID, id); dirErr == nil {
			_ = os.RemoveAll(dir)
		}
		_, _ = s.db.ExecContext(ctx, `DELETE FROM latex_builds WHERE id = ?`, id)
	}
}
