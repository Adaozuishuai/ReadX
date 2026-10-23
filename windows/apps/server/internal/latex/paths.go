// Package latex 实现 LaTeX Studio：项目存储、文件管理、真实编译与安全边界。
//
// 与既有链路彻底分离：LaTeX Studio 用独立命名空间（SQLite 的 latex_* 表、
// <dataRoot>/latex-projects/ 目录），不改动阅读、OCR 翻译与 PPT 的任何接口语义。
// 源码以磁盘文件为权威，SQLite 只做索引与构建记录（见 ReadX_LaTeX_Studio.md §6）。
package latex

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// 路径安全的硬要求（规格 §12）：
//   - 只接受相对路径，统一用 `/`；
//   - 拒绝 `..`、绝对路径、盘符、UNC、Windows 设备名、控制字符与不可见分隔符；
//   - 解析 symlink/junction，任何情况下都不许逃出项目 src/ 之外。
//
// 只做 filepath.Clean 是不够的：`a/../../b` 会被 Clean 掉但不能证明最终位置在项目内，
// 符号链接更会绕过纯字符串判断。所以这里分两步——先规范化字符串，再对**真实路径**复核包含关系。
var (
	ErrUnsafePath       = errors.New("项目内路径不安全")
	ErrNotFound         = errors.New("文件不存在")
	ErrRevisionMismatch = errors.New("文件已被其它程序修改，请先重新加载")
	ErrTooLarge         = errors.New("文件超过大小上限")
	ErrBinaryFile       = errors.New("这是二进制文件，不能在编辑器里直接保存")
)

const (
	// MaxPathLength 与 maxComponents 一起限制过深/过长的相对路径。
	MaxPathLength = 240
	maxComponents = 32
	// MaxFileBytes 是单个源码文件上限（8 MB）：源码不该这么大，超过多半是误上传。
	MaxFileBytes = 8 << 20
	// MaxTreeEntries 限制一次列目录的规模，避免超大目录把工作区拖死。
	MaxTreeEntries = 5000
	// maxTreeDepth 限制目录层级。
	maxTreeDepth = 8
)

// windowsReserved 是 Windows 上的设备名：即便带扩展名（con.txt）也仍然危险。
var windowsReserved = map[string]bool{
	"con": true, "prn": true, "aux": true, "nul": true,
	"com1": true, "com2": true, "com3": true, "com4": true, "com5": true,
	"com6": true, "com7": true, "com8": true, "com9": true,
	"lpt1": true, "lpt2": true, "lpt3": true, "lpt4": true, "lpt5": true,
	"lpt6": true, "lpt7": true, "lpt8": true, "lpt9": true,
}

// NormalizeRelative 把用户/压缩包给的路径规范化成项目内的相对路径。
//
// 返回值一律用 `/` 分隔、不含 `.` 与空段；任何可疑输入直接报错而不是「尽力修好」——
// 猜用户的意图正是路径逃逸的温床。
func NormalizeRelative(raw string) (string, error) {
	if !utf8.ValidString(raw) {
		return "", fmt.Errorf("%w: 路径不是合法 UTF-8", ErrUnsafePath)
	}
	// 反斜杠统一成 `/`：Windows 用户与从 Windows 打的压缩包都会给反斜杠。
	value := strings.ReplaceAll(raw, "\\", "/")
	value = strings.TrimPrefix(value, "./")
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%w: 路径为空", ErrUnsafePath)
	}
	if strings.HasPrefix(value, "/") {
		return "", fmt.Errorf("%w: 不接受绝对路径", ErrUnsafePath)
	}
	// 盘符（C:/）与 UNC（//server/share）在这里已经被上面两步挡住一半，这里补齐盘符判断。
	if len(value) >= 2 && value[1] == ':' {
		return "", fmt.Errorf("%w: 不接受盘符", ErrUnsafePath)
	}
	for _, r := range value {
		if unicode.IsControl(r) || r == 0x7f {
			return "", fmt.Errorf("%w: 路径含控制字符", ErrUnsafePath)
		}
		// 不可见分隔符：看起来像空格，实际会把一个名字切成两个。
		switch r {
		case '\u2028', '\u2029', '\u0085', '\ufeff':
			return "", fmt.Errorf("%w: 路径含不可见分隔符", ErrUnsafePath)
		}
	}

	parts := strings.Split(value, "/")
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			return "", fmt.Errorf("%w: 不接受上级目录", ErrUnsafePath)
		}
		if err := checkComponent(part); err != nil {
			return "", err
		}
		cleaned = append(cleaned, part)
	}
	if len(cleaned) == 0 {
		return "", fmt.Errorf("%w: 路径没有有效层级", ErrUnsafePath)
	}
	if len(cleaned) > maxComponents {
		return "", fmt.Errorf("%w: 目录层级过深", ErrUnsafePath)
	}
	result := strings.Join(cleaned, "/")
	if len(result) > MaxPathLength {
		return "", fmt.Errorf("%w: 路径过长", ErrUnsafePath)
	}
	return result, nil
}

