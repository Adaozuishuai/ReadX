package latex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 警告不许凭空带文件：真实 CVPR 模板上，整篇级的宏包警告曾被算到
// 「最近打开过的文件」上，用户看到的就是「行号移位」。
func TestWarningDoesNotInventLocation(t *testing.T) {
	log := strings.Join([]string{
		"(./sec/0_abstract.tex",
		"Package lineno Warning: Line number reference failed, re-run to get it right.",
		")",
	}, "\n")
	summary := ParseLogText(log)
	if summary.Warnings != 1 {
		t.Fatalf("应当解析出 1 条警告，实际 %d：%+v", summary.Warnings, summary.Diagnostics)
	}
	diagnostic := summary.Diagnostics[0]
	if diagnostic.Source != "Package lineno" {
		t.Fatalf("应当标明是谁报的：%q", diagnostic.Source)
	}
	if diagnostic.File != "" || diagnostic.Line != 0 {
		t.Fatalf("日志没给位置就不许造：file=%q line=%d", diagnostic.File, diagnostic.Line)
	}
	if diagnostic.LocationSource != "" {
		t.Fatalf("没有位置就不该有来源标记：%q", diagnostic.LocationSource)
	}
}

// 引用类警告：行号取日志里的「on input line N」，文件交给项目内查找去定。
func TestUndefinedKeyWarningGetsLineThenSearchLocation(t *testing.T) {
	log := strings.Join([]string{
		"(./sec/1_intro.tex",
		"LaTeX Warning: Reference `fig:short' on page 1 undefined on input line 53.",
	}, "\n")
	summary := ParseLogText(log)
	if len(summary.Diagnostics) != 1 {
		t.Fatalf("应当有 1 条诊断：%+v", summary.Diagnostics)
	}
	before := summary.Diagnostics[0]
	if before.File != "" {
		t.Fatalf("警告阶段还不该有文件（括号栈不可信）：%q", before.File)
	}
	if before.Line != 53 {
		t.Fatalf("行号应当取日志里的 input line，实际 %d", before.Line)
	}

	// 项目里真的写了 \ref{fig:short} —— 查找后应当指向那一行。
	srcDir := t.TempDir()
	writeProjectFile(t, srcDir, "sec/1_intro.tex", "line one\nline two\nsee \\ref{fig:short} for details\n")
	resolved := resolveKeyLocations(srcDir, summary.Diagnostics)
	location := resolved[0]
	if location.File != "sec/1_intro.tex" || location.Line != 3 {
		t.Fatalf("应当定位到实际使用处，实际 %s:%d", location.File, location.Line)
	}
	if location.LocationSource != locationSearch {
		t.Fatalf("位置来源应当是项目内查找：%q", location.LocationSource)
	}
}

// 找不到键时保持「没有位置」，而不是退回括号栈猜一个。
func TestUndefinedKeyWithoutMatchKeepsNoLocation(t *testing.T) {
	log := "LaTeX Warning: Citation `Nobody99' on page 1 undefined on input line 7.\n"
	summary := ParseLogText(log)
	srcDir := t.TempDir()
	writeProjectFile(t, srcDir, "main.tex", "\\documentclass{article}\n\\cite{Other}\n")
	resolved := resolveKeyLocations(srcDir, summary.Diagnostics)
	if resolved[0].File != "" || resolved[0].LocationSource != "" {
		t.Fatalf("找不到就不该给位置：%+v", resolved[0])
	}
	if resolved[0].Line != 7 {
		t.Fatalf("行号仍应保留：%d", resolved[0].Line)
	}
}

// 注释里的引用不算「使用位置」。
func TestKeySearchIgnoresComments(t *testing.T) {
	srcDir := t.TempDir()
	writeProjectFile(t, srcDir, "main.tex", "% see \\ref{fig:x} someday\nreal: \\ref{fig:x}\n")
	found := searchKeyLocations(srcDir, map[string]bool{"fig:x": true})
	location, ok := found["fig:x"]
	if !ok {
		t.Fatal("应当找到这个键")
	}
	if location.Line != 2 {
		t.Fatalf("应当跳过注释行，实际定位到第 %d 行", location.Line)
	}
}

// 错误的位置来自日志行时标为 log；l.NN 形式仍能把文件和行号补齐。
func TestErrorLocationSources(t *testing.T) {
	summary := ParseLogText("main.tex:12: Undefined control sequence.\n")
	if summary.Errors != 1 || summary.Diagnostics[0].LocationSource != locationLog {
		t.Fatalf("file:line 形式的错误应当标为 log：%+v", summary.Diagnostics)
	}
	if summary.Diagnostics[0].Line != 12 || summary.Diagnostics[0].File != "main.tex" {
		t.Fatalf("位置解析不对：%+v", summary.Diagnostics[0])
	}

	bang := ParseLogText("(./sections/method.tex\n! Undefined control sequence.\nl.42 \\foo\n")
	if bang.Errors != 1 {
		t.Fatalf("应当解析出 1 个错误：%+v", bang.Diagnostics)
	}
	errorDiagnostic := bang.Diagnostics[0]
	if errorDiagnostic.Line != 42 || errorDiagnostic.File != "sections/method.tex" {
		t.Fatalf("l.NN 形式应当补齐位置：%+v", errorDiagnostic)
	}
	// 这种位置是「当前文件 + l.NN」组合出来的，不标成来自日志。
	if errorDiagnostic.LocationSource == locationLog {
		t.Fatal("推断出来的位置不该标成来自日志")
	}
}

func writeProjectFile(t *testing.T, root, relative, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}