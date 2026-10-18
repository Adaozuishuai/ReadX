// Package importer 把旧版 windows/ 的 JSON 数据一次性导入 SQLite。
//
// 三条硬约束（来自 v2-迁移计划.md）：
//  1. 只读旧文件，绝不写回——两版同时改一份数据必然互相覆盖；
//  2. 导入前先备份，备份失败就不动数据库（用户研究数据不可再生）；
//  3. 幂等：重复导入不得产生重复行，也不得冲掉用户在 v2 里改过的状态。
package importer

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/safekey"
)

type Options struct {
	Paths legacy.Paths
	// ForceBackup 为 false 时，只在数据库还没有任何文档（首次导入）时备份。
	ForceBackup bool
	Now         func() time.Time
}

type Report struct {
	DocumentsAdded     int      `json:"documentsAdded"`
	DocumentsUpdated   int      `json:"documentsUpdated"`
	DocumentsUnchanged int      `json:"documentsUnchanged"`
	PagesImported      int      `json:"pagesImported"`
	PagesUnchanged     int      `json:"pagesUnchanged"`
	TextCaches         int      `json:"textCaches"`
	ReadingsImported   int      `json:"readingsImported"`
	BackupDir          string   `json:"backupDir,omitempty"`
	Warnings           []string `json:"warnings"`
	StartedAt          string   `json:"startedAt"`
	FinishedAt         string   `json:"finishedAt"`
}

func (r *Report) warn(format string, args ...any) {
	r.Warnings = append(r.Warnings, fmt.Sprintf(format, args...))
}

