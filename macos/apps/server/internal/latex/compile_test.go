package latex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// 这些测试用**本机真实的 TeX 发行版**编译真文档，不造假 PDF：
// 只有真编译才能证明引擎选择、多趟、bibtex、日志解析这一整条链是对的。
// 没装 TeX 的环境跳过（而不是假装通过）。
func requireTeX(t *testing.T) ToolchainReport {
	t.Helper()
	report := DetectToolchains(context.Background(), true)
	if report.Strategy == "unavailable" {
		t.Skip("本机没有可用的 TeX 引擎，跳过真实编译测试")
	}
	return report
}

func TestToolchainDetectionReportsUsableEngines(t *testing.T) {
	report := DetectToolchains(context.Background(), true)
	if len(report.Engines) != 3 {
		t.Fatalf("应当探测 pdflatex/xelatex/lualatex 三个引擎: %+v", report.Engines)
	}
	for _, tool := range report.Engines {
		if tool.Usable && tool.Path == "" {
			t.Fatalf("%s 标记为可用却没有路径", tool.Name)
		}
		if !tool.Usable && tool.Reason == "" {
			t.Fatalf("%s 不可用时必须说明原因（否则界面只能显示「失败」）", tool.Name)
		}
	}
	// latexmk 是 Perl 脚本：要么可用，要么给出「为什么不可用」的具体原因。
	for _, tool := range report.AuxTools {
		if tool.Name == "latexmk" && !tool.Usable && tool.Reason == "" {
			t.Fatal("latexmk 不可用时必须给出原因")
		}
	}
	if report.Preferred == "" {
		t.Fatal("有可用引擎时必须给出首选")
	}
	if report.Strategy != "latexmk" && report.Strategy != "builtin-multipass" {
		t.Fatalf("编译策略只能是 latexmk 或内置多趟，实际 %q", report.Strategy)
	}
}

func TestParseLogTextExtractsFileLineErrors(t *testing.T) {
	// 取自真实 pdflatex 输出的形状（-file-line-error 打开时）。
	log := strings.Join([]string{
		"This is pdfTeX, Version 3.141592653",
		"(./main.tex",
		"LaTeX2e <2024-06-01>",
		"./sections/method.tex:12: Undefined control sequence.",
		"l.12 \\foo",
		"",
		"! LaTeX Error: Something's wrong--perhaps a missing \\item.",
		"",
		"l.30 \\end{itemize}",
		"LaTeX Warning: Citation `ghost2020' on page 1 undefined on input line 20.",
		"LaTeX Warning: Reference `sec:none' on page 1 undefined on input line 22.",
		"LaTeX Warning: There were undefined references.",
		"Overfull \\hbox (12.0pt too wide) in paragraph at lines 40--42",
		"Output written on main.pdf (3 pages, 45678 bytes).",
	}, "\n")
	summary := ParseLogText(log)

	if summary.Pages != 3 {
		t.Fatalf("应当读出页数 3，实际 %d", summary.Pages)
	}
	if summary.Errors != 2 {
		t.Fatalf("应当识别出 2 个错误，实际 %d：%+v", summary.Errors, summary.Diagnostics)
	}
	var located bool
	for _, diagnostic := range summary.Diagnostics {
		if diagnostic.Severity == "error" && diagnostic.File == "sections/method.tex" && diagnostic.Line == 12 {
			located = true
			if !strings.Contains(diagnostic.Message, "Undefined control sequence") {
				t.Fatalf("错误信息不对: %+v", diagnostic)
			}
		}
	}
	if !located {
		t.Fatalf("带文件与行号的错误必须被识别出来: %+v", summary.Diagnostics)
	}
	// "! ..." 形式要靠后面的 l.NN 找到行号。
	var bangError bool
	for _, diagnostic := range summary.Diagnostics {
		if diagnostic.Line == 30 && strings.Contains(diagnostic.Message, "missing \\item") {
			bangError = true
		}
	}
	if !bangError {
		t.Fatalf("传统 ! 错误应当借 l.NN 定位到行号: %+v", summary.Diagnostics)
	}
	if strings.Join(summary.MissingCitations, ",") != "ghost2020" {
		t.Fatalf("未定义引用解析不对: %+v", summary.MissingCitations)
	}
	if strings.Join(summary.MissingReferences, ",") != "sec:none" {
		t.Fatalf("未定义标签解析不对: %+v", summary.MissingReferences)
	}
	if summary.Warnings == 0 {
		t.Fatal("警告应当被计入")
	}
	if !summary.Rerun {
		t.Fatal("「There were undefined references」应当触发重跑（多趟的依据）")
	}
}

