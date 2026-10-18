//go:build windows

package securefile

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// restrict 用显式 DACL 把访问权收给当前用户（以及 SYSTEM / Administrators）。
// SDDL 的 D:P 表示受保护的 DACL：不再继承父目录的 ACE，这正是 chmod 做不到的部分。
func restrict(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	user, err := currentUserSID()
	if err != nil {
		return fmt.Errorf("读取当前用户 SID 失败: %w", err)
	}
	// 目录必须带 OICI（对象继承 + 容器继承），否则目录内新建的文件拿不到任何 ACE，
	// SQLite / 配置临时文件会直接打不开。
	inherit := ""
	if info.IsDir() {
		inherit = "OICI"
	}
	sddl := fmt.Sprintf("D:P(A;%s;FA;;;SY)(A;%s;FA;;;BA)(A;%s;FA;;;%s)", inherit, inherit, inherit, user)
	descriptor, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return fmt.Errorf("构造安全描述符失败: %w", err)
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return fmt.Errorf("读取 DACL 失败: %w", err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return fmt.Errorf("设置 DACL 失败: %w", err)
	}
	return nil
}

// currentUserSID 返回形如 S-1-5-21-… 的字符串，直接拼进 SDDL。
func currentUserSID() (string, error) {
	// GetCurrentProcessToken 返回伪句柄，不需要（也不应）Close。
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	if user.User.Sid == nil {
		return "", fmt.Errorf("当前令牌没有用户 SID")
	}
	return user.User.Sid.String(), nil
}