// Run 执行导入。出错时返回的 Report 可能已部分填充，仅供日志排查——数据库不会留下半截改动。
func Run(ctx context.Context, db *sql.DB, opts Options) (Report, error) {
	now := opts.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	report := Report{Warnings: []string{}, StartedAt: now().Format(time.RFC3339)}

	entries, err := legacy.ReadQueue(opts.Paths.QueueFile())
	if err != nil {
		return report, err
	}
	cleaned := dedupe(entries, &report)

	states, err := readJSONObject(opts.Paths.LibraryStateFile())
	if err != nil {
		return report, err
	}
	progress, err := readJSONObject(opts.Paths.ProgressFile())
	if err != nil {
		return report, err
	}
	overrides, err := loadStatusOverrides(ctx, db)
	if err != nil {
		return report, err
	}
	existing, err := loadExisting(ctx, db)
	if err != nil {
		return report, err
	}

	// 首次导入（或显式要求）必须先备份成功，才允许写库。
	if opts.ForceBackup || len(existing) == 0 {
		dir, err := backup(opts.Paths, now)
		if err != nil {
			return report, fmt.Errorf("备份失败，未导入任何数据: %w", err)
		}
		report.BackupDir = dir
	}

	// 两阶段：先把旧文件全部读进内存、算好每篇要写的行，再开短事务只做写入。
	// 事务里做文件 I/O 会把唯一连接占住（db.Open 里 SetMaxOpenConns(1)），
	// 导入期间所有 DB 请求——包括免鉴权的 /healthz——都会排队等连接。
	pdfIndex := opts.Paths.LibraryPDFIndex()
	prepared := make([]preparedDocument, 0, len(cleaned))
	for _, entry := range cleaned {
		row, err := prepareDocument(opts.Paths, pdfIndex, entry, overrides, states, progress, existing)
		if err != nil {
			return report, err
		}
		prepared = append(prepared, row)
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return report, fmt.Errorf("开启导入事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stamp := now().Format(time.RFC3339)
	for _, row := range prepared {
		if row.existed && row.previous.sameMetadata(row.entry, row.authors, row.year, row.pdfPath, row.raw, row.status) {
			report.DocumentsUnchanged++
		} else {
			if err := upsertDocument(ctx, tx, row.key, row.entry, row.authors, row.year, row.pdfPath, row.raw, row.status, stamp, row.existed); err != nil {
				return report, err
			}
			if row.existed {
				report.DocumentsUpdated++
			} else {
				report.DocumentsAdded++
			}
		}

		imported, unchanged, err := importTextCache(ctx, tx, row.key, row.pages, row.hasText, stamp, &report)
		if err != nil {
			return report, err
		}
		report.PagesImported += imported
		report.PagesUnchanged += unchanged
		if row.hasText {
			report.TextCaches++
		}
		done, err := importReading(ctx, tx, row.key, row.reading, row.hasReading, stamp)
		if err != nil {
			return report, err
		}
		if done {
			report.ReadingsImported++
		}
	}

	if err := rememberState(ctx, tx, "legacy.library", states, stamp); err != nil {
		return report, err
	}
	if err := rememberState(ctx, tx, "legacy.progress", progress, stamp); err != nil {
		return report, err
	}
	report.FinishedAt = now().Format(time.RFC3339)
	if err := rememberState(ctx, tx, "import.lastRun", report, report.FinishedAt); err != nil {
		return report, err
	}
	if err := tx.Commit(); err != nil {
		return report, fmt.Errorf("提交导入事务失败: %w", err)
	}
	return report, nil
}

// dedupe 丢掉无法作为键的条目并合并重复键：重复时保留第一条，其余记警告。
func dedupe(entries []legacy.Entry, report *Report) []legacy.Entry {
	seen := map[string]int{}
	out := make([]legacy.Entry, 0, len(entries))
	for index, entry := range entries {
		key := entry.Key()
		if key == "" {
			report.warn("第 %d 条队列项既没有 arxiv 也没有 id，已跳过（无法定位它的正文与阅读记录）", index+1)
			continue
		}
		if err := safekey.Check(key); err != nil {
			report.warn("第 %d 条队列项的键 %q 不安全，已跳过：%v", index+1, key, err)
			continue
		}
		if first, duplicate := seen[key]; duplicate {
			report.warn("键 %q 重复（第 %d 条与第 %d 条），只保留前者", key, first+1, index+1)
			continue
		}
		seen[key] = index
		out = append(out, entry)
	}
	return out
}

type documentRow struct {
	title   string
	authors string
	year    any
	venue   string
	doi     string
	url     string
	pdfPath string
	raw     string
	status  string
}

// preparedDocument 是「第二阶段只写库」所需的全部输入：文件读取、JSON 解析、
// 状态推导都已在 prepareDocument 里完成，事务内不再触碰文件系统。
type preparedDocument struct {
	entry      legacy.Entry
	key        string
	status     string
	pdfPath    string
	authors    string
	raw        string
	year       any
	previous   documentRow
	existed    bool
	pages      []legacy.Page
	hasText    bool
	reading    string
	hasReading bool
}

// prepareDocument 在事务外读齐一篇论文的旧数据并算好要写的值。
func prepareDocument(paths legacy.Paths, pdfIndex legacy.LibraryPDFIndex, entry legacy.Entry,
	overrides, states, progress map[string]any, existing map[string]documentRow) (preparedDocument, error) {

	row := preparedDocument{entry: entry, key: entry.Key()}
	reading, hasReading, err := readReadingFile(row.key, paths.ReadingFile(row.key))
	if err != nil {
		return row, err
	}
	row.reading, row.hasReading = reading, hasReading
	row.status = deriveStatus(row.key, overrides, states, progress, hasReading)
	if found, ok := pdfIndex.Match(row.key); ok {
		row.pdfPath = found
	}
	authors, err := json.Marshal(entry.Authors)
	if err != nil {
		return row, fmt.Errorf("序列化 %s 的作者失败: %w", row.key, err)
	}
	row.authors = string(authors)
	raw, err := json.Marshal(entry.Raw())
	if err != nil {
		return row, fmt.Errorf("序列化 %s 的原始条目失败: %w", row.key, err)
	}
	row.raw = string(raw)
	if year := entry.ResolvedYear(); year > 0 {
		row.year = year
	}
	row.previous, row.existed = existing[row.key]
	pages, hasText, err := legacy.ReadTextCache(paths.TextCacheFile(row.key))
	if err != nil {
		return row, err
	}
	row.pages, row.hasText = pages, hasText
	return row, nil
}

// readReadingFile 读旧版精读 JSON。不存在返回 ("", false, nil)；损坏必须报错，
// 不能当作没有记录，否则导入会把用户数据「读没」。
func readReadingFile(key, path string) (string, bool, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取 %s 的精读记录失败: %w", key, err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return "", false, fmt.Errorf("%s 的精读记录不是合法 JSON，导入中止（旧文件仍在，请人工处理）: %w", key, err)
	}
	return string(body), true, nil
}

func (d documentRow) sameMetadata(e legacy.Entry, authors string, year any, pdfPath, raw, status string) bool {
	return d.title == e.Title && d.authors == authors && equalYear(d.year, year) &&
		d.venue == e.Venue && d.doi == e.DOI && d.url == EntryURL(e) &&
		d.pdfPath == pdfPath && d.raw == raw && d.status == status
}

func equalYear(a, b any) bool {
	an, aok := normalizeYear(a)
	bn, bok := normalizeYear(b)
	return aok == bok && an == bn
}

func normalizeYear(value any) (int64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, false
	case int:
		return int64(typed), typed != 0
	case int64:
		return typed, typed != 0
	case float64:
		return int64(typed), typed != 0
	default:
		return 0, false
	}
}

