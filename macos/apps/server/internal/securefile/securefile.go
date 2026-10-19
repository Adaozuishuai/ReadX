// Package securefile 收紧本地敏感文件的访问权限。
//
// Windows 上 os.Chmod 只影响只读属性、不会设置 DACL：文件会继承所在目录的 ACL，
// 在共享检出目录或多人机器上可能被其他本地账户读取/改写。这里改用显式 DACL，
// 只保留「当前用户 + SYSTEM + Administrators」。
package securefile

// RestrictToCurrentUser 尽力把文件或目录的访问权收给当前用户。
// 调用方应记录失败但继续业务写入：权限收紧是加固，不该让保存本身失败。
func RestrictToCurrentUser(path string) error { return restrict(path) }
