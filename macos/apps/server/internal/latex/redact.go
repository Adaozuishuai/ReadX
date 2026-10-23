package latex

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// RedactLog 在把编译日志发出去（给模型、或导出）之前抹掉个人痕迹。
//
// 为什么必须做：真实 TeX 日志里到处是绝对路径，形如
// `C:\Users\colorful\AppData\Local\Programs\MiKTeX\tex/latex/base/article.cls`——
// 它同时暴露了操作系统用户名与目录结构。规格 §12 明确要求发送前脱敏。
//
// 脱敏保留可读性：去掉的是「谁的机器、装在哪」，保留「哪个宏包文件」。
// 因为「article.cls 报错」这类信息对定位问题有用，而 C:\Users\<名字> 没用。
func RedactLog(text string) string {
	if text == "" {
		return ""
	}
	// 先还原 TeX 的 79 列折行：折行会把 `C:/Users/name` 从中间切断
	// （真实日志里出现过 `...C:/Use` + 换行 + `rs/colorful/AppData/...`），
	// 前缀一旦断开，后面所有按前缀匹配的规则都会失效。
	out := strings.Join(unwrapLogLines(text), "\n")
	out = redactHome(out)
	// 按「路径段」形态替换本机用户名：兜住折行、拼接、以及不在 Users/ 下的写法。
	out = redactUsernameSegments(out)
	// 家目录的通用形态：\Users\<名字>、/Users/<名字>、/home/<名字>。
	out = userHomePattern.ReplaceAllString(out, "~")
	out = unixHomePattern.ReplaceAllString(out, "~")
	// 项目自身目录：只吃到项目编号为止，保留后面的 src/main.tex:12 这类定位信息。
	out = projectDirPattern.ReplaceAllString(out, "«project»")
	// 兜底：其它盘符/根路径下的用户名形态（例如 D:\home\someone）。
	out = otherUserPattern.ReplaceAllString(out, "«path»")
	return out
}

// redactUsernameSegments 把「被路径分隔符包住的用户名」替换成 ~。
//
// 只替换路径段形态（/name/ 或 \name\），不碰普通文本里恰好同名的词，
// 避免把论文正文里的单词改掉。
func redactUsernameSegments(text string) string {
	for _, name := range localUsernames() {
		for _, pattern := range []string{
			`/` + name + `/`, `\` + name + `\`,
			`/` + name + `"`, `\` + name + `"`,
		} {
			replacement := pattern
			replacement = strings.Replace(replacement, name, "~", 1)
			text = strings.ReplaceAll(text, pattern, replacement)
		}
	}
	return text
}

// localUsernames 收集本机可能出现在路径里的用户名。
func localUsernames() []string {
	seen := map[string]bool{}
	var names []string
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || value == "~" || len(value) < 2 || seen[value] {
			return
		}
		seen[value] = true
		names = append(names, value)
	}
	for _, key := range []string{"USERNAME", "USER", "LOGNAME"} {
		add(os.Getenv(key))
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Base(home))
	}
	return names
}

var (
	// C:\Users\name / C:/Users/name（只吃用户名那一段，后面的路径保留）
	userHomePattern = regexp.MustCompile(`(?i)[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s)]+`)
	// /Users/name（macOS）、/home/name（Linux）
	unixHomePattern = regexp.MustCompile(`/(?:Users|home)/[^/\s)]+`)
	// latex-projects/<uuid>：只替换到项目编号，保留其后的 src/xxx.tex:12
	projectDirPattern = regexp.MustCompile(`(?i)[A-Za-z]:?[\\/][^\s)]*?latex-projects[\\/][^\\/\s)]+`)
	otherUserPattern  = regexp.MustCompile(`(?i)(?:^|[\s(])[A-Za-z]:[\\/]+(?:home|Documents and Settings)[\\/]+[^\\/\s)]+`)
)

// RedactForModel 是「发出去之前」的统一入口：脱敏 + 去噪。
//
// MiKTeX 每次都会打印「you have not checked for MiKTeX updates」这类与本项目无关的噪声，
// 既占字数又诱导模型给出无关建议；但它属于「环境提示」而不是错误，直接删掉即可。
func RedactForModel(text string) string {
	out := RedactLog(text)
	lines := strings.Split(out, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.Contains(trimmed, "you have not checked for MiKTeX updates") {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

// redactHome 把文本里出现的本机家目录替换成 ~。
func redactHome(text string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		variants := []string{home, filepath.ToSlash(home), strings.ReplaceAll(home, `\`, `/`)}
		for _, variant := range variants {
			if variant != "" {
				text = strings.ReplaceAll(text, variant, "~")
			}
		}
	}
	return text
}
