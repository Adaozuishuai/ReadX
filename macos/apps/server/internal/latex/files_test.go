package latex

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTreeListsDirectoriesFirst(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := service.Tree(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(nodes) == 0 {
		t.Fatal("新项目不该是空树")
	}
	// 树是深度优先的扁平列表；规则是「同一层里目录排在文件之前」，不是「所有目录排在最前」。
	index := map[string]int{}
	for position, node := range nodes {
		index[node.Path] = position
	}
	firstFile := map[string]int{}
	lastDir := map[string]int{}
	for position, node := range nodes {
		parent := ""
		if slash := strings.LastIndex(node.Path, "/"); slash >= 0 {
			parent = node.Path[:slash]
		}
		if node.Kind == "dir" {
			lastDir[parent] = position
			continue
		}
		if _, seen := firstFile[parent]; !seen {
			firstFile[parent] = position
		}
	}
	for parent, filePosition := range firstFile {
		if dirPosition, ok := lastDir[parent]; ok && dirPosition > filePosition {
			t.Fatalf("%q 这一层里目录排到了文件之后: %+v", parent, nodes)
		}
	}
	// 深度优先：有子节点的目录，其后紧跟的就是自己的子节点（空目录不适用）。
	for position, node := range nodes {
		if node.Kind != "dir" || position+1 >= len(nodes) {
			continue
		}
		hasChild := false
		for _, candidate := range nodes {
			if strings.HasPrefix(candidate.Path, node.Path+"/") {
				hasChild = true
				break
			}
		}
		if !hasChild {
			continue
		}
		next := nodes[position+1]
		if !strings.HasPrefix(next.Path, node.Path+"/") {
			t.Fatalf("目录 %s 后面应当紧跟它的子节点，实际是 %s", node.Path, next.Path)
		}
	}
	paths := map[string]string{}
	for _, node := range nodes {
		paths[node.Path] = node.Kind
	}
	for path, kind := range map[string]string{"main.tex": "tex", "references.bib": "bib", "sections": "dir", "sections/method.tex": "tex"} {
		if paths[path] != kind {
			t.Fatalf("树里缺少 %s（kind=%s）: %+v", path, kind, paths)
		}
	}
}

func TestWriteFileIsAtomicAndRevisionChecked(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	read, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}

	// 用错误 revision 保存：必须拒绝，且磁盘内容不变。
	_, err = service.WriteFile(ctx, project.ID, "main.tex", []byte("overwrite"), "deadbeefdeadbeef")
	if !errors.Is(err, ErrRevisionMismatch) {
		t.Fatalf("revision 不匹配时应当拒绝保存，实际 %v", err)
	}
	after, _ := service.ReadFile(ctx, project.ID, "main.tex")
	if after.Content != read.Content {
		t.Fatal("被拒绝的保存不能改动磁盘内容")
	}

	// 用正确 revision 保存：成功且 revision 变化。
	next := read.Content + "\n% 追加一行\n"
	revision, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(next), read.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if revision == read.Revision {
		t.Fatal("内容变化后 revision 必须变化")
	}
	reloaded, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil || reloaded.Content != next {
		t.Fatalf("保存后应当读到新内容: %v", err)
	}
	// 写盘过程不能留下临时文件。
	entries, _ := os.ReadDir(filepath.Dir(filepath.Join(mustSrc(t, service, project.ID), "main.tex")))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".readx-") {
			t.Fatalf("原子写入不应留下临时文件: %s", entry.Name())
		}
	}
}

func TestWriteFileCreatesNestedDirectories(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "sections/exp/results.tex", []byte("% results"), ""); err != nil {
		t.Fatalf("应当自动建目录: %v", err)
	}
	read, err := service.ReadFile(ctx, project.ID, "sections/exp/results.tex")
	if err != nil || read.Content != "% results" {
		t.Fatalf("新建文件应当读得回来: %v", err)
	}
}

