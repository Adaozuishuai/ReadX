package latex

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// MaxUploadBytes 是收到的 ZIP 上限（压缩后）。
	MaxUploadBytes = 256 << 20
	// MaxImportBytes 是解压后的总量上限：压缩炸弹主要靠它挡住。
	MaxImportBytes = 512 << 20
	// MaxImportFileBytes 是解压后的单文件上限。
	MaxImportFileBytes = 64 << 20
	// MaxImportEntries 是压缩包内条目数上限。
	MaxImportEntries = 4000
	// maxCompressionRatio 是「单文件解压/压缩」比上限。正常源码远低于此，
	// 高压缩比 + 大体积同时成立才拒绝，避免误伤高度重复的文本。
	maxCompressionRatio = 400
)

// ImportReport 说明这次导入到底做了什么：写了多少、跳过了什么、根文档选了谁。
// 「跳过了什么」必须如实列出来，不能静默丢弃（规格 §12）。
type ImportReport struct {
	Files    int      `json:"files"`
	Bytes    int64    `json:"bytes"`
	Skipped  []string `json:"skipped"`
	MainFile string   `json:"mainFile"`
}

// ImportZip 安全导入 ZIP：解压到项目 src/ 下。
//
// 逐条防线（规格 §12 的 ZIP 清单）：
//   - Zip Slip：条目名走 NormalizeRelative，`..`/绝对路径/盘符直接拒绝；
//   - 符号链接条目：拒绝（它能把后续写入引到项目外）；
//   - 压缩炸弹：条目数、单文件大小、解压总量、压缩比四道限制，且按**实际写入字节**计数；
//   - 同名覆盖：允许覆盖（重新导入同一项目是常见动作），但仍在 src/ 内。
func (s *Service) ImportZip(ctx context.Context, projectID string, upload io.Reader, declaredSize int64) (*ImportReport, error) {
	if declaredSize > MaxUploadBytes {
		return nil, fmt.Errorf("%w: 压缩包超过 %d MB", ErrTooLarge, MaxUploadBytes>>20)
	}
	project, err := s.Get(ctx, projectID)
	if err != nil {
		return nil, err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	projectDir, err := s.ProjectDir(projectID)
	if err != nil {
		return nil, err
	}
	tempPath := filepath.Join(projectDir, ".readx-import.zip")
	temp, err := os.Create(tempPath)
	if err != nil {
		return nil, fmt.Errorf("创建导入临时文件失败: %w", err)
	}
	// 声明的长度不可信：按实际读取字节再卡一次上限。
	written, copyErr := io.Copy(temp, io.LimitReader(upload, MaxUploadBytes+1))
	closeErr := temp.Close()
	if copyErr != nil {
		_ = os.Remove(tempPath)
		return nil, fmt.Errorf("接收压缩包失败: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tempPath)
		return nil, fmt.Errorf("保存压缩包失败: %w", closeErr)
	}
	if written > MaxUploadBytes {
		_ = os.Remove(tempPath)
		return nil, fmt.Errorf("%w: 压缩包超过 %d MB", ErrTooLarge, MaxUploadBytes>>20)
	}
	defer os.Remove(tempPath)

	reader, err := zip.OpenReader(tempPath)
	if err != nil {
		return nil, errors.New("这不是有效的 ZIP 压缩包")
	}
	defer reader.Close()
	if len(reader.File) > MaxImportEntries {
		return nil, fmt.Errorf("压缩包内条目过多（%d > %d）", len(reader.File), MaxImportEntries)
	}

	entries := make([]*zip.File, 0, len(reader.File))
	prefix := commonRoot(reader.File)
	names := make([]string, 0, len(reader.File))
	for _, file := range reader.File {
		name := stripPrefix(file.Name, prefix)
		if shouldSkipArchiveEntry(name) {
			continue
		}
		names = append(names, name)
		entries = append(entries, file)
	}

	report := &ImportReport{Skipped: []string{}}
	var total int64
	candidateMain := ""
	importedMain := false
	for index, file := range entries {
		name := names[index]
		if file.FileInfo().IsDir() {
			target, resolveErr := ResolveUnder(srcDir, name)
			if resolveErr != nil {
				return nil, resolveErr
			}
			if mkErr := os.MkdirAll(target, 0o755); mkErr != nil {
				return nil, fmt.Errorf("创建目录失败: %w", mkErr)
			}
			continue
		}
		if file.Mode()&os.ModeSymlink != 0 {
			report.Skipped = append(report.Skipped, name+"（符号链接）")
			continue
		}
		// 编译副产物（.aux/.log/.bbl/.synctex.gz…）不入库：它们都能再生成，
		// 而带上一次编译的残留反而会让首次编译结果看起来莫名其妙。如实列进跳过清单。
		if byproductExtensions[strings.ToLower(filepath.Ext(name))] {
			report.Skipped = append(report.Skipped, name+"（编译副产物）")
			continue
		}
		normalized, normalizeErr := NormalizeRelative(name)
		if normalizeErr != nil {
			// 危险路径不「修好再用」，而是明确拒绝并记录（Zip Slip 的正解）。
			return nil, fmt.Errorf("%w: 压缩包内路径 %q", ErrUnsafePath, name)
		}
		if file.UncompressedSize64 > MaxImportFileBytes {
			report.Skipped = append(report.Skipped, fmt.Sprintf("%s（单文件超过 %d MB）", normalized, MaxImportFileBytes>>20))
			continue
		}
		if total+int64(file.UncompressedSize64) > MaxImportBytes {
			return nil, fmt.Errorf("%w: 解压后总量超过 %d MB", ErrTooLarge, MaxImportBytes>>20)
		}
		if ratio := compressionRatio(file); ratio > maxCompressionRatio && file.UncompressedSize64 > 4<<20 {
			report.Skipped = append(report.Skipped, fmt.Sprintf("%s（压缩比异常 %.0f）", normalized, ratio))
			continue
		}
		target, resolveErr := ResolveUnder(srcDir, normalized)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if mkErr := os.MkdirAll(filepath.Dir(target), 0o755); mkErr != nil {
			return nil, fmt.Errorf("创建目录失败: %w", mkErr)
		}
		bytes, writeErr := extractEntry(file, target)
		if writeErr != nil {
			return nil, fmt.Errorf("解压 %s 失败: %w", normalized, writeErr)
		}
		total += bytes
		if total > MaxImportBytes {
			return nil, fmt.Errorf("%w: 解压后总量超过 %d MB", ErrTooLarge, MaxImportBytes>>20)
		}
		report.Files++
		report.Bytes = total
		if normalized == project.MainFile {
			importedMain = true
		}
		if candidateMain == "" && strings.EqualFold(filepath.Ext(normalized), ".tex") && containsDocumentClass(target) {
			candidateMain = normalized
		}
	}

	// 以本次导入的文件为依据，不能让新项目预置的 main.tex 遮住真实入口。
	// 只导入图片或没有入口的片段时，继续保留当前设置。
	if !importedMain && candidateMain != "" {
		if _, updateErr := s.Update(ctx, projectID, ProjectPatch{MainFile: &candidateMain}); updateErr != nil {
			return nil, updateErr
		}
		project.MainFile = candidateMain
	}
	report.MainFile = project.MainFile
	s.Touch(ctx, projectID)
	return report, nil
}

// extractEntry 写入单个条目，返回实际写入字节数（按真实字节而非包头声明计数）。
func extractEntry(file *zip.File, target string) (int64, error) {
	source, err := file.Open()
	if err != nil {
		return 0, err
	}
	defer source.Close()
	temp, err := os.CreateTemp(filepath.Dir(target), ".readx-*.unzip")
	if err != nil {
		return 0, err
	}
	tempName := temp.Name()
	// 上限留 1 字节余量：正好等于上限时不算超，超过 1 字节立刻判定。
	written, copyErr := io.Copy(temp, io.LimitReader(source, MaxImportFileBytes+1))
	closeErr := temp.Close()
	if copyErr != nil {
		_ = os.Remove(tempName)
		return written, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tempName)
		return written, closeErr
	}
	if written > MaxImportFileBytes {
		_ = os.Remove(tempName)
		return written, fmt.Errorf("%w: 解压后超过 %d MB", ErrTooLarge, MaxImportFileBytes>>20)
	}
	if err := os.Rename(tempName, target); err != nil {
		_ = os.Remove(tempName)
		return written, err
	}
	return written, nil
}

func compressionRatio(file *zip.File) float64 {
	if file.CompressedSize64 == 0 {
		return 0
	}
	return float64(file.UncompressedSize64) / float64(file.CompressedSize64)
}

// commonRoot 找出所有条目共有的顶层目录名（Overleaf 导出的 ZIP 常套一层项目名）。
// 只有一个顶层目录时才返回它，避免把散装文件误判成「都在同一个目录下」。
func commonRoot(files []*zip.File) string {
	root := ""
	for _, file := range files {
		cleaned := strings.Trim(strings.ReplaceAll(file.Name, "\\", "/"), "/")
		if cleaned == "" || shouldSkipArchiveEntry(cleaned) {
			continue
		}
		parts := strings.Split(cleaned, "/")
		if len(parts) < 2 {
			// 顶层就有文件：没有公共目录可剥。
			return ""
		}
		if root == "" {
			root = parts[0]
			continue
		}
		if parts[0] != root {
			return ""
		}
	}
	return root
}

func stripPrefix(name, prefix string) string {
	cleaned := strings.Trim(strings.ReplaceAll(name, "\\", "/"), "/")
	if prefix == "" {
		return cleaned
	}
	return strings.TrimPrefix(cleaned, prefix+"/")
}

func shouldSkipArchiveEntry(name string) bool {
	if name == "" {
		return true
	}
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "__macosx/") || lower == "__macosx" {
		return true
	}
	base := filepath.Base(lower)
	if base == ".ds_store" || base == "thumbs.db" || strings.HasPrefix(base, ".readx-") {
		return true
	}
	return false
}