func EntryURL(e legacy.Entry) string {
	if e.URL != "" {
		return e.URL
	}
	return e.PDFURL
}

func validStatus(value string) bool {
	switch value {
	case "queue", "reading", "done", "archive":
		return true
	}
	return false
}

// deriveStatus 优先级：用户在 v2 手动改的状态 > 有精读产物 > 旧库标记已读 > 有进度 > 待读。
func deriveStatus(key string, overrides, states, progress map[string]any, hasReading bool) string {
	if value, ok := overrides[key].(string); ok && validStatus(value) {
		return value
	}
	if hasReading {
		return "done"
	}
	if state, ok := states[key].(map[string]any); ok {
		if value, _ := state["status"].(string); value == "read" {
			return "done"
		}
	}
	if value, ok := progress[key].(map[string]any); ok {
		if step, _ := value["step"].(float64); step >= 1 {
			return "reading"
		}
	}
	return "queue"
}

// loadStatusOverrides 读 app_state('documents.status')：{key: status}。
// 用户在 v2 里改的状态存在这里，重跑导入不会覆盖它。
func loadStatusOverrides(ctx context.Context, db *sql.DB) (map[string]any, error) {
	var body sql.NullString
	err := db.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = 'documents.status'`).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !body.Valid) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取文档状态覆盖失败: %w", err)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(body.String), &out); err != nil {
		return nil, fmt.Errorf("文档状态覆盖已损坏（app_state.documents.status 不是 JSON 对象）: %w", err)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

func loadExisting(ctx context.Context, db *sql.DB) (map[string]documentRow, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, title, authors, year, venue, doi, url, pdf_path, raw_json, status FROM documents`)
	if err != nil {
		return nil, fmt.Errorf("读取已有文档失败: %w", err)
	}
	defer rows.Close()

	out := map[string]documentRow{}
	for rows.Next() {
		var item documentRow
		var id string
		var year sql.NullInt64
		if err := rows.Scan(&id, &item.title, &item.authors, &year, &item.venue, &item.doi,
			&item.url, &item.pdfPath, &item.raw, &item.status); err != nil {
			return nil, fmt.Errorf("解析已有文档失败: %w", err)
		}
		if year.Valid {
			item.year = year.Int64
		}
		out[id] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func upsertDocument(ctx context.Context, tx *sql.Tx, key string, entry legacy.Entry,
	authors string, year any, pdfPath, raw, status, stamp string, existed bool) error {

	if existed {
		// 只更新元数据与「推断状态」；用户手动改过的状态由 overrides 决定，不在此覆盖。
		_, err := tx.ExecContext(ctx,
			`UPDATE documents
			    SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, url = ?,
			        pdf_path = ?, raw_json = ?, status = ?, updated_at = ?
			  WHERE id = ?`,
			entry.Title, authors, year, entry.Venue, entry.DOI, EntryURL(entry),
			pdfPath, raw, status, stamp, key)
		if err != nil {
			return fmt.Errorf("更新文档 %s 失败: %w", key, err)
		}
		return nil
	}
	_, err := tx.ExecContext(ctx,
		`INSERT INTO documents(id, key, title, authors, year, venue, doi, url, status, pdf_path, added_at, updated_at, raw_json)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		key, key, entry.Title, authors, year, entry.Venue, entry.DOI, EntryURL(entry),
		status, pdfPath, stamp, stamp, raw)
	if err != nil {
		return fmt.Errorf("插入文档 %s 失败: %w", key, err)
	}
	return nil
}

// importTextCache 把旧版逐页缓存搬进 document_pages，按内容哈希跳过未变化的页。
// pages 由 prepareDocument 在事务外读入，这里只做 DB 读写。
func importTextCache(ctx context.Context, tx *sql.Tx, key string, pages []legacy.Page, cacheFound bool, stamp string, report *Report) (imported, unchanged int, err error) {
	if !cacheFound {
		return 0, 0, nil
	}
	if legacy.IsOCRText(pages) {
		report.warn("%s 的全文来自 OCR 识别，摘录校验可能失效，需人工核对", key)
	}
	for _, page := range pages {
		hash := legacy.PageHash(page.Text)
		var stored string
		query := tx.QueryRowContext(ctx, `SELECT hash FROM document_pages WHERE document_id = ? AND page = ?`, key, page.Number)
		switch scanErr := query.Scan(&stored); {
		case errors.Is(scanErr, sql.ErrNoRows):
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO document_pages(document_id, page, text, hash, updated_at) VALUES(?,?,?,?,?)`,
				key, page.Number, page.Text, hash, stamp); err != nil {
				return imported, unchanged, fmt.Errorf("写入 %s 第 %d 页失败: %w", key, page.Number, err)
			}
			imported++
		case scanErr != nil:
			return imported, unchanged, fmt.Errorf("查询 %s 第 %d 页失败: %w", key, page.Number, scanErr)
		case stored == hash:
			unchanged++
		default:
			if _, err := tx.ExecContext(ctx,
				`UPDATE document_pages SET text = ?, hash = ?, updated_at = ? WHERE document_id = ? AND page = ?`,
				page.Text, hash, stamp, key, page.Number); err != nil {
				return imported, unchanged, fmt.Errorf("更新 %s 第 %d 页失败: %w", key, page.Number, err)
			}
			imported++
		}
	}
	return imported, unchanged, nil
}

