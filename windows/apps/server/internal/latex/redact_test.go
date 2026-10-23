package latex

import (
	"strings"
	"testing"
)

// 用本机真实日志里出现过的行做断言：脱敏规则必须对真实输入有效，
// 而不是对我想象中的输入有效。
func TestRedactLogRemovesUsernamesAndKeepsLocations(t *testing.T) {
	log := strings.Join([]string{
		"This is pdfTeX, Version 3.141592653-2.6-1.40.28 (MiKTeX 25.12) (preloaded format=pdflatex 2026.9.5)",
		`(C:\Users\colorful\AppData\Local\Programs\MiKTeX\tex/latex/base\article.cls`,
		`Document Class: article 2025/01/22 v1.4n Standard LaTeX document class`,
		`C:\Users\colorful\AppData\Roaming\ReadX\data\latex-projects\6b13c1e2-8cc9-40ae-b705-3525abcd1234\src\main.tex:3: Undefined control sequence.`,
		`/Users/someone/Library/texmf/foo.sty`,
		`/home/other/texlive/2025/texmf-dist/tex/latex/base/report.cls`,
		`! LaTeX Error: File ` + "`missing.sty'" + ` not found.`,
	}, "\n")

	redacted := RedactLog(log)
	for _, leaked := range []string{"colorful", "someone", "other"} {
		if strings.Contains(redacted, leaked) {
			t.Fatalf("脱敏后不该出现用户名 %q：\n%s", leaked, redacted)
		}
	}
	// 诊断定位必须保留：文件与行号是修错的关键。
	if !strings.Contains(redacted, "main.tex:3") {
		t.Fatalf("脱敏不该抹掉项目内文件与行号：\n%s", redacted)
	}
	if !strings.Contains(redacted, "«project»") {
		t.Fatalf("项目目录应当被替换成「«project»」：\n%s", redacted)
	}
	// 有用的信息要留下：哪个宏包文件、哪条错误。
	if !strings.Contains(redacted, "article.cls") || !strings.Contains(redacted, "Undefined control sequence") {
		t.Fatalf("脱敏不该抹掉排错信息：\n%s", redacted)
	}
	if !strings.Contains(redacted, "missing.sty") {
		t.Fatalf("错误原文应当保留：\n%s", redacted)
	}
}

func TestRedactLogReplacesActualHomeDirectory(t *testing.T) {
	// 环境里的真实家目录也必须被替换：正则可能不认识自定义的用户目录布局。
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	text := "log line with " + home + `\AppData\Local\MiKTeX\x.log inside`
	redacted := RedactLog(text)
	if strings.Contains(redacted, home) {
		t.Fatalf("家目录本身必须被替换：%s", redacted)
	}
	if !strings.Contains(redacted, "~") {
		t.Fatalf("替换结果应当可读（用 ~ 表示家目录）：%s", redacted)
	}
}

func TestRedactForModelDropsVendorNoise(t *testing.T) {
	log := "you have not checked for MiKTeX updates for 30 days.\n" +
		"main.tex:3: Undefined control sequence.\n" +
		"pdflatex: major issue: So far, you have not checked for MiKTeX updates.\n"
	out := RedactForModel(log)
	if strings.Contains(out, "MiKTeX updates") {
		t.Fatalf("环境提示噪声不该发给模型：\n%s", out)
	}
	if !strings.Contains(out, "Undefined control sequence") {
		t.Fatalf("真正的错误必须保留：\n%s", out)
	}
}

func TestRedactLogHandlesEmptyAndCleanInput(t *testing.T) {
	if got := RedactLog(""); got != "" {
		t.Fatalf("空输入应当原样返回空，实际 %q", got)
	}
	clean := "main.tex:12: Missing $ inserted.\nl.12 x^2\n"
	if got := RedactLog(clean); got != clean {
		t.Fatalf("本来就干净的日志不该被改动：\n%q\n%q", clean, got)
	}
}
