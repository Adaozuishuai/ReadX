package latex

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Engine 是允许的编译引擎。只认这几个：不把任意命令交给用户输入（规格 §8.2）。
type Engine string

const (
	EnginePDFLaTeX Engine = "pdflatex"
	EngineXeLaTeX  Engine = "xelatex"
	EngineLuaLaTeX Engine = "lualatex"
)

func ValidEngine(value string) bool {
	switch Engine(value) {
	case EnginePDFLaTeX, EngineXeLaTeX, EngineLuaLaTeX:
		return true
	}
	return false
}

// BuildStatus 是编译任务的状态机。
type BuildStatus string

const (
	BuildQueued    BuildStatus = "queued"
	BuildRunning   BuildStatus = "running"
	BuildSucceeded BuildStatus = "succeeded"
	BuildFailed    BuildStatus = "failed"
	BuildCancelled BuildStatus = "cancelled"
)

type Project struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	MainFile    string `json:"mainFile"`
	Engine      string `json:"engine"`
	AutoCompile bool   `json:"autoCompile"`
	// AIAutoFix 是「AI 直接改文件」的总开关，默认关闭：开启后 AI 才能写入项目源码。
	AIAutoFix          bool   `json:"aiAutoFix"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
	LastBuildID        string `json:"lastBuildId"`
	LastSuccessBuildID string `json:"lastSuccessBuildId"`
}

// Service 是 LaTeX Studio 的业务入口：项目生命周期 + 文件读写。
// 它只依赖注入进来的 *sql.DB 与数据根，便于在测试里用临时目录。
type Service struct {
	db   *sql.DB
	root string
}

func NewService(db *sql.DB, dataRoot string) *Service {
	return &Service{db: db, root: filepath.Join(dataRoot, "latex-projects")}
}

// Root 返回项目总目录（测试与排障用）。
func (s *Service) Root() string { return s.root }

// ProjectDir 返回单个项目的目录。ID 由服务端生成（UUID），这里再挡一次分隔符。
func (s *Service) ProjectDir(id string) (string, error) {
	if id == "" || strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return "", fmt.Errorf("%w: 项目编号非法", ErrUnsafePath)
	}
	return filepath.Join(s.root, id), nil
}

// SrcDir 是源码根：所有文件 API 的相对路径都相对它解析。
func (s *Service) SrcDir(id string) (string, error) {
	dir, err := s.ProjectDir(id)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "src"), nil
}

// BuildDir 返回某次构建的产物目录。
func (s *Service) BuildDir(projectID, buildID string) (string, error) {
	dir, err := s.ProjectDir(projectID)
	if err != nil {
		return "", err
	}
	if buildID == "" || strings.ContainsAny(buildID, `/\`) || buildID == "." || buildID == ".." {
		return "", fmt.Errorf("%w: 构建编号非法", ErrUnsafePath)
	}
	return filepath.Join(dir, "build", buildID), nil
}

func newID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	// RFC 4122 v4：固定版本位与变体位，避免看起来像其它 UUID 变体。
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(buffer)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexed[0:8], hexed[8:12], hexed[12:16], hexed[16:20], hexed[20:32]), nil
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339) }

// StarterMainTeX 是新项目的模板：必须能独立编译出 PDF（M1 验收第一条）。
const StarterMainTeX = `\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Untitled Paper}
\author{}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Write the abstract here.
\end{abstract}

\section{Introduction}
Start writing. Every paragraph is a real file on disk, so it can be edited
with any LaTeX tool and exported as a ZIP at any time.

\section{Method}
Equations work out of the box:
\begin{equation}
  \mathcal{L}(\theta) = \sum_{i=1}^{N} \left\lVert f_\theta(x_i) - y_i \right\rVert^2 .
\end{equation}

\section{Conclusion}
Summarize the contribution.

