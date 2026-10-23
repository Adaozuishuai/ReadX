package latex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"database/sql"
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
	// 这里刻意不再设「更早的收手上限」：真实 CVPR 模板上试过 limit=3，
	// 结果停在了参考文献生效**之前**的那一趟，交叉引用反而没稳定。
	// 只有「.aux 指纹不再变化」这种有证据的结论才允许提前收手。
	maxPasses = 4
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
	var earlierDiagnostics []Diagnostic
	if strategy == "latexmk" {
		tool, _ := findTool(report, "latexmk")
		args := latexmkArguments(engineName, project.MainFile, buildDir)
		exitCode, runErr = s.runProcess(ctx, tool.Path, args, srcDir, stdoutPath)
	} else {
		exitCode, runErr, earlierDiagnostics = s.builtinMultiPass(ctx, report, engineName, project.MainFile, jobName, srcDir, buildDir, stdoutPath)
	}

	summary := ParseLogFile(logPath)
	// 合并前几趟的诊断并去重：日志文件每趟都被覆盖，只看最后一趟会漏掉
	// 「只在第一趟出现」的警告，用户看到的警告集合还会取决于我们在第几趟收手。
	if len(earlierDiagnostics) > 0 {
		summary.Diagnostics = mergeDiagnostics(earlierDiagnostics, summary.Diagnostics)
	}
	// 未定义引用这类警告在日志里没有文件，但键写在哪个文件哪一行是确定的事实：
	// 在项目源码里找出来，界面才点得准（找不到就保持「没有位置」，不猜）。
	summary.Diagnostics = resolveKeyLocations(srcDir, summary.Diagnostics)
	summary.Errors = countSeverity(summary.Diagnostics, "error")
	summary.Warnings = countSeverity(summary.Diagnostics, "warning")
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

// builtinMultiPass 内置多趟：引擎 →（需要时）bibtex/biber → 再跑，直到交叉引用稳定。
//
// 除退出码外还返回「前几趟看到过的诊断」：日志文件会被每一趟覆盖，
// 只看最后一趟的话，用户看到的警告集合取决于我们在第几趟收手
// （真实模板上就出现过：lineno 的警告只在第一趟出现，于是有时看得见有时看不见）。
func (s *Service) builtinMultiPass(ctx context.Context, report ToolchainReport, engineName, mainFile, jobName, srcDir, buildDir, stdoutPath string) (int, error, []Diagnostic) {
	tool, ok := findTool(report, engineName)
	if !ok {
		return 1, errors.New("引擎不可用：" + engineName), nil
	}
	bibtexTool, hasBibtex := findTool(report, "bibtex")
	biberTool, hasBiber := findTool(report, "biber")

	// seen 收集每一趟的诊断（日志会被下一趟覆盖，见函数注释）。
	seen := []Diagnostic{}
	exitCode := 0
	var lastErr error
	bibliographyRun := false
	passes := 0
	// 上一趟的 .aux 指纹：TeX 说「再跑一趟」时，用它判断「再跑一趟真的会有变化吗」。
	previousAux := ""
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
				return code, runErr, seen
			}
		}
		summary := ParseLogFile(filepath.Join(buildDir, jobName+".log"))
		// 每一趟的诊断都留下来：日志文件会被下一趟覆盖，只看最后一趟会漏掉
		// 「只在第一趟出现」的警告（真实 CVPR 模板上的 lineno 警告就是这种）。
		seen = append(seen, summary.Diagnostics...)
		auxPath := filepath.Join(buildDir, jobName+".aux")
		auxNow := fileFingerprint(auxPath)

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
			previousAux = auxNow
			continue
		}
		if needsBibtex {
			bibliographyRun = true
			relative := filepath.Join("..", "build", filepath.Base(buildDir), jobName)
			if _, runErr := s.runProcess(ctx, bibtexTool.Path, []string{relative}, srcDir, stdoutPath); runErr != nil {
				lastErr = runErr
			}
			previousAux = auxNow
			continue
		}
		if summary.Errors > 0 {
			// 有错误就别再跑：多趟只会重复同样的错误，浪费时间。
			return exitCode, lastErr, seen
		}
		if summary.Rerun && passes < maxPasses {
			// 只有拿到证据才提前收手：这一趟没有改变交叉引用（.aux 指纹一样），
			// 说明再跑也不会更好。光看提示会永远跑满上限——有些宏包（例如 lineno）
			// 每一趟都喊「re-run to get it right」，而警告永远不会消失。
			if auxNow == previousAux {
				break
			}
			previousAux = auxNow
			continue
		}
		break
	}
	return exitCode, lastErr, seen
}

// fileFingerprint 给文件算一个短指纹；文件不存在或读不到时返回空串。
func fileFingerprint(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:8])
}

// mergeDiagnostics 按「严重度 + 谁报的 + 文件 + 行号 + 内容」去重合并。
//
// 要靠前的（后面来的同一条不再重复添加），顺序保持第一次出现的先后，
// 这样读者看到的顺序和编译过程中的先后一致。
func mergeDiagnostics(groups ...[]Diagnostic) []Diagnostic {
	merged := make([]Diagnostic, 0, 8)
	seen := map[string]bool{}
	for _, group := range groups {
		for _, diagnostic := range group {
			key := strings.Join([]string{
				diagnostic.Severity, diagnostic.Source, diagnostic.File,
				strconv.Itoa(diagnostic.Line), diagnostic.Message,
			}, "\x00")
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, diagnostic)
		}
	}
	return merged
}

func countSeverity(diagnostics []Diagnostic, severity string) int {
	total := 0
	for _, diagnostic := range diagnostics {
		if diagnostic.Severity == severity {
			total++
		}
	}
	return total
}

// encodeDiagnostics / decodeDiagnostics 是诊断列表的落库格式。
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
