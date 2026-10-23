package latex

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Node 是文件树的一个节点。路径一律是相对 src/ 的 `/` 形式。
type Node struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Size     int64  `json:"size"`
	Modified string `json:"modifiedAt"`
}

// FileContent 是读文件的结果。
type FileContent struct {
	Path     string `json:"path"`
	Kind     string `json:"kind"`
	Content  string `json:"content"`
	Revision string `json:"revision"`
	Size     int64  `json:"size"`
}

// FileOp 支持的文件操作（规格 §7 file-ops）。
type FileOp struct {
	Op   string `json:"op"`
	From string `json:"from"`
	To   string `json:"to"`
}

// Tree 递归列出 src/。目录在前、同类按名字排序；超过规模上限直接报错而不是悄悄截断。
func (s *Service) Tree(ctx context.Context, projectID string) ([]Node, error) {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	nodes := []Node{}
	count := 0
	var walk func(dir, prefix string, depth int) error
	walk = func(dir, prefix string, depth int) error {
		if depth > maxTreeDepth {
			return fmt.Errorf("目录层级超过 %d 层", maxTreeDepth)
		}
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				return nil
			}
			return fmt.Errorf("读取目录失败: %w", readErr)
		}
		// 目录优先，然后按名字不区分大小写排序：与常见编辑器一致。
		sort.SliceStable(entries, func(i, j int) bool {
			if entries[i].IsDir() != entries[j].IsDir() {
				return entries[i].IsDir()
			}
			return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
		})
		for _, entry := range entries {
			count++
			if count > MaxTreeEntries {
				return fmt.Errorf("项目文件数超过 %d，已停止列出", MaxTreeEntries)
			}
			relative := entry.Name()
			if prefix != "" {
				relative = prefix + "/" + entry.Name()
			}
			info, infoErr := entry.Info()
			if infoErr != nil {
				continue
			}
			// 符号链接一律不列出：它可能是通往项目外的通道，编辑它等于编辑项目外文件。
			if info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				nodes = append(nodes, Node{Path: relative, Name: entry.Name(), Kind: "dir", Modified: info.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00")})
				if err := walk(filepath.Join(dir, entry.Name()), relative, depth+1); err != nil {
					return err
				}
				continue
			}
			nodes = append(nodes, Node{
				Path: relative, Name: entry.Name(), Kind: FileKind(entry.Name()), Size: info.Size(),
				Modified: info.ModTime().UTC().Format("2006-01-02T15:04:05Z07:00"),
			})
		}
		return nil
	}
	if err := walk(srcDir, "", 1); err != nil {
		return nil, err
	}
	return nodes, nil
}

// fileRevision 是文件内容的指纹，用于乐观并发：编辑前拿到它，保存时带回来。
func fileRevision(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:16])
}

// ReadFile 读文本类文件。二进制（图片等）不给编辑器读，避免把乱码当内容再写回去。
func (s *Service) ReadFile(ctx context.Context, projectID, relative string) (*FileContent, error) {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, err
	}
	target, err := ResolveUnder(srcDir, relative)
	if err != nil {
		return nil, err
	}
	kind := FileKind(filepath.Base(target))
	if !editableKind(kind) {
		return nil, fmt.Errorf("%w（%s）", ErrBinaryFile, kind)
	}
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if info.IsDir() {
		return nil, fmt.Errorf("%w: 这是一个目录", ErrNotFound)
	}
	if info.Size() > MaxFileBytes {
		return nil, fmt.Errorf("%w: %d 字节", ErrTooLarge, info.Size())
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	cleaned, _ := NormalizeRelative(relative)
	return &FileContent{
		Path: cleaned, Kind: kind, Content: string(content),
		Revision: fileRevision(content), Size: info.Size(),
	}, nil
}

// WriteFile 原子写入：同目录临时文件 + rename，避免编辑器读到写一半的文件。
//
// expectRevision 非空时要求磁盘内容与它一致，否则返回 ErrRevisionMismatch——
// 这就是「不覆写可确认的外部改动」（规格 §6 保存策略）。
func (s *Service) WriteFile(ctx context.Context, projectID, relative string, content []byte, expectRevision string) (string, error) {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return "", err
	}
	if _, err := s.Get(ctx, projectID); err != nil {
		return "", err
	}
	target, err := ResolveUnder(srcDir, relative)
	if err != nil {
		return "", err
	}
	kind := FileKind(filepath.Base(target))
	if !editableKind(kind) {
		return "", fmt.Errorf("%w（%s）", ErrBinaryFile, kind)
	}
	if len(content) > MaxFileBytes {
		return "", fmt.Errorf("%w: %d 字节", ErrTooLarge, len(content))
	}
	if expectRevision != "" {
		existing, readErr := os.ReadFile(target)
		switch {
		case readErr == nil:
			if fileRevision(existing) != expectRevision {
				return "", ErrRevisionMismatch
			}
		case errors.Is(readErr, fs.ErrNotExist):
			// 调用方以为文件存在、实际已被删除：同样属于冲突。
			return "", ErrRevisionMismatch
		default:
			return "", fmt.Errorf("读取现有文件失败: %w", readErr)
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", fmt.Errorf("创建目录失败: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".readx-*.tmp")
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败: %w", err)
	}
	tempName := temp.Name()
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		_ = os.Remove(tempName)
		return "", fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		_ = os.Remove(tempName)
		return "", fmt.Errorf("同步临时文件失败: %w", err)
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return "", fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tempName, target); err != nil {
		_ = os.Remove(tempName)
		return "", fmt.Errorf("替换目标文件失败: %w", err)
	}
	s.Touch(ctx, projectID)
	return fileRevision(content), nil
}