\end{document}
`

const starterBibTeX = `@article{example2026,
  title   = {An Example Reference},
  author  = {Example, Ada},
  journal = {Journal of Examples},
  year    = {2026},
  volume  = {1},
  pages   = {1--10}
}
`

const starterSections = `% 章节可以拆到单独文件里，用 \input{sections/method} 引入。
\section{Method}
`

// Create 建项目：先落磁盘骨架，再写 SQLite 索引。
//
// 顺序是刻意的——磁盘成功而索引失败只会产生一个「孤儿目录」（可被清理），
// 反过来会产生一个「指着不存在目录的项目」，那才是用户可见的坏状态。
func (s *Service) Create(ctx context.Context, title string, engine Engine, mainFile string) (*Project, error) {
	if !ValidEngine(string(engine)) {
		engine = EnginePDFLaTeX
	}
	cleanTitle := strings.TrimSpace(title)
	if cleanTitle == "" {
		cleanTitle = "未命名项目"
	}
	if len([]rune(cleanTitle)) > 120 {
		cleanTitle = string([]rune(cleanTitle)[:120])
	}
	if strings.TrimSpace(mainFile) == "" {
		mainFile = "main.tex"
	}
	normalizedMain, err := NormalizeRelative(mainFile)
	if err != nil {
		return nil, err
	}
	if FileKind(normalizedMain) != "tex" {
		return nil, fmt.Errorf("%w: 根文档必须是 .tex 文件", ErrUnsafePath)
	}

	id, err := newID()
	if err != nil {
		return nil, err
	}
	projectDir, err := s.ProjectDir(id)
	if err != nil {
		return nil, err
	}
	srcDir := filepath.Join(projectDir, "src")
	for _, dir := range []string{
		srcDir,
		filepath.Join(srcDir, "sections"),
		filepath.Join(srcDir, "figures"),
		filepath.Join(projectDir, "build"),
		filepath.Join(projectDir, "snapshots"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("创建项目目录失败: %w", err)
		}
	}
	seed := map[string]string{
		normalizedMain:        StarterMainTeX,
		"references.bib":      starterBibTeX,
		"sections/method.tex": starterSections,
	}
	for relative, content := range seed {
		target, resolveErr := ResolveUnder(srcDir, relative)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
			return nil, fmt.Errorf("写入项目模板失败: %w", err)
		}
	}

	stamp := nowStamp()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO latex_projects(id,title,main_file,engine,auto_compile,created_at,updated_at)
		 VALUES(?,?,?,?,0,?,?)`,
		id, cleanTitle, normalizedMain, string(engine), stamp, stamp); err != nil {
		_ = os.RemoveAll(projectDir)
		return nil, fmt.Errorf("写入项目索引失败: %w", err)
	}
	return s.Get(ctx, id)
}

func (s *Service) List(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id,title,main_file,engine,auto_compile,ai_auto_fix,created_at,updated_at,last_build_id,last_success_build_id
		 FROM latex_projects ORDER BY updated_at DESC, title COLLATE NOCASE`)
	if err != nil {
		return nil, fmt.Errorf("读取项目列表失败: %w", err)
	}
	defer rows.Close()
	out := []Project{}
	for rows.Next() {
		project, scanErr := scanProject(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, project)
	}
	return out, rows.Err()
}

func (s *Service) Get(ctx context.Context, id string) (*Project, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id,title,main_file,engine,auto_compile,ai_auto_fix,created_at,updated_at,last_build_id,last_success_build_id
		 FROM latex_projects WHERE id = ?`, id)
	project, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &project, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanProject(row rowScanner) (Project, error) {
	var project Project
	var autoCompile, aiAutoFix int
	if err := row.Scan(&project.ID, &project.Title, &project.MainFile, &project.Engine, &autoCompile, &aiAutoFix,
		&project.CreatedAt, &project.UpdatedAt, &project.LastBuildID, &project.LastSuccessBuildID); err != nil {
		return Project{}, err
	}
	project.AutoCompile = autoCompile != 0
	project.AIAutoFix = aiAutoFix != 0
	return project, nil
}

