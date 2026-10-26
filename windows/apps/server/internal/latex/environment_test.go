package latex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTeXEnvironmentPreservesPATHAndAddsDetectedTools(t *testing.T) {
	root := t.TempDir()
	original := filepath.Join(root, "custom bin")
	engineDir := filepath.Join(root, "TeX bin")
	auxDir := filepath.Join(root, "aux bin")
	t.Setenv("PATH", original)
	report := ToolchainReport{
		Engines: []Toolchain{{Path: filepath.Join(engineDir, "pdflatex"), Usable: true}},
		AuxTools: []Toolchain{
			{Path: filepath.Join(engineDir, "latexmk"), Usable: true},
			{Path: filepath.Join(auxDir, "bibtex"), Usable: true},
			{Path: filepath.Join(root, "unusable", "biber")},
		},
	}
	var got string
	for _, entry := range texProcessEnvironment(report) {
		key, value, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "PATH") {
			got = value
		}
	}
	want := strings.Join([]string{original, engineDir, auxDir}, string(os.PathListSeparator))
	if got != want {
		t.Fatalf("child PATH = %q, want %q", got, want)
	}
	if os.Getenv("PATH") != original {
		t.Fatal("a build must not change the parent process PATH")
	}
}