// importReading 原样搬运 app/data/readings/<key>.json（内容已在事务外读过）。
// 校验在 S2 移植完成后加到写入路径上；导入阶段不因旧数据不合新规则而丢数据。
func importReading(ctx context.Context, tx *sql.Tx, key, body string, found bool, stamp string) (bool, error) {
	if !found {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO readings(document_id, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(document_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, body, stamp); err != nil {
		return false, fmt.Errorf("写入 %s 的精读记录失败: %w", key, err)
	}
	return true, nil
}

func rememberState(ctx context.Context, tx *sql.Tx, key string, value any, stamp string) error {
	body, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("序列化 %s 失败: %w", key, err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(body), stamp); err != nil {
		return fmt.Errorf("写入 %s 失败: %w", key, err)
	}
	return nil
}

func readJSONObject(path string) (map[string]any, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, fmt.Errorf("读取 %s 失败: %w", filepath.Base(path), err)
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		// 旧状态文件损坏时宁可整体失败：静默当作空对象会让导入把用户数据「读没」。
		return nil, fmt.Errorf("%s 不是合法 JSON 对象，导入中止: %w", filepath.Base(path), err)
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// backup 复制旧数据到 app/data/v2/backups/<UTC 时间戳>/。只复制，不移动、不删除源文件。
func backup(paths legacy.Paths, now func() time.Time) (string, error) {
	dir := filepath.Join(paths.V2Dir(), "backups", now().Format("20060102T150405Z"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建备份目录失败: %w", err)
	}
	copied := 0
	if exists(paths.QueueFile()) {
		if err := copyFile(paths.QueueFile(), filepath.Join(dir, "queue.json")); err != nil {
			return "", err
		}
		copied++
	}
	for _, name := range []string{"library.json", "progress.json", "profile.json", "discovery.json"} {
		source := filepath.Join(paths.DataDir(), name)
		if !exists(source) {
			continue
		}
		if err := copyFile(source, filepath.Join(dir, name)); err != nil {
			return "", err
		}
		copied++
	}
	if entries, err := os.ReadDir(paths.ReadingsDir()); err == nil {
		target := filepath.Join(dir, "readings")
		if err := os.MkdirAll(target, 0o755); err != nil {
			return "", err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			if err := copyFile(filepath.Join(paths.ReadingsDir(), entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return "", err
			}
			copied++
		}
	}
	if copied == 0 {
		_ = os.RemoveAll(dir)
		return "", nil
	}
	return dir, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func copyFile(source, target string) error {
	body, err := os.ReadFile(source)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("读取 %s 失败: %w", filepath.Base(source), err)
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		return fmt.Errorf("写入备份 %s 失败: %w", filepath.Base(target), err)
	}
	return nil
}
