package latex

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/db"
)

// newTestService 用真实 SQLite（跑真实迁移）与临时数据根造一个服务。
func newTestService(t *testing.T) *Service {
	t.Helper()
	root := t.TempDir()
	dbPath := filepath.Join(root, "reader.db")
	handle, err := db.Open(context.Background(), dbPath)
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() {
		_ = handle.Close()
		// Windows 上 SQLite 的 WAL/SHM 偶尔比连接晚一步释放，
		// 会让 t.TempDir 的 RemoveAll 报「目录非空」；带退避重试地收掉。
		deadline := time.Now().Add(3 * time.Second)
		for {
			for _, suffix := range []string{"", "-wal", "-shm"} {
				_ = os.Remove(dbPath + suffix)
			}
			if err := os.RemoveAll(root); err == nil {
				return
			}
			if time.Now().After(deadline) {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return NewService(handle, filepath.Join(root, "data"))
}

func TestNormalizeRelativeAcceptsProjectPaths(t *testing.T) {
	cases := map[string]string{
		"main.tex":              "main.tex",
		"sections/method.tex":   "sections/method.tex",
		`figures\plot.png`:      "figures/plot.png",
		"./main.tex":            "main.tex",
		"a//b.tex":              "a/b.tex",
		"sections/./method.tex": "sections/method.tex",
		"参考/正文.tex":             "参考/正文.tex",
	}
	for input, want := range cases {
		got, err := NormalizeRelative(input)
		if err != nil {
			t.Fatalf("%q 应当被接受: %v", input, err)
		}
		if got != want {
			t.Fatalf("%q 规范化成 %q，期望 %q", input, got, want)
		}
	}
}

func TestNormalizeRelativeRejectsEscapes(t *testing.T) {
	cases := map[string]string{
		"空路径":      "",
		"只有空白":     "   ",
		"上级目录":     "../secret.tex",
		"中间夹上级":    "a/../../b.tex",
		"绝对路径":     "/etc/passwd",
		"盘符":       "C:/Windows/win.ini",
		"UNC":      "//server/share/x.tex",
		"控制字符":     "main\u0000.tex",
		"不可见分隔符":   "main\u2028.tex",
		"结尾点":      "main.",
		"结尾空格":     "main ",
		"目录结尾空格":   "sections /main.tex",
		"系统保留名":    "con.tex",
		"系统保留名带扩展": "aux.bib",
		"层级过深":     strings.Repeat("a/", 40) + "x.tex",
	}
	for name, input := range cases {
		if _, err := NormalizeRelative(input); err == nil {
			t.Fatalf("%s（%q）应当被拒绝", name, input)
		} else if !errors.Is(err, ErrUnsafePath) {
			t.Fatalf("%s 应当返回 ErrUnsafePath，实际 %v", name, err)
		}
	}
}

func TestResolveUnderBlocksSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	src := filepath.Join(root, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.tex"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(src, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("当前环境不允许创建符号链接，跳过逃逸用例: %v", err)
	}
	// 字符串层面完全合法（没有 ..），只有解析真实路径才发现它通向项目外。
	if _, err := ResolveUnder(src, "escape/secret.tex"); err == nil {
		t.Fatal("穿过符号链接的路径必须被拒绝")
	}
	// 正常的项目内路径不受影响。
	if _, err := ResolveUnder(src, "sections/method.tex"); err != nil {
		t.Fatalf("普通路径应当通过: %v", err)
	}
}

func TestCreateProjectSeedsCompilableSources(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "我的论文", EngineXeLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if project.Engine != string(EngineXeLaTeX) || project.MainFile != "main.tex" {
		t.Fatalf("项目设置不对: %+v", project)
	}
	srcDir, err := service.SrcDir(project.ID)
	if err != nil {
		t.Fatal(err)
	}
	main, err := os.ReadFile(filepath.Join(srcDir, "main.tex"))
	if err != nil {
		t.Fatalf("模板 main.tex 应当存在: %v", err)
	}
	// 新项目必须能直接编译：模板要有 documentclass 与 document 环境。
	if !strings.Contains(string(main), `\documentclass`) || !strings.Contains(string(main), `\end{document}`) {
		t.Fatalf("模板不是可编译的最小文档：\n%s", main)
	}
	if _, err := os.Stat(filepath.Join(srcDir, "references.bib")); err != nil {
		t.Fatalf("模板应当带一个 .bib: %v", err)
	}
	for _, dir := range []string{"sections", "figures"} {
		if info, err := os.Stat(filepath.Join(srcDir, dir)); err != nil || !info.IsDir() {
			t.Fatalf("模板应当建好 %s 目录: %v", dir, err)
		}
	}
	list, err := service.List(ctx)
	if err != nil || len(list) != 1 || list[0].ID != project.ID {
		t.Fatalf("项目列表不对: %v %+v", err, list)
	}
}

func TestCreateProjectValidatesInputs(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	// 非法引擎回落到 pdflatex（不把任意命令交给引擎选择）。
	project, err := service.Create(ctx, "x", Engine("rm -rf /"), "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if project.Engine != string(EnginePDFLaTeX) {
		t.Fatalf("非法引擎应当回落到 pdflatex，实际 %q", project.Engine)
	}
	// 根文档必须是 .tex，且不能是逃逸路径。
	if _, err := service.Create(ctx, "y", EnginePDFLaTeX, "../main.tex"); err == nil {
		t.Fatal("逃逸的根文档路径必须被拒绝")
	}
	if _, err := service.Create(ctx, "z", EnginePDFLaTeX, "notes.md"); err == nil {
		t.Fatal("非 .tex 根文档必须被拒绝")
	}
	// 空标题有兜底，不该失败。
	blank, err := service.Create(ctx, "   ", EnginePDFLaTeX, "main.tex")
	if err != nil || strings.TrimSpace(blank.Title) == "" {
		t.Fatalf("空标题应当有兜底: %v %+v", err, blank)
	}
}

func TestUpdateProjectGuardsMainFile(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{MainFile: stringPtr("sections/method.tex")}); err != nil {
		t.Fatalf("已存在的 .tex 应当能设为根文档: %v", err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{MainFile: stringPtr("nope.tex")}); err == nil {
		t.Fatal("不存在的根文档必须被拒绝")
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{Engine: stringPtr("bash")}); err == nil {
		t.Fatal("非法引擎必须被拒绝（更新路径不做回落）")
	}
	title := "改名后的项目"
	updated, err := service.Update(ctx, project.ID, ProjectPatch{Title: &title, AutoCompile: boolPtr(true)})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != title || !updated.AutoCompile {
		t.Fatalf("局部更新没生效: %+v", updated)
	}
}

func TestDeleteProjectRemovesRowsAndDirectory(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	dir, _ := service.ProjectDir(project.ID)
	if err := service.Delete(ctx, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Get(ctx, project.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后应当查不到: %v", err)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("删除后目录应当消失: %v", err)
	}
	if err := service.Delete(ctx, project.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复删除应当返回 ErrNotFound: %v", err)
	}
}

func TestManifestTracksContentChanges(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	first, err := service.Manifest(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte("changed"), ""); err != nil {
		t.Fatal(err)
	}
	second, err := service.Manifest(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("内容变化后源码指纹必须变化（编译产物靠它判断对应哪个版本）")
	}
}

func TestServiceRejectsUnsafeProjectID(t *testing.T) {
	service := newTestService(t)
	for _, id := range []string{"", "..", "a/b", `a\b`} {
		if _, err := service.SrcDir(id); err == nil {
			t.Fatalf("项目编号 %q 必须被拒绝", id)
		}
	}
	_ = sql.ErrNoRows // 保持 database/sql 引入（Get 的错误语义依赖它）
}

func stringPtr(value string) *string { return &value }
func boolPtr(value bool) *bool       { return &value }
