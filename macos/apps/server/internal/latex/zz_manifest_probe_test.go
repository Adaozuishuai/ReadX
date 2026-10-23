package latex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// 临时探针：编译前后 src/ 里发生了什么、Manifest 为什么变。
func TestManifestProbeAfterBuild(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "探针", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(
		"\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n"), ""); err != nil {
		t.Fatal(err)
	}
	src, _ := service.SrcDir(project.ID)
	before, _ := service.Manifest(ctx, project.ID)
	list := func(label string) {
		var names []string
		_ = filepath.WalkDir(src, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(src, path)
			info, _ := entry.Info()
			names = append(names, rel+"("+time.Time.String(info.ModTime())+")")
			return nil
		})
		t.Logf("%s: %v", label, names)
	}
	list("编译前")
	build, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, 3*time.Minute)
	t.Logf("编译结果: %s，revision=%s", finished.Status, finished.Revision)
	list("编译后")
	after, _ := service.Manifest(ctx, project.ID)
	if before != after {
		t.Logf("Manifest 变了：%s → %s", before, after)
	} else {
		t.Logf("Manifest 没变：%s", before)
	}
	stale, _ := service.Build(ctx, build.ID)
	t.Logf("Build.Stale=%v（build.Revision=%s，current=%s）", stale.Stale, stale.Revision, after)
}
