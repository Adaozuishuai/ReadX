package latex

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestMacLatexmkCompilesWithFinderPATH(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("Finder environment regression requires macOS")
	}
	t.Setenv("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
	report := requireTeX(t)
	if report.Strategy != "latexmk" {
		t.Skip("MacTeX with latexmk is required for this regression")
	}
	service := newTestService(t)
	project := seedCompilableProject(t, service)
	build, err := service.StartBuild(context.Background(), project.ID, BuildOptions{Engine: string(EnginePDFLaTeX)})
	if err != nil {
		t.Fatal(err)
	}
	finished := waitForBuild(t, service, build.ID, time.Minute)
	if finished.Status != BuildSucceeded || !finished.HasPDF {
		log, _ := service.BuildLog(context.Background(), build.ID)
		t.Fatalf("latexmk must find its engine and bibliography tools without a shell PATH: %s %s\n%s", finished.Status, finished.Reason, log)
	}
	if len(finished.MissingCitations) != 0 || len(finished.MissingReferences) != 0 {
		t.Fatalf("references must resolve through the child toolchain: %+v", finished)
	}
}
