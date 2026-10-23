package latex

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

const MaxAssetBytes = 64 << 20

var ErrAssetExists = errors.New("目标资源已存在")

// ReadAsset returns a bounded project-local non-text file for preview/download.
func (s *Service) ReadAsset(ctx context.Context, projectID, relative string) ([]byte, string, error) {
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, "", err
	}
	if _, err := s.Get(ctx, projectID); err != nil {
		return nil, "", err
	}
	target, err := ResolveUnder(srcDir, relative)
	if err != nil {
		return nil, "", err
	}
	kind := FileKind(filepath.Base(target))
	if editableKind(kind) {
		return nil, "", fmt.Errorf("%w（%s）", ErrBinaryFile, kind)
	}
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if info.IsDir() {
		return nil, "", fmt.Errorf("%w: 这是一个目录", ErrNotFound)
	}
	if info.Size() > MaxAssetBytes {
		return nil, "", fmt.Errorf("%w: %d 字节", ErrTooLarge, info.Size())
	}
	content, err := os.ReadFile(target)
	if err != nil {
		return nil, "", fmt.Errorf("读取资源失败: %w", err)
	}
	cleaned, _ := NormalizeRelative(relative)
	return content, cleaned, nil
}

// WriteAsset adds a project-local binary file without replacing existing data.
func (s *Service) WriteAsset(ctx context.Context, projectID, relative string, content io.Reader, size int64) error {
	if size < 0 || size > MaxAssetBytes {
		return fmt.Errorf("%w: %d 字节", ErrTooLarge, size)
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return err
	}
	if _, err := s.Get(ctx, projectID); err != nil {
		return err
	}
	target, err := ResolveUnder(srcDir, relative)
	if err != nil {
		return err
	}
	kind := FileKind(filepath.Base(target))
	if editableKind(kind) {
		return fmt.Errorf("只能上传图片等二进制资源，文本文件请在编辑器中新建")
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("创建资源目录失败: %w", err)
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, fs.ErrExist) {
		return ErrAssetExists
	}
	if err != nil {
		return fmt.Errorf("创建资源失败: %w", err)
	}
	cleanup := func() { _ = file.Close(); _ = os.Remove(target) }
	written, err := io.Copy(file, io.LimitReader(content, MaxAssetBytes+1))
	if err != nil {
		cleanup()
		return fmt.Errorf("写入资源失败: %w", err)
	}
	if written > MaxAssetBytes || written != size {
		cleanup()
		if written > MaxAssetBytes {
			return fmt.Errorf("%w: 超过 %d 字节", ErrTooLarge, MaxAssetBytes)
		}
		return fmt.Errorf("上传资源长度不匹配")
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("同步资源失败: %w", err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(target)
		return fmt.Errorf("关闭资源失败: %w", err)
	}
	s.Touch(ctx, projectID)
	return nil
}
