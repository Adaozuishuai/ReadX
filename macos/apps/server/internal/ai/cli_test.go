package ai

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMacCodexDiscoveryWithoutShellPATH(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS executable discovery")
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	for _, tc := range []struct {
		name, relative, source string
	}{
		{"Codex Desktop", "Applications/Codex.app/Contents/Resources/codex", "desktop"},
		{"ChatGPT bundled CLI", "Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "desktop"},
		{"user CLI", ".local/bin/codex", "cli"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(home, filepath.FromSlash(tc.relative))
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			got, ok := findCodexCandidate(macCodexCandidates(home, filepath.Join(home, "Applications")))
			if !ok || got.path != path || got.source != tc.source {
				t.Fatalf("discovery = %+v, %v; want %s (%s)", got, ok, path, tc.source)
			}
		})
	}
}

func TestCodexCandidateRejectsNonExecutableAndMissingFiles(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS executable permissions")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "codex")
	if err := os.WriteFile(file, []byte("not executable"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, ok := findCodexCandidate([]codexCandidate{
		{path: filepath.Join(dir, "missing")}, {path: dir}, {path: file},
	}); ok {
		t.Fatalf("invalid candidate accepted: %+v", got)
	}
}
