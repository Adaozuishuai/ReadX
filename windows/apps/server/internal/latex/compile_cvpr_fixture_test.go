package latex

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// 真实模板回归：本机 E2E 目录里放着一份真实 CVPR 模板（14 个文件，含 cvpr.sty / .bst / 分节）。
//
// 这个夹具来自用户实际在用的投稿模板，专门用来钉住两件事：
//  1. 警告不能凭空继承文件和行号——真实日志里的
//     "Package lineno Warning: Line number reference failed, re-run to get it right."
//     是整篇级的警告，曾经被算到最近出现过的项目文件上（用户看到的就是「行号移位」）；
//  2. 多趟编译要有收敛判据：这类宏包每趟都会喊「re-run」，否则每次编译都白跑满四趟。
//
// 夹具不在仓库里（tmp/ 被忽略）时跳过，而不是假装通过。
func cvprFixtureDir() string {
	return filepath.Join("..", "..", "..", "..", "..", "tmp", "e2e", "fixtures", "cvpr", "src")
}

func TestRealCVPRTemplateDiagnosticsAndPasses(t *testing.T) {
	requireTeX(t)
	fixture := cvprFixtureDir()
	if info, err := os.Stat(fixture); err != nil || !info.IsDir() {
		t.Skipf("没有真实 CVPR 模板夹具（%s）", fixture)
	}
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "CVPR 模板", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	srcDir, err := service.SrcDir(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 把夹具内容铺进项目（直接复制：这些人手写的文件本来就在磁盘上）。
	if err := copyTree(fixture, srcDir); err != nil {
		t.Fatal(err)
	}

	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 5*time.Minute)
	if finished.Status != BuildSucceeded {
		t.Fatalf("真实 CVPR 模板应当编译成功，实际 %s：%s\n诊断：%+v",
			finished.Status, finished.Message, finished.Diagnostics)
	}
	if finished.Pages < 5 {
		t.Fatalf("这份模板应当排出 5 页，实际 %d", finished.Pages)
	}

	// 位置规则：警告不许凭空带文件。允许带文件只有一种情况——我们在项目源码里
// 真的找到了那个引用键（locationSource=search），此时位置必须经得起核对。
	for _, diagnostic := range finished.Diagnostics {
		if diagnostic.File == "" && diagnostic.Line == 0 {
			continue
		}
		if diagnostic.Severity != "error" && diagnostic.LocationSource != locationSearch {
			t.Fatalf("警告/提示的文件位置只能来自项目内查找，实际 source=%q：%+v",
				diagnostic.LocationSource, diagnostic)
		}
		if diagnostic.LocationSource == locationSearch {
			// 核对：那一行必须真的有这个键的使用。
			content, err := os.ReadFile(filepath.Join(srcDir, filepath.FromSlash(diagnostic.File)))
			if err != nil {
				t.Fatalf("诊断指向的文件读不到: %v（%s）", err, diagnostic.File)
			}
			lines := strings.Split(string(content), "\n")
			if diagnostic.Line < 1 || diagnostic.Line > len(lines) {
				t.Fatalf("行号越界: %s:%d", diagnostic.File, diagnostic.Line)
			}
			key := ""
			for _, pattern := range []*regexp.Regexp{undefinedCitation, undefinedReference} {
				if match := pattern.FindStringSubmatch(diagnostic.Message); match != nil {
					key = match[1]
				}
			}
			if key == "" || !strings.Contains(lines[diagnostic.Line-1], key) {
				t.Fatalf("定位不准：%s:%d 里没有 %q（该行是 %q）",
					diagnostic.File, diagnostic.Line, key, lines[diagnostic.Line-1])
			}
		}
		if diagnostic.Source == "" {
			t.Fatalf("应当标明是谁报的：%+v", diagnostic)
		}
	}

	// 多趟上限没有被突破（提前收手只能靠「.aux 已稳定」这个证据）。
	stdout, readErr := os.ReadFile(filepath.Join(mustBuildDir(t, service, project.ID, finished.ID), "readx-build.out"))
	if readErr != nil {
		t.Fatalf("读不到编译输出: %v", readErr)
	}
	passes := strings.Count(string(stdout), "Output written on")
	if passes < 1 || passes > maxPasses {
		t.Fatalf("趟数应当在 1~%d 之间，实际 %d 趟", maxPasses, passes)
	}
	t.Logf("真实 CVPR 模板：%d 页、%d 个警告、%d 趟编译、诊断 %d 条",
		finished.Pages, finished.WarningCount, passes, len(finished.Diagnostics))
	finalSummary := ParseLogFile(filepath.Join(mustBuildDir(t, service, project.ID, finished.ID), "main.log"))
	t.Logf("最后一趟日志单独解析：错误 %d / 警告 %d / 诊断 %d 条",
		finalSummary.Errors, finalSummary.Warnings, len(finalSummary.Diagnostics))
	var rowErrors, rowWarnings int
	var rowMessage string
	if err := service.db.QueryRowContext(ctx,
		`SELECT error_count, warning_count, message FROM latex_builds WHERE id = ?`, finished.ID,
	).Scan(&rowErrors, &rowWarnings, &rowMessage); err != nil {
		t.Fatalf("读构建行失败: %v", err)
	}
	// 界面上的数字与列表必须同源：库里的警告数要和诊断列表里的 warning 条数一致。
	warningRows := 0
	for _, diagnostic := range finished.Diagnostics {
		if diagnostic.Severity == "warning" {
			warningRows++
		}
	}
	if rowWarnings != warningRows {
		t.Fatalf("「%d 个警告」与列表里的 %d 条对不上", rowWarnings, warningRows)
	}
	t.Logf("数据库构建行：错误 %d / 警告 %d / message=%q", rowErrors, rowWarnings, rowMessage)
	for _, diagnostic := range finished.Diagnostics {
		t.Logf("  [%s] source=%q file=%q line=%d locationSource=%q msg=%q",
			diagnostic.Severity, diagnostic.Source, diagnostic.File, diagnostic.Line, diagnostic.LocationSource, diagnostic.Message)
	}
}