func TestReadAndWriteRejectBinaryKinds(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	src := mustSrc(t, service, project.ID)
	if err := os.WriteFile(filepath.Join(src, "figures", "plot.png"), []byte{0x89, 'P', 'N', 'G'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReadFile(ctx, project.ID, "figures/plot.png"); !errors.Is(err, ErrBinaryFile) {
		t.Fatalf("图片不该按文本读: %v", err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "figures/plot.png", []byte("x"), ""); !errors.Is(err, ErrBinaryFile) {
		t.Fatalf("图片不该按文本写: %v", err)
	}
	if _, err := service.Tree(ctx, project.ID); err != nil {
		t.Fatal(err)
	}
}

func TestDeletePathProtectsMainFile(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeletePath(ctx, project.ID, "main.tex"); err == nil {
		t.Fatal("根文档不能删除")
	}
	if err := service.DeletePath(ctx, project.ID, "sections/method.tex"); err != nil {
		t.Fatalf("普通文件应当能删除: %v", err)
	}
	if _, err := service.ReadFile(ctx, project.ID, "sections/method.tex"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后应当查不到: %v", err)
	}
}

func TestApplyFileOpEditsAndGuards(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "new-file", To: "sections/new.tex"}); err != nil {
		t.Fatal(err)
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "new-file", To: "sections/new.tex"}); err == nil {
		t.Fatal("同名新建必须被拒绝")
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "new-file", To: "figures/x.png"}); err == nil {
		t.Fatal("新建接口只允许文本类文件")
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "new-dir", To: "appendix"}); err != nil {
		t.Fatal(err)
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "copy", From: "sections/new.tex", To: "appendix/copied.tex"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ReadFile(ctx, project.ID, "appendix/copied.tex"); err != nil {
		t.Fatalf("复制结果应当存在: %v", err)
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "move", From: "appendix", To: "appendix/inner"}); err == nil {
		t.Fatal("目录不能移进自己的子目录")
	}
	// 重命名根文档时必须同步改设置，否则项目指向不存在的入口。
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "rename", From: "main.tex", To: "paper.tex"}); err != nil {
		t.Fatal(err)
	}
	updated, err := service.Get(ctx, project.ID)
	if err != nil || updated.MainFile != "paper.tex" {
		t.Fatalf("根文档设置没跟着改: %v %+v", err, updated)
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "explode", From: "a", To: "b"}); err == nil {
		t.Fatal("未知操作必须被拒绝")
	}
}