func TestParseLogTextIgnoresNoise(t *testing.T) {
	// MiKTeX 每次都会说这句：它不该被当成警告刷屏。
	log := "you have not checked for MiKTeX updates for N days.\n" +
		"Running miktex-pdflatex.exe...\n" +
		"Output written on main.pdf (1 page, 1234 bytes).\n"
	summary := ParseLogText(log)
	if summary.Errors != 0 {
		t.Fatalf("噪声不该被当成错误: %+v", summary.Diagnostics)
	}
	if summary.Pages != 1 {
		t.Fatalf("单页文档页数应当是 1，实际 %d", summary.Pages)
	}
}

// seedCompilableProject 造一个真能编译的项目（含引用与交叉引用）。
func seedCompilableProject(t *testing.T, service *Service) *Project {
	t.Helper()
	ctx := context.Background()
	project, err := service.Create(ctx, "编译测试", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(`\documentclass[11pt]{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}\label{sec:intro}
As shown in \cite{example2026}, see Section~\ref{sec:intro}.
\begin{equation}
  E = mc^2 \label{eq:energy}
\end{equation}
Equation~\eqref{eq:energy} is famous.
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "references.bib", []byte(`@article{example2026,
  title   = {An Example Reference},
  author  = {Example, Ada},
  journal = {Journal of Examples},
  year    = {2026}
}
`), ""); err != nil {
		t.Fatal(err)
	}
	return project
}

func waitForBuild(t *testing.T, service *Service, buildID string, timeout time.Duration) *Build {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		build, err := service.Build(context.Background(), buildID)
		if err != nil {
			t.Fatalf("查询编译状态失败: %v", err)
		}
		if build.Status != BuildQueued && build.Status != BuildRunning {
			return build
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("编译在 %s 内没有结束", timeout)
	return nil
}

func TestBuiltinMultiPassProducesRealPDFWithCitations(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	project := seedCompilableProject(t, service)

	// 强制走内置多趟：这样测的是我们自己那套「引擎 → bibtex → 再跑」的逻辑。
	build, err := service.StartBuild(context.Background(), project.ID, BuildOptions{Engine: string(EnginePDFLaTeX)})
	if err != nil {
		t.Fatal(err)
	}
	if build.Engine == "latexmk" {
		t.Skip("本机 latexmk 可用：内置多趟路径不适用，改由 latexmk 分支覆盖")
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	if finished.Status != BuildSucceeded {
		t.Fatalf("真文档应当编译成功，实际 %s：%s\n诊断：%+v",
			finished.Status, finished.Message, finished.Diagnostics)
	}
	if !finished.HasPDF {
		t.Fatal("编译成功却没有 PDF")
	}
	path, _, err := service.BuildPDFPath(context.Background(), build.ID)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// 必须是真的 PDF，不是占位文件。
	if !strings.HasPrefix(string(content), "%PDF-") {
		t.Fatalf("产物不是真正的 PDF：%q", string(content[:min(8, len(content))]))
	}
	if len(content) < 2000 {
		t.Fatalf("PDF 太小，可能没真的排版：%d 字节", len(content))
	}
	if finished.Pages < 1 {
		entries, _ := os.ReadDir(filepath.Dir(path))
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("应当至少 1 页，实际 %d（HasLog=%v HasPDF=%v 产物目录=%v）",
			finished.Pages, finished.HasLog, finished.HasPDF, names)
	}
	// bibtex 真的跑过：.bbl 里有那条参考文献，且日志里没有未定义引用。
	bbl, err := os.ReadFile(filepath.Join(filepath.Dir(path), "main.bbl"))
	if err != nil {
		t.Fatalf("没有生成 .bbl，说明 bibtex 没跑: %v", err)
	}
	// plain 样式把作者排成「Ada Example」，标题首字母小写化——断言真实的产物形状，
	// 而不是我以为的样子。
	if !strings.Contains(string(bbl), `\bibitem{example2026}`) || !strings.Contains(string(bbl), "Ada Example") {
		blg, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "main.blg"))
		t.Fatalf(".bbl 内容不对（%d 字节）:\n%s\n--- bibtex 日志 ---\n%s",
			len(bbl), bbl, truncate(string(blg), 800))
	}
	if len(finished.MissingCitations) != 0 || len(finished.MissingReferences) != 0 {
		t.Fatalf("交叉引用应当已解析，实际还缺: %+v %+v", finished.MissingCitations, finished.MissingReferences)
	}
}

func TestCompileFailureIsLocatedInSource(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "会失败的项目", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	// 故意用不存在的命令：这是最常见的排版错误形态。
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(`\documentclass{article}
\begin{document}
Hello \thisCommandDoesNotExist{world}
\end{document}
`), ""); err != nil {
		t.Fatal(err)
	}
	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	if finished.Status != BuildFailed {
		t.Fatalf("含未定义命令的文档必须报失败，实际 %s", finished.Status)
	}
	if finished.ErrorCount == 0 {
		log, _ := service.BuildLog(context.Background(), build.ID)
		t.Fatalf("应当统计出错误数量: %+v\n=== 日志全文 ===\n%s\n=== 日志结束 ===", finished, log)
	}
	var located bool
	for _, diagnostic := range finished.Diagnostics {
		if diagnostic.Severity != "error" || diagnostic.Line == 0 {
			continue
		}
		// 用户要能看到「错在哪一行、哪条命令」：位置在 File/Line，
		// 具体代码在 Snippet（TeX 的报错文案本身不含命令名）。
		if diagnostic.File != "main.tex" || diagnostic.Line != 3 {
			continue
		}
		if !strings.Contains(diagnostic.Snippet, "thisCommandDoesNotExist") {
			t.Fatalf("诊断缺少出错代码片段: %+v", diagnostic)
		}
		located = true
	}
	if !located {
		t.Fatalf("错误必须能定位到源码行（界面靠它跳转）：%+v", finished.Diagnostics)
	}
	if finished.Message == "" {
		t.Fatal("失败必须带一句人话说明")
	}
}

func TestBuildIsMarkedStaleAfterEdit(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project := seedCompilableProject(t, service)
	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	if finished.Stale {
		t.Fatal("刚编译完不该标记为过期")
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte("% 改了内容\n\\documentclass{article}\n\\begin{document}hi\\end{document}\n"), ""); err != nil {
		t.Fatal(err)
	}
	reloaded, err := service.Build(ctx, build.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reloaded.Stale {
		t.Fatal("源码改动后产物必须标记为过期，否则用户会看着旧 PDF 以为是最新的")
	}
}

func TestStartBuildGuards(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project := seedCompilableProject(t, service)

	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	// 同一个项目不允许并发编译（第二个请求应被明确拒绝，而不是排队）。
	if _, err := service.StartBuild(ctx, project.ID, BuildOptions{}); !errors.Is(err, ErrBuildInProgress) {
		t.Fatalf("并发编译应当被拒绝，实际 %v", err)
	}
	// 取消：立刻请求取消，最终状态要么已被取消要么已经跑完，但不能卡在 running。
	if err := service.CancelBuild(ctx, build.ID); err != nil {
		t.Logf("取消请求返回：%v（可能已经跑完）", err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	if finished.Status == BuildQueued || finished.Status == BuildRunning {
		t.Fatalf("取消后不该还停在 %s", finished.Status)
	}
	// 不存在的项目/根文档要给出明确错误。
	if _, err := service.StartBuild(ctx, "no-such-project", BuildOptions{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的项目应当报 ErrNotFound，实际 %v", err)
	}
}

func TestBuildTimeoutIsReportedAsTimeout(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project := seedCompilableProject(t, service)
	// 给一个必然来不及的时限：TeX 起不来就结束了。
	build, err := service.StartBuild(ctx, project.ID, BuildOptions{Timeout: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, time.Minute)
	if finished.Status != BuildTimeout && finished.Status != BuildFailed {
		t.Fatalf("超时应当报 timeout（或失败），实际 %s", finished.Status)
	}
	if finished.Reason == "" && finished.Message == "" {
		t.Fatal("超时也要留下说明")
	}
}

func TestBuildLogAndHistory(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project := seedCompilableProject(t, service)
	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	log, err := service.BuildLog(ctx, build.ID)
	if err != nil {
		t.Fatalf("应当能读到编译日志: %v", err)
	}
	if !strings.Contains(log, "pdfTeX") && !strings.Contains(log, "This is") {
		t.Fatalf("日志内容不像 TeX 输出:\n%s", truncate(log, 200))
	}
	history, err := service.Builds(ctx, project.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].ID != finished.ID {
		t.Fatalf("编译历史不对: %+v", history)
	}
	// 项目的最后一次编译指针必须指向它。
	reloaded, err := service.Get(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.LastBuildID != finished.ID {
		t.Fatalf("项目的 lastBuildId 没更新: %+v", reloaded)
	}
	if finished.Status == BuildSucceeded && reloaded.LastSuccessBuildID != finished.ID {
		t.Fatalf("成功编译应当更新 lastSuccessBuildId: %+v", reloaded)
	}
	_ = build
}

func TestParseLogTextMatchesRealMiKTeXOutput(t *testing.T) {
	// 与真实 MiKTeX 日志逐字一致（本机 pdflatex 实测取得），包括 l.NN 那种
	// 「左边被截断」的上下文行与 "1 page" 的单数形式。
	log := strings.Join([]string{
		"This is pdfTeX, Version 3.141592653-2.6-1.40.25 (MiKTeX 24.1)",
		"entering extended mode",
		"(probe.aux)",
		"probe.tex:1: Undefined control sequence.",
		"l.1 ...gin{document}Hello \\thisCommandDoesNotExist",
		"",
		"(see the transcript file for additional information)<C:/Users/x/fonts/cmr10.pfb>",
		"Output written on probe.pdf (1 page, 12868 bytes).",
		"Transcript written on probe.log.",
	}, "\n")
	summary := ParseLogText(log)
	if summary.Pages != 1 {
		t.Fatalf("真实日志里的页数应当解析为 1，实际 %d", summary.Pages)
	}
	if summary.Errors != 1 {
		t.Fatalf("应当识别出 1 个错误，实际 %d：%+v", summary.Errors, summary.Diagnostics)
	}
	diagnostic := summary.Diagnostics[0]
	if diagnostic.File != "probe.tex" || diagnostic.Line != 1 {
		t.Fatalf("错误定位不对: %+v", diagnostic)
	}
	// 源码上下文行（带被截断的 l.NN）必须保留下来：界面靠它告诉用户「哪一行」。
	if !strings.Contains(diagnostic.Snippet, "thisCommandDoesNotExist") {
		t.Fatalf("应当带上出错的源码片段，实际 Snippet=%q", diagnostic.Snippet)
	}
	if !strings.Contains(diagnostic.Raw, "Undefined control sequence") {
		t.Fatalf("原始日志行应当保留，实际 Raw=%q", diagnostic.Raw)
	}
}

func TestParseLogTextHandlesVeryLongFirstLine(t *testing.T) {
	// 真实 MiKTeX 日志的第一行（版本信息）本身就超过 79 字符。
	// 折行还原若用「已拼接行的长度」判断，就会从这里开始把整份日志吞成一行，
	// 于是所有诊断都解析不出来——这是实际发生过的回归。
	log := strings.Join([]string{
		"This is pdfTeX, Version 3.141592653-2.6-1.40.28 (MiKTeX 25.12) (preloaded format=pdflatex 2026.9.5)  22 OCT 2026 21:42",
		"entering extended mode",
		" restricted \\write18 enabled.",
		" file:line:error style messages enabled.",
		"**./main.tex",
		"(main.tex",
		"main.tex:3: Undefined control sequence.",
		"l.3 Hello \\thisCommandDoesNotExist",
		"                                  {world}",
		"",
		"Output written on main.pdf (1 page, 20000 bytes).",
	}, "\n")
	summary := ParseLogText(log)
	if summary.Errors != 1 {
		t.Fatalf("长首行之后仍要能解析出错误，实际 %d：%+v", summary.Errors, summary.Diagnostics)
	}
	if summary.Diagnostics[0].File != "main.tex" || summary.Diagnostics[0].Line != 3 {
		t.Fatalf("错误定位不对: %+v", summary.Diagnostics[0])
	}
	if !strings.Contains(summary.Diagnostics[0].Snippet, "thisCommandDoesNotExist") {
		t.Fatalf("源码片段丢失: %+v", summary.Diagnostics[0])
	}
	if summary.Pages != 1 {
		t.Fatalf("页数应当为 1，实际 %d", summary.Pages)
	}
}

func TestEngineCandidatesCoverPlatformInstallLocations(t *testing.T) {
	// 这些目录是「装完 TeX 但 PATH 里没有」时的兜底。macOS 的 /Library/TeX/texbin
	// 是 MacTeX 的固定位置，漏了它会让图形界面里的用户看到「没装 TeX」（真会发生）。
	candidates := engineCandidates("pdflatex")
	if len(candidates) == 0 {
		t.Fatal("应当给出候选目录")
	}
	joined := strings.Join(candidates, "|")
	switch runtime.GOOS {
	case "darwin":
		if !strings.Contains(joined, "/Library/TeX/texbin/pdflatex") {
			t.Fatalf("macOS 必须搜索 MacTeX 的 texbin: %v", candidates)
		}
	case "windows":
		if !strings.Contains(joined, "MiKTeX") || !strings.HasSuffix(candidates[0], "pdflatex.exe") {
			t.Fatalf("Windows 候选应当带 .exe 且包含 MiKTeX 目录: %v", candidates)
		}
	}
	for _, candidate := range candidates {
		if !strings.HasSuffix(candidate, "pdflatex") && !strings.HasSuffix(candidate, "pdflatex.exe") {
			t.Fatalf("候选路径必须以可执行文件名结尾: %q", candidate)
		}
	}
}

func TestToolchainNamesAreAllowlisted(t *testing.T) {
	// 项目里的引擎字符串永远不直接当命令用：只做白名单查表，注入的一律回落到 pdfLaTeX。
	for _, attempt := range []string{"", "rm -rf /", "bash -c whoami", "../../bin/sh", "pdflatex; rm -rf /", "pdflatex\nxelatex"} {
		if got := resolveToolName(attempt); got != "pdflatex" {
			t.Fatalf("非法引擎 %q 应当回落到 pdflatex，实际 %q", attempt, got)
		}
	}
	if got := resolveToolName("xelatex"); got != "xelatex" {
		t.Fatalf("合法引擎不该被改：%q", got)
	}
	// 大小写不敏感只是查表时的宽容：值仍然限定在白名单内，不会变成任意命令。
	if got := resolveToolName("LATEXMK"); got != "latexmk" {
		t.Fatalf("白名单匹配应当忽略大小写：%q", got)
	}
}

func TestLatexmkUsesSelectedEngineWithoutProjectConfiguration(t *testing.T) {
	for engine, mode := range map[string]string{"pdflatex": "-pdf", "xelatex": "-pdfxe", "lualatex": "-pdflua"} {
		t.Run(engine, func(t *testing.T) {
			args := latexmkArguments(engine, "paper/main.tex", "/build/output")
			options := map[string]bool{}
			for _, arg := range args {
				options[arg] = true
			}
			if !options["-norc"] || !options[mode] || !options["-outdir=/build/output"] {
				t.Fatalf("必须禁用自动执行配置并保留选择的引擎与输出目录: %v", args)
			}
			for _, other := range []string{"-pdf", "-pdfxe", "-pdflua"} {
				if other != mode && options[other] {
					t.Fatalf("不能让其它模式覆盖选定引擎: %v", args)
				}
			}
		})
	}
}

func TestLatexmkDoesNotExecuteImportedRc(t *testing.T) {
	report := requireTeX(t)
	if _, ok := findTool(report, "latexmk"); !ok {
		t.Skip("本机 latexmk 不可运行，参数安全约束由独立测试覆盖")
	}
	service := newTestService(t)
	project := seedCompilableProject(t, service)
	src := mustSrc(t, service, project.ID)
	if err := os.WriteFile(filepath.Join(src, ".latexmkrc"), []byte(`open(my $marker, '>', 'rc-executed.txt') or die $!; print $marker 'executed'; close($marker); die 'Untrusted project configuration executed';`), 0o644); err != nil {
		t.Fatal(err)
	}
	build, err := service.StartBuild(context.Background(), project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	if fileExists(filepath.Join(src, "rc-executed.txt")) {
		t.Fatal("编译执行了导入项目中的 Perl 配置")
	}
	if finished.Status != BuildSucceeded {
		t.Fatalf("忽略项目配置后，正常源码仍应编译成功: %+v", finished)
	}
}
