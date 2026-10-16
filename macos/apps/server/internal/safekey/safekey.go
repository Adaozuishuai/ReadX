// Package safekey 校验「能当文件名用的键」。
//
// 旧版 windows/src/core/store.ts 里有同一条规则（isSafePathKey / assertSafePathKey），
// v2 必须保持一致：键来自论文标识（arXiv id / 自定义 id），会被拼进
// library/text/<key>-v3.txt 与 app/data/readings/<key>.json 的路径，
// 一旦放行 ".." 或绝对路径就是任意文件读写。
package safekey

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const maxLength = 300

var reserved = map[string]bool{
	"__proto__":   true,
	"constructor": true,
	"prototype":   true,
}

// Check 返回 nil 表示该键可以安全用于对象键与文件路径片段。
func Check(key string) error {
	if key == "" {
		return errors.New("键不能为空")
	}
	if !utf8.ValidString(key) {
		return errors.New("键含非法 UTF-8")
	}
	if len(key) > maxLength {
		return fmt.Errorf("键过长（%d > %d）", len(key), maxLength)
	}
	if reserved[key] {
		return fmt.Errorf("键 %q 是保留名，禁止使用", key)
	}
	if strings.ContainsRune(key, rune(0)) {
		return errors.New("键含 NUL 字符")
	}
	if strings.Contains(key, "..") {
		return errors.New("键含 ..，可能造成路径穿越")
	}
	if strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") {
		return errors.New("键不能以路径分隔符开头")
	}
	if hasWindowsDrivePrefix(key) {
		return errors.New("键不能是绝对路径")
	}
	if strings.ContainsAny(key, "/\\") {
		return errors.New("键含路径分隔符")
	}
	return nil
}

// hasWindowsDrivePrefix 对应 TS 的 /^[A-Za-z]:/。
func hasWindowsDrivePrefix(key string) bool {
	if len(key) < 2 || key[1] != ':' {
		return false
	}
	c := key[0]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// MustCheck 用于「拿不到合法键就直接失败」的场合。
func MustCheck(key, what string) (string, error) {
	if err := Check(key); err != nil {
		return "", fmt.Errorf("非法%s：%w", what, err)
	}
	return key, nil
}