func TestImportZipStripsCommonRootAndSkipsJunk(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	// 覆盖模板里的 main.tex，模拟「导入一个真实项目」。
	archive := buildZip(t, []zipEntry{
		{Name: "my-paper/main.tex", Body: "\\documentclass{article}\n\\begin{document}hi\\end{document}"},
		{Name: "my-paper/sections/intro.tex", Body: "\\section{Intro}"},
		{Name: "my-paper/references.bib", Body: "@article{a}"},
		{Name: "my-paper/figures/figure1.png", Body: "PNGDATA"},
		{Name: "my-paper/__MACOSX/._main.tex", Body: "junk"},
		{Name: "my-paper/.DS_Store", Body: "junk"},
		{Name: "my-paper/build/main.aux", Body: "\\relax"},
	})
	report, err := service.ImportZip(ctx, project.ID, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	if report.Files != 4 {
		t.Fatalf("应当写入 4 个文件（公共顶层目录已剥掉、系统垃圾与副产物已跳过），实际 %d：%+v", report.Files, report)
	}
	if joined := strings.Join(report.Skipped, " "); !strings.Contains(joined, "main.aux") {
		t.Fatalf("被跳过的副产物必须如实列出: %+v", report)
	}
	if report.MainFile != "main.tex" {
		t.Fatalf("根文档应当识别为 main.tex，实际 %q", report.MainFile)
	}
	src := mustSrc(t, service, project.ID)
	for _, path := range []string{"main.tex", "sections/intro.tex", "references.bib", "figures/figure1.png"} {
		if _, err := os.Stat(filepath.Join(src, filepath.FromSlash(path))); err != nil {
			t.Fatalf("导入后缺少 %s: %v", path, err)
		}
	}
	// 副产物不入库：否则首次编译会带着上一次的残留。
	if _, err := os.Stat(filepath.Join(src, "build", "main.aux")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("编译副产物不该被导入")
	}
	if _, err := os.Stat(filepath.Join(src, "my-paper")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("公共顶层目录应当被剥掉，而不是原样落盘")
	}
	content, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil || !strings.Contains(content.Content, `\documentclass`) {
		t.Fatalf("导入的 main.tex 内容不对: %v", err)
	}
}

func TestImportZipRejectsZipSlipAndSymlinks(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	slip := buildZip(t, []zipEntry{
		{Name: "main.tex", Body: "\\documentclass{article}"},
		{Name: "../escape.tex", Body: "pwned"},
	})
	if _, err := service.ImportZip(ctx, project.ID, bytes.NewReader(slip), int64(len(slip))); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("Zip Slip 必须被拒绝，实际 %v", err)
	}
	// 拒绝之后不能有文件被写出去。
	projectDir, _ := service.ProjectDir(project.ID)
	if _, err := os.Stat(filepath.Join(projectDir, "escape.tex")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("被拒绝的压缩包不该写出任何文件")
	}

	// 符号链接条目：跳过并如实报告，不静默忽略。
	withLink := buildZipWithSymlink(t)
	report, err := service.ImportZip(ctx, project.ID, bytes.NewReader(withLink), int64(len(withLink)))
	if err != nil {
		t.Fatalf("含符号链接的包应当导入其余文件: %v", err)
	}
	if len(report.Skipped) == 0 || !strings.Contains(strings.Join(report.Skipped, " "), "符号链接") {
		t.Fatalf("符号链接条目必须出现在跳过清单里: %+v", report)
	}
}

func TestImportZipRejectsOversizedUpload(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ImportZip(ctx, project.ID, bytes.NewReader([]byte("x")), MaxUploadBytes+1); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("超过上限的上传必须被拒绝: %v", err)
	}
}