// ProjectPatch 是局部更新：只改传进来的字段（指针区分「没传」与「传了零值」）。
type ProjectPatch struct {
	Title       *string
	MainFile    *string
	Engine      *string
	AutoCompile *bool
	// AIAutoFix 只有显式传 true/false 才会改变；不传就保持原值。
	AIAutoFix *bool
}

func (s *Service) Update(ctx context.Context, id string, patch ProjectPatch) (*Project, error) {
	current, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	title, mainFile, engine, autoCompile := current.Title, current.MainFile, current.Engine, current.AutoCompile
	aiAutoFix := current.AIAutoFix
	if patch.Title != nil {
		trimmed := strings.TrimSpace(*patch.Title)
		if trimmed == "" {
			return nil, errors.New("项目名不能为空")
		}
		if len([]rune(trimmed)) > 120 {
			trimmed = string([]rune(trimmed)[:120])
		}
		title = trimmed
	}
	if patch.MainFile != nil {
		normalized, normalizeErr := NormalizeRelative(*patch.MainFile)
		if normalizeErr != nil {
			return nil, normalizeErr
		}
		if FileKind(normalized) != "tex" {
			return nil, errors.New("根文档必须是 .tex 文件")
		}
		// 根文档必须真实存在：否则编译只会给出一个难以理解的引擎报错。
		srcDir, dirErr := s.SrcDir(id)
		if dirErr != nil {
			return nil, dirErr
		}
		target, resolveErr := ResolveUnder(srcDir, normalized)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if _, statErr := os.Stat(target); statErr != nil {
			return nil, fmt.Errorf("根文档不存在: %s", normalized)
		}
		mainFile = normalized
	}
	if patch.Engine != nil {
		if !ValidEngine(*patch.Engine) {
			return nil, errors.New("编译引擎只能是 pdflatex / xelatex / lualatex")
		}
		engine = *patch.Engine
	}
	if patch.AutoCompile != nil {
		autoCompile = *patch.AutoCompile
	}
	if patch.AIAutoFix != nil {
		aiAutoFix = *patch.AIAutoFix
	}
	flag := 0
	if autoCompile {
		flag = 1
	}
	aiFlag := 0
	if aiAutoFix {
		aiFlag = 1
	}
	if _, err := s.db.ExecContext(ctx,
		`UPDATE latex_projects SET title=?, main_file=?, engine=?, auto_compile=?, ai_auto_fix=?, updated_at=? WHERE id=?`,
		title, mainFile, engine, flag, aiFlag, nowStamp(), id); err != nil {
		return nil, fmt.Errorf("更新项目失败: %w", err)
	}
	return s.Get(ctx, id)
}

// SetLastBuild 记录最近一次构建与最近一次成功的构建。
func (s *Service) SetLastBuild(ctx context.Context, id, buildID string, success bool) error {
	if success {
		_, err := s.db.ExecContext(ctx,
			`UPDATE latex_projects SET last_build_id=?, last_success_build_id=?, updated_at=? WHERE id=?`,
			buildID, buildID, nowStamp(), id)
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE latex_projects SET last_build_id=?, updated_at=? WHERE id=?`, buildID, nowStamp(), id)
	return err
}

// Delete 删项目：先删索引（外键级联带走构建记录），再删目录。
//
// 顺序与 Create 相反：索引先没了，即使目录删除失败也只会留下一个可清理的孤儿目录，
// 不会留下「能列出但打不开」的项目。
func (s *Service) Delete(ctx context.Context, id string) error {
	projectDir, err := s.ProjectDir(id)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM latex_projects WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("删除项目失败: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	if err := os.RemoveAll(projectDir); err != nil {
		return fmt.Errorf("项目已从列表移除，但目录删除失败: %w", err)
	}
	return nil
}

// Touch 更新项目的 updated_at（保存文件等操作后调用）。
func (s *Service) Touch(ctx context.Context, id string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE latex_projects SET updated_at=? WHERE id=?`, nowStamp(), id)
}
