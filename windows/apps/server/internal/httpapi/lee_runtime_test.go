package httpapi

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLeePipelinePythonResolvesConfiguredWindowsVenv(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows venv launch behavior")
	}
	root := t.TempDir()
	venvPython := filepath.Join(root, ".retain-runtime", "Scripts", "python.exe")
	basePython := filepath.Join(root, "python", "python.exe")
	if err := os.MkdirAll(filepath.Dir(venvPython), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(basePython), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(venvPython, []byte("venv"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(basePython, []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".retain-runtime", "pyvenv.cfg"), []byte("home = "+filepath.Dir(basePython)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sitePackages := filepath.Join(root, ".retain-runtime", "Lib", "site-packages")
	if err := os.MkdirAll(sitePackages, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("READX_PYTHON", venvPython)

	gotPython, _, gotSitePackages, err := leePipelinePython(root)
	if err != nil {
		t.Fatal(err)
	}
	if gotPython != basePython {
		t.Fatalf("python = %q, want base interpreter %q", gotPython, basePython)
	}
	if gotSitePackages != sitePackages {
		t.Fatalf("site-packages = %q, want %q", gotSitePackages, sitePackages)
	}
}