// containsDocumentClass 用来挑根文档：带 \documentclass 的 .tex 才可能是入口。
func containsDocumentClass(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.Size() > 1<<20 {
		return false
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(content), `\documentclass`)
}

// byproductExtensions 是编译副产物：导出源码时必须排除，否则用户的 ZIP 里全是垃圾。
var byproductExtensions = map[string]bool{
	".aux": true, ".log": true, ".out": true, ".toc": true, ".bbl": true, ".blg": true,
	".synctex": true, ".gz": true, ".fls": true, ".fdb_latexmk": true, ".nav": true,
	".snm": true, ".vrb": true, ".idx": true, ".ilg": true, ".ind": true, ".bcf": true,
	".run": true, ".xdv": true, ".dvi": true, ".upa": true, ".upb": true, ".spl": true,
	".loa": true, ".lof": true, ".lot": true, ".brf": true, ".acn": true, ".acr": true,
	".alg": true, ".glg": true, ".glo": true, ".gls": true, ".ist": true, ".pyg": true,
}

// WriteExportZip 打包源码：排除副产物与临时文件，保留图片与 .bib。
func (s *Service) WriteExportZip(ctx context.Context, projectID string, w io.Writer) (int, error) {
	if _, err := s.Get(ctx, projectID); err != nil {
		return 0, err
	}
	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return 0, err
	}
	archive := zip.NewWriter(w)
	count := 0
	var walk func(dir, prefix string) error
	walk = func(dir, prefix string) error {
		entries, readErr := os.ReadDir(dir)
		if readErr != nil {
			if errors.Is(readErr, fs.ErrNotExist) {
				return nil
			}
			return readErr
		}
		sort.SliceStable(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			full := filepath.Join(dir, entry.Name())
			info, infoErr := os.Lstat(full)
			if infoErr != nil || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			relative := entry.Name()
			if prefix != "" {
				relative = prefix + "/" + entry.Name()
			}
			if info.IsDir() {
				// 空目录也要写进压缩包：模板里的 figures/ 可能还没放图，
				// 解压方（或用户）不该因为「导出再导入」就丢掉目录结构。
				if header, createErr := zip.FileInfoHeader(info); createErr == nil {
					header.Name = relative + "/"
					header.Method = zip.Store
					if _, createErr := archive.CreateHeader(header); createErr != nil {
						return createErr
					}
				}
				if err := walk(full, relative); err != nil {
					return err
				}
				continue
			}
			name := strings.ToLower(entry.Name())
			if strings.HasPrefix(name, ".readx-") {
				continue
			}
			if byproductExtensions[strings.ToLower(filepath.Ext(name))] {
				continue
			}
			header, createErr := zip.FileInfoHeader(info)
			if createErr != nil {
				return createErr
			}
			header.Name = relative
			header.Method = zip.Deflate
			writer, createErr := archive.CreateHeader(header)
			if createErr != nil {
				return createErr
			}
			source, openErr := os.Open(full)
			if openErr != nil {
				return openErr
			}
			if _, copyErr := io.Copy(writer, source); copyErr != nil {
				source.Close()
				return copyErr
			}
			source.Close()
			count++
		}
		return nil
	}
	if err := walk(srcDir, ""); err != nil {
		_ = archive.Close()
		return count, err
	}
	if err := archive.Close(); err != nil {
		return count, err
	}
	return count, nil
}