func checkComponent(part string) error {
	if strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") {
		// Windows 会静默去掉结尾的点与空格，导致「写入的名字」和「读到的名字」不一致。
		return fmt.Errorf("%w: 名字不能以点或空格结尾", ErrUnsafePath)
	}
	base := part
	if index := strings.IndexByte(part, '.'); index >= 0 {
		base = part[:index]
	}
	if windowsReserved[strings.ToLower(base)] {
		return fmt.Errorf("%w: %q 是系统保留名", ErrUnsafePath, part)
	}
	return nil
}

// ResolveUnder 把相对路径解析到 root 下的真实位置，并确认它确实位于 root 之内。
//
// 「确实位于」是按**解析过符号链接的真实路径**判断的：先对最深已存在的祖先做
// EvalSymlinks，再确认它仍在 root 内；不存在的尾巴（即将新建的文件）沿用这个祖先。
func ResolveUnder(root, relative string) (string, error) {
	cleaned, err := NormalizeRelative(relative)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, filepath.FromSlash(cleaned))
	if err := ensureContained(root, target); err != nil {
		return "", err
	}
	return target, nil
}

// ensureContained 校验 target 在解析符号链接之后仍位于 root 内。
func ensureContained(root, target string) error {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		// root 还不存在（例如刚创建项目目录）：退化成绝对路径比较。
		resolvedRoot, err = filepath.Abs(root)
		if err != nil {
			return fmt.Errorf("%w: 无法解析项目根目录", ErrUnsafePath)
		}
	}
	ancestor := target
	for {
		if _, statErr := os.Lstat(ancestor); statErr == nil {
			break
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			break
		}
		ancestor = parent
	}
	resolvedAncestor, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return fmt.Errorf("%w: 无法解析目标路径", ErrUnsafePath)
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedAncestor)
	if err != nil {
		return fmt.Errorf("%w: 目标不在项目目录内", ErrUnsafePath)
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%w: 目标逃出了项目目录", ErrUnsafePath)
	}
	return nil
}

// FileKind 按扩展名分类，供前端选图标与决定能否在编辑器里打开。
func FileKind(name string) string {
	extension := strings.ToLower(filepath.Ext(name))
	switch extension {
	case ".tex", ".ltx", ".cls", ".sty", ".bst", ".def", ".cfg":
		return "tex"
	case ".bib":
		return "bib"
	case ".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".gif", ".webp", ".tif", ".tiff", ".bmp":
		return "image"
	case ".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".js", ".ts", ".py", ".sh", ".m":
		return "text"
	default:
		return "other"
	}
}

// editableKind 判断这类文件能否通过 API 直接写入文本内容。
func editableKind(kind string) bool {
	return kind == "tex" || kind == "bib" || kind == "text"
}
