//go:build !windows

package securefile

import "os"

// restrict 在类 Unix 上 chmod 就是真正的权限收紧：文件只给属主读写，目录只给属主进入。
func restrict(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return os.Chmod(path, 0o700)
	}
	return os.Chmod(path, 0o600)
}