// DeletePath 删除文件或目录。根文档不能删：删掉它项目就再也编译不了，
// 而这种坏状态在界面上很难理解，不如在这里挡住。
func (s *Service) DeletePath(ctx context.Context, projectID, relative string) error {
	project, err := s.Get(ctx, projectID)
	if err != nil {
		return err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return err
	}
	target, err := ResolveUnder(srcDir, relative)
	if err != nil {
		return err
	}
	cleaned, _ := NormalizeRelative(relative)
	if cleaned == project.MainFile || strings.HasPrefix(project.MainFile, cleaned+"/") {
		return errors.New("当前根文档不能删除，请先把根文档设为别的 .tex")
	}
	info, err := os.Lstat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.RemoveAll(target); err != nil {
			return fmt.Errorf("删除目录失败: %w", err)
		}
	} else if err := os.Remove(target); err != nil {
		return fmt.Errorf("删除文件失败: %w", err)
	}
	s.Touch(ctx, projectID)
	return nil
}

// ApplyFileOp 执行新建/重命名/移动/复制。
//
// 统一在这里挡住两类破坏性操作：覆盖已有目标、把目录复制进它自己。
func (s *Service) ApplyFileOp(ctx context.Context, projectID string, op FileOp) error {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return err
	}
	project, err := s.Get(ctx, projectID)
	if err != nil {
		return err
	}
	switch op.Op {
	case "new-file", "new-dir":
		target, resolveErr := ResolveUnder(srcDir, op.To)
		if resolveErr != nil {
			return resolveErr
		}
		if _, statErr := os.Lstat(target); statErr == nil {
			return errors.New("目标已存在")
		}
		if op.Op == "new-dir" {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("创建目录失败: %w", err)
			}
			break
		}
		kind := FileKind(filepath.Base(target))
		if !editableKind(kind) {
			return fmt.Errorf("只能新建文本类文件（.tex/.bib/.txt 等），图片请用上传或导入 ZIP")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("创建目录失败: %w", err)
		}
		if err := os.WriteFile(target, []byte{}, 0o644); err != nil {
			return fmt.Errorf("创建文件失败: %w", err)
		}
	case "rename", "move", "copy":
		from, resolveErr := ResolveUnder(srcDir, op.From)
		if resolveErr != nil {
			return resolveErr
		}
		to, resolveErr := ResolveUnder(srcDir, op.To)
		if resolveErr != nil {
			return resolveErr
		}
		fromClean, _ := NormalizeRelative(op.From)
		toClean, _ := NormalizeRelative(op.To)
		if fromClean == toClean {
			return errors.New("源和目标相同")
		}
		info, statErr := os.Lstat(from)
		if errors.Is(statErr, fs.ErrNotExist) {
			return ErrNotFound
		}
		if statErr != nil {
			return statErr
		}
		if _, statErr := os.Lstat(to); statErr == nil {
			return errors.New("目标已存在")
		}
		if info.IsDir() && strings.HasPrefix(toClean+"/", fromClean+"/") {
			return errors.New("不能把目录移动到它自己的子目录里")
		}
		movesMain := fromClean == project.MainFile || (info.IsDir() && strings.HasPrefix(project.MainFile, fromClean+"/"))
		if movesMain && op.Op != "copy" {
			// 根文档自身或其祖先目录改变路径时，同步更新入口。
			newMain := toClean + strings.TrimPrefix(project.MainFile, fromClean)
			if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
				return err
			}
			if err := os.Rename(from, to); err != nil {
				return fmt.Errorf("移动根文档失败: %w", err)
			}
			if _, err := s.Update(ctx, projectID, ProjectPatch{MainFile: &newMain}); err != nil {
				// 回滚：把文件挪回去，保持设置与文件一致。
				_ = os.Rename(to, from)
				return fmt.Errorf("更新根文档设置失败: %w", err)
			}
			break
		}
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			return fmt.Errorf("创建目标目录失败: %w", err)
		}
		if op.Op == "copy" {
			if err := copyPath(from, to); err != nil {
				return err
			}
			break
		}
		if err := os.Rename(from, to); err != nil {
			return fmt.Errorf("移动失败: %w", err)
		}
	default:
		return fmt.Errorf("不支持的操作: %s", op.Op)
	}
	s.Touch(ctx, projectID)
	return nil
}

func copyPath(from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(to, 0o755); err != nil {
			return err
		}
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyPath(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer source.Close()
	target, err := os.Create(to)
	if err != nil {
		return err
	}
	defer target.Close()
	if _, err := io.Copy(target, source); err != nil {
		return err
	}
	return target.Sync()
}

// Manifest 计算源码清单指纹：编译请求带上它，用来判断「这份产物对应哪个版本的源码」。
func (s *Service) Manifest(ctx context.Context, projectID string) (string, error) {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				return nil
			}
			return readErr
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			full := filepath.Join(dir, name)
			info, infoErr := os.Lstat(full)
			if infoErr != nil || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			relative := name
			if prefix != "" {
				relative = prefix + "/" + name
			}
			if info.IsDir() {
				if err := walk(full, relative); err != nil {
					return err
				}
				continue
			}
			content, readErr := os.ReadFile(full)
			if readErr != nil {
				return readErr
			}
			// 名字与内容一起入指纹：改名也算版本变化。
			fmt.Fprintf(hash, "%s\x00%d\x00", relative, len(content))
			hash.Write(content)
		}
		return nil
	}
	if err := walk(srcDir, ""); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)[:16]), nil
}
