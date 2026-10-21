package ai

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMacCodexCandidatesIncludeChatGPTAndCommonCLILocations(t *testing.T) {
	home := "/Users/tester"
	candidates := macCodexCandidates(home)
	want := map[string]string{
		filepath.Join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"):      "desktop",
		filepath.Join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"): "desktop",
		filepath.Join(home, ".local", "bin", "codex"):      "cli",
		filepath.Join(home, ".npm-global", "bin", "codex"): "cli",
		"/opt/homebrew/bin/codex":                          "cli",
		"/usr/local/bin/codex":                             "cli",
	}
	for _, candidate := range candidates {
		if source, ok := want[candidate.path]; ok {
			if candidate.source != source {
				t.Errorf("candidate %q source = %q, want %q", candidate.path, candidate.source, source)
			}
			delete(want, candidate.path)
		}
	}
	for path := range want {
		t.Errorf("missing Codex candidate %q", path)
	}
}

func TestFindCodexCandidateSkipsMissingOrNonExecutablePaths(t *testing.T) {
	dir := t.TempDir()
	nonExecutable := filepath.Join(dir, "not-executable")
	if err := os.WriteFile(nonExecutable, []byte("test"), 0o600); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(dir, "codex")
	if err := os.WriteFile(executable, []byte("test"), 0o700); err != nil {
		t.Fatal(err)
	}
	want := codexCandidate{path: executable, source: "desktop"}
	got, ok := findCodexCandidate([]codexCandidate{
		{path: filepath.Join(dir, "missing"), source: "desktop"},
		{path: nonExecutable, source: "desktop"},
		want,
	})
	if !ok || got != want {
		t.Fatalf("findCodexCandidate() = %#v, %v; want %#v, true", got, ok, want)
	}
}