func TestExportZipExcludesByproducts(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	src := mustSrc(t, service, project.ID)
	for name, body := range map[string]string{
		"main.aux":          "\\relax",
		"main.log":          "log",
		"main.synctex.gz":   "gz",
		".readx-1234.tmp":   "tmp",
		"figures/chart.pdf": "%PDF-1.4 figure",
	} {
		if err := os.WriteFile(filepath.Join(src, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var buffer bytes.Buffer
	count, err := service.WriteExportZip(ctx, project.ID, &buffer)
	if err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(buffer.Bytes()), int64(buffer.Len()))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	files := 0
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		files++
		names[file.Name] = true
	}
	if !names["main.tex"] || !names["sections/method.tex"] || !names["figures/chart.pdf"] {
		t.Fatalf("导出应当包含源码与图片: %+v", names)
	}
	for _, excluded := range []string{"main.aux", "main.log", "main.synctex.gz", ".readx-1234.tmp"} {
		if names[excluded] {
			t.Fatalf("导出不该包含副产物 %s: %+v", excluded, names)
		}
	}
	if count != files {
		t.Fatalf("报告的条目数与压缩包里的文件数不符: %d vs %d", count, files)
	}
}

func TestIndexCollectsCitationsAndLabels(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "p", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "references.bib", []byte(
		"@article{lovelace2026,\n  title={A}\n}\n@inproceedings{zhang2025,\n  title={B}\n}\n"), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "sections/method.tex", []byte(
		"% 注释里的 \\cite{commented} 不该算进来\n"+
			"\\section{Method}\\label{sec:method}\n"+
			"引用两篇 \\cite{lovelace2026,zhang2025} 和 \\cite{missingKey}。\n"+
			"见 \\ref{sec:method} 与 \\ref{sec:absent}。\n"), ""); err != nil {
		t.Fatal(err)
	}
	index, err := service.Index(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(index.Citations, ",") != "lovelace2026,zhang2025" {
		t.Fatalf("引用键索引不对: %+v", index.Citations)
	}
	if len(index.Labels) != 1 || index.Labels[0] != "sec:method" {
		t.Fatalf("标签索引不对: %+v", index.Labels)
	}
	// 注释里的 cite 不算使用；用了没定义的必须列出来（编译必然报 undefined）。
	if strings.Contains(strings.Join(index.UsedCitations, ","), "commented") {
		t.Fatalf("注释里的引用不该被当成使用: %+v", index.UsedCitations)
	}
	if strings.Join(index.MissingCitations, ",") != "missingKey" {
		t.Fatalf("缺失引用不对: %+v", index.MissingCitations)
	}
	if strings.Join(index.MissingLabels, ",") != "sec:absent" {
		t.Fatalf("缺失标签不对: %+v", index.MissingLabels)
	}
}

func TestImportZipSelectsItsOwnMainDocument(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "import", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	archive := buildZip(t, []zipEntry{
		{Name: "project/paper.tex", Body: "\\documentclass{article}\n\\begin{document}Imported\\end{document}"},
		{Name: "project/references.bib", Body: "@article{imported,title={Imported}}"},
	})
	report, err := service.ImportZip(ctx, project.ID, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	updated, err := service.Get(ctx, project.ID)
	if err != nil || report.MainFile != "paper.tex" || updated.MainFile != "paper.tex" {
		t.Fatalf("导入的入口不应被预置模板遮住: report=%+v project=%+v err=%v", report, updated, err)
	}
	// 之后只追加图片时不改变入口。
	images := buildZip(t, []zipEntry{{Name: "plot.png", Body: "PNGDATA"}})
	report, err = service.ImportZip(ctx, project.ID, bytes.NewReader(images), int64(len(images)))
	if err != nil || report.MainFile != "paper.tex" {
		t.Fatalf("只导入图片不应改变入口: %+v %v", report, err)
	}
}

func TestMainDocumentFollowsAncestorDirectory(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "nested", EnginePDFLaTeX, "paper/chapters/main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if err := service.DeletePath(ctx, project.ID, "paper"); err == nil {
		t.Fatal("不能通过删除父目录绕过根文档保护")
	}
	if err := service.ApplyFileOp(ctx, project.ID, FileOp{Op: "rename", From: "paper", To: "renamed"}); err != nil {
		t.Fatal(err)
	}
	updated, err := service.Get(ctx, project.ID)
	if err != nil || updated.MainFile != "renamed/chapters/main.tex" {
		t.Fatalf("祖先目录改名后入口应跟随: %+v %v", updated, err)
	}
	if _, err := service.ReadFile(ctx, project.ID, updated.MainFile); err != nil {
		t.Fatalf("改名后的入口必须仍可读取: %v", err)
	}
	if err := service.DeletePath(ctx, project.ID, "renamed/chapters"); err == nil {
		t.Fatal("改名后仍需保护包含根文档的目录")
	}
}

func mustSrc(t *testing.T, service *Service, projectID string) string {
	t.Helper()
	dir, err := service.SrcDir(projectID)
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

type zipEntry struct {
	Name string
	Body string
}

func buildZip(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for _, entry := range entries {
		file, err := writer.Create(entry.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(entry.Body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// buildZipWithSymlink 造一个含符号链接条目的压缩包（权限位走 Unix 模式）。
func buildZipWithSymlink(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	header := &zip.FileHeader{Name: "link"}
	header.SetMode(os.ModeSymlink | 0o777)
	file, err := writer.CreateHeader(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("/etc/passwd")); err != nil {
		t.Fatal(err)
	}
	normal, err := writer.Create("main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := normal.Write([]byte("\\documentclass{article}")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
