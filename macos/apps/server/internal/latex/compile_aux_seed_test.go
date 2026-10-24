package latex

import (
	"os"
	"path/filepath"
	"testing"
)

// 沿用的只能是辅助文件：PDF、日志、synctex 绝不能搬。
//
// 搬了 PDF 的后果最严重——编译失败时界面上会出现上一次的旧 PDF，用户以为这次成功了。
// 这条测试不需要 TeX，任何环境都跑。
func TestAuxiliaryFileNamesSkipArtifacts(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"main.aux", "main.bbl", "main.brf", "main.toc", "main.run.xml"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"main.pdf", "main.log", "readx-build.out", "main.synctex.gz", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	names := auxiliaryFileNames(dir)
	got := map[string]bool{}
	for _, name := range names {
		got[name] = true
	}
	for _, expected := range []string{"main.aux", "main.bbl", "main.brf", "main.toc", "main.run.xml"} {
		if !got[expected] {
			t.Fatalf("应当沿用 %s，实际只拿到 %v", expected, names)
		}
	}
	for _, forbidden := range []string{"main.pdf", "main.log", "readx-build.out", "main.synctex.gz", "notes.txt"} {
		if got[forbidden] {
			t.Fatalf("绝不能沿用 %s（那是本次产物或无关文件），实际 %v", forbidden, names)
		}
	}
}

// 没有上一次构建时（第一次编译）安静返回，不报错。
func TestSeedAuxiliaryFilesWithoutPreviousBuild(t *testing.T) {
	service := &Service{}
	buildDir := filepath.Join(t.TempDir(), "build", "second")
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := service.seedAuxiliaryFiles("project", "second", buildDir); err != nil {
		t.Fatalf("第一次编译不该报错：%v", err)
	}
	entries, err := os.ReadDir(buildDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("不该凭空造出文件：%v", entries)
	}
}