func mustBuildDir(t *testing.T, service *Service, projectID, buildID string) string {
	t.Helper()
	dir, err := service.BuildDir(projectID, buildID)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// 关键回归：评审模式（lineno 页边行号）的参照要靠上一份 .aux，而每次编译都是新目录。
// 沿用辅助文件之后，第二次编译应当不再报 lineno 警告——也就是行号终于算对了。
//
// 实测依据（同一个目录里手跑）：第 1、2 趟报，第 3 趟起对上，第 5 趟彻底稳定；
// 每趟都换空目录则永远停在 “re-run to get it right”。
func TestBuildReusesAuxiliaryFilesSoLineNumbersResolve(t *testing.T) {
	requireTeX(t)
	fixture := cvprFixtureDir()
	if info, err := os.Stat(fixture); err != nil || !info.IsDir() {
		t.Skipf("没有真实 CVPR 模板夹具（%s）", fixture)
	}
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "CVPR 复用辅助文件", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	srcDir, err := service.SrcDir(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := copyTree(fixture, srcDir); err != nil {
		t.Fatal(err)
	}

	first := startAndWait(t, service, ctx, project.ID, 5*time.Minute)
	if first.Status != BuildSucceeded {
		t.Fatalf("第一次编译应当成功：%s %s", first.Status, first.Message)
	}
	// 第二次编译：新目录，但会沿用第一次的 .aux/.bbl/.brf…
	second := startAndWait(t, service, ctx, project.ID, 5*time.Minute)
	if second.Status != BuildSucceeded {
		t.Fatalf("第二次编译应当成功：%s %s", second.Status, second.Message)
	}
	if second.Pages != first.Pages {
		t.Fatalf("页数不该变：%d → %d", first.Pages, second.Pages)
	}
	for _, diagnostic := range second.Diagnostics {
		if strings.Contains(diagnostic.Message, "Line number reference failed") {
			t.Fatalf("第二次编译不该再报行号参照失败（说明 .aux 没沿用上）：%+v", diagnostic)
		}
	}

	// 安全性：沿用的是辅助文件，绝不能把上一次的 PDF/日志搬过来。
	secondDir := mustBuildDir(t, service, project.ID, second.ID)
	firstPDF := filepath.Join(mustBuildDir(t, service, project.ID, first.ID), "main.pdf")
	secondPDF := filepath.Join(secondDir, "main.pdf")
	firstPDFInfo, err := os.Stat(firstPDF)
	if err != nil {
		t.Fatal(err)
	}
	secondPDFInfo, err := os.Stat(secondPDF)
	if err != nil {
		t.Fatal(err)
	}
	if secondPDFInfo.ModTime().Before(firstPDFInfo.ModTime()) {
		t.Fatal("第二次的 PDF 不该是上一次的副本")
	}
	t.Logf("第二次编译：%d 页、%d 个警告、诊断 %d 条（lineno 警告已消失）",
		second.Pages, second.WarningCount, len(second.Diagnostics))
}

// startAndWait 起一次编译并等它进入终态。
func startAndWait(t *testing.T, service *Service, ctx context.Context, projectID string, timeout time.Duration) *Build {
	t.Helper()
	build, err := service.StartBuild(ctx, projectID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return waitForBuild(t, service, build.ID, timeout)
}

// copyTree 递归复制目录（跳过符号链接），供夹具铺进项目使用。
func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
			return err
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.Create(destination)
		if err != nil {
			return err
		}
		if _, err := io.Copy(output, input); err != nil {
			output.Close()
			return err
		}
		return output.Close()
	})
}