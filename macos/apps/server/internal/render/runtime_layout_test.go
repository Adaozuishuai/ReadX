package render

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNodeModulesInPackagedResourcesAndDevelopmentWorkspace(t *testing.T) {
	for _, packaged := range []bool{true, false} {
		t.Run(map[bool]string{true: "packaged", false: "development"}[packaged], func(t *testing.T) {
			root := t.TempDir()
			t.Chdir(root)
			t.Setenv("READX_WORKSPACE_DIR", "")
			resources := filepath.Join(root, "resources")
			moduleRoot := root
			if packaged {
				moduleRoot = resources
			}
			t.Setenv("CBCT_RENDER_ENGINE_DIR", filepath.Join(resources, "rendering-engine"))
			for _, name := range []string{"fontkit", "mathjax-full", "pdf-lib"} {
				if err := os.MkdirAll(filepath.Join(moduleRoot, "node_modules", name), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if missing := New("").missingNodeModules(); len(missing) != 0 {
				t.Fatalf("runtime dependencies not found in %s: %v", moduleRoot, missing)
			}
		})
	}
}
