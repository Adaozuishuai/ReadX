//go:build windows

package securefile

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// 收紧后必须是一个受保护的 DACL，只含「当前用户 + SYSTEM + Administrators」三条 ACE。
// 如果仍然继承父目录，常见会多出 Authenticated Users(读取) 与 BUILTIN\Users。
func TestRestrictToCurrentUserWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RestrictToCurrentUser(path); err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, defaulted, err := descriptor.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if dacl == nil {
		t.Fatal("DACL 不应为空")
	}
	if defaulted {
		t.Fatal("DACL 仍是默认继承的，权限没有被真正收紧")
	}
	if dacl.AceCount != 3 {
		t.Fatalf("DACL 应只有 3 条 ACE（当前用户/SYSTEM/Administrators），实际 %d", dacl.AceCount)
	}
}

func TestRestrictToCurrentUserDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RestrictToCurrentUser(dir); err != nil {
		t.Fatal(err)
	}
	descriptor, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, defaulted, err := descriptor.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("读取目录 DACL 失败: %v", err)
	}
	if defaulted || dacl.AceCount != 3 {
		t.Fatalf("目录 DACL 未收紧: defaulted=%v count=%d", defaulted, dacl.AceCount)
	}

	// 目录收紧后新建的文件必须仍然可读写（OICI 继承），否则 SQLite 会打不开数据库。
	child := filepath.Join(dir, "reader.db")
	if err := os.WriteFile(child, []byte("sqlite"), 0o600); err != nil {
		t.Fatalf("目录收紧后无法创建文件（继承的 ACE 缺失）: %v", err)
	}
	if _, err := os.ReadFile(child); err != nil {
		t.Fatalf("目录收紧后无法读取文件: %v", err)
	}
}

// 收紧权限后目录仍必须能被正常删除（t.TempDir 的清理依赖这一点）。
func TestRestrictedDirectoryIsRemovable(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RestrictToCurrentUser(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "reader.db"), []byte("sqlite"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatalf("收紧后的目录应可删除: %v", err)
	}
}
