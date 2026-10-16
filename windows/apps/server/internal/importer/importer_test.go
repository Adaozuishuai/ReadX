package importer

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/db"
	"cbctv2/server/internal/legacy"
)

type fixture struct {
	root   string
	paths  legacy.Paths
	handle *sql.DB
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := t.TempDir()
	paths := legacy.NewPaths(root)
	for _, dir := range []string{paths.PapersDir(), paths.TextDir(), paths.ReadingsDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	handle, err := db.Open(context.Background(), filepath.Join(root, "app", "data", "v2", "reader.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	return &fixture{root: root, paths: paths, handle: handle}
}

func (f *fixture) write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) standardData(t *testing.T) {
	t.Helper()
	f.write(t, f.paths.QueueFile(), `{"papers":[
		{"arxiv":"https://arxiv.org/abs/2209.14540v1","title":"NAF: Neural Attenuation Fields","authors":["Ruyi Zha","Yanhao Zhang","Hongdong Li"],"venue":"ECCV 2022","year":"2022","pdfUrl":"https://arxiv.org/pdf/2209.14540"},
		{"id":"intratomo-2021","title":"IntraTomo","authors":["Guangming Zang"],"venue":"ICCV 2021","year":"2021"},
		{"title":"没有键的条目"}
	]}`)
	f.write(t, f.paths.TextCacheFile("2209.14540"), "=== Page 1 ===\nNAF abstract.\n=== Page 2 ===\nWe train using 50 views.\n")
	f.write(t, f.paths.ReadingFile("2209.14540"), `{"key":"2209.14540","step4":{"v":"done"}}`)
	f.write(t, f.paths.LibraryStateFile(), `{"intratomo-2021":{"status":"unread","favorite":true}}`)
	f.write(t, f.paths.ProgressFile(), `{"intratomo-2021":{"step":2,"startedAt":"2026-10-12T13:21:19.684Z"}}`)
	f.write(t, filepath.Join(f.paths.LibraryDir(), "2209.14540.pdf"), "%PDF-1.4 fake")
}

func run(t *testing.T, f *fixture, force bool) Report {
	t.Helper()
	report, err := Run(context.Background(), f.handle, Options{Paths: f.paths, ForceBackup: force, Now: fixedClock})
	if err != nil {
		t.Fatalf("导入失败: %v", err)
	}
	return report
}

func fixedClock() time.Time { return time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC) }

func queryRows(t *testing.T, f *fixture, query string, args ...any) [][]any {
	t.Helper()
	rows, err := f.handle.Query(query, args...)
	if err != nil {
		t.Fatalf("%s 查询失败: %v", query, err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var out [][]any
	for rows.Next() {
		cells := make([]any, len(columns))
		targets := make([]any, len(columns))
		for i := range cells {
			targets[i] = &cells[i]
		}
		if err := rows.Scan(targets...); err != nil {
			t.Fatal(err)
		}
		out = append(out, cells)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFirstImportBuildsLibraryFromLegacyFiles(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	report := run(t, f, false)

	if report.DocumentsAdded != 2 {
		t.Fatalf("应导入 2 篇（无键条目跳过），实际 %d", report.DocumentsAdded)
	}
	if report.DocumentsUnchanged != 0 || report.DocumentsUpdated != 0 {
		t.Fatalf("首次导入不应有 unchanged/updated，实际 %+v", report)
	}
	if report.TextCaches != 1 || report.PagesImported != 2 {
		t.Fatalf("应导入 1 份逐页缓存共 2 页，实际 %+v", report)
	}
	if report.ReadingsImported != 1 {
		t.Fatalf("应导入 1 条精读记录，实际 %d", report.ReadingsImported)
	}
	if len(report.Warnings) != 1 || !strings.Contains(report.Warnings[0], "没有 arxiv") {
		t.Fatalf("应只对无键条目告警，实际 %v", report.Warnings)
	}
	if report.BackupDir == "" {
		t.Fatal("首次导入必须备份")
	}
	if _, err := os.Stat(filepath.Join(report.BackupDir, "queue.json")); err != nil {
		t.Fatalf("备份里必须有 queue.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(report.BackupDir, "readings", "2209.14540.json")); err != nil {
		t.Fatalf("备份里必须有 readings: %v", err)
	}

	documents := queryRows(t, f, `SELECT id, title, status, year, pdf_path FROM documents ORDER BY id`)
	if len(documents) != 2 {
		t.Fatalf("documents 应有 2 行，实际 %d", len(documents))
	}
	// arxiv 键必须去掉前缀与版本号，与旧版 arxivKey 一致。
	if documents[0][0] != "2209.14540" {
		t.Fatalf("键规范化错误: %v", documents[0])
	}
	if documents[0][2] != "done" {
		t.Fatalf("有精读记录应判为 done，实际 %v", documents[0][2])
	}
	if year, _ := documents[0][3].(int64); year != 2022 {
		t.Fatalf("year 应为 2022，实际 %T %v", documents[0][3], documents[0][3])
	}
	if pdf, _ := documents[0][4].(string); !strings.HasSuffix(pdf, "2209.14540.pdf") {
		t.Fatalf("应关联本地 PDF，实际 %q", pdf)
	}
	if documents[1][0] != "intratomo-2021" || documents[1][2] != "reading" {
		t.Fatalf("有进度应判为 reading，实际 %v", documents[1])
	}
	pages := queryRows(t, f, `SELECT page, hash FROM document_pages WHERE document_id='2209.14540' ORDER BY page`)
	if len(pages) != 2 || pages[0][0] != int64(1) || pages[1][0] != int64(2) {
		t.Fatalf("页码应完整导入: %v", pages)
	}
}

func TestImportIsIdempotent(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	run(t, f, false)

	second := run(t, f, false)
	if second.DocumentsAdded != 0 || second.DocumentsUpdated != 0 || second.DocumentsUnchanged != 2 {
		t.Fatalf("重复导入应全部 unchanged，实际 %+v", second)
	}
	if second.PagesImported != 0 || second.PagesUnchanged != 2 {
		t.Fatalf("重复导入页内容未变，不应重写，实际 %+v", second)
	}
	if second.BackupDir != "" {
		t.Fatalf("库里已有数据时不应再自动备份，实际 %q", second.BackupDir)
	}
	if rows := queryRows(t, f, `SELECT COUNT(*) FROM documents`); rows[0][0] != int64(2) {
		t.Fatalf("重复导入不得产生重复行: %v", rows[0][0])
	}
	if rows := queryRows(t, f, `SELECT COUNT(*) FROM document_pages`); rows[0][0] != int64(2) {
		t.Fatalf("重复导入不得产生重复页: %v", rows[0][0])
	}
}

func TestMetadataChangeUpdatesButKeepsUserStatus(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	run(t, f, false)

	if _, err := f.handle.Exec(
		`INSERT INTO app_state(key, value_json, updated_at) VALUES('documents.status', '{"2209.14540":"archive"}', 'now')`); err != nil {
		t.Fatal(err)
	}
	f.write(t, f.paths.QueueFile(), `{"papers":[{"arxiv":"2209.14540","title":"NAF 改过标题","authors":["Ruyi Zha"]}]}`)
	third := run(t, f, false)
	if third.DocumentsUpdated != 1 {
		t.Fatalf("标题变化应触发更新，实际 %+v", third)
	}
	var status, title string
	if err := f.handle.QueryRow(`SELECT status, title FROM documents WHERE id='2209.14540'`).Scan(&status, &title); err != nil {
		t.Fatal(err)
	}
	if status != "archive" {
		t.Fatalf("用户在 v2 改的状态不得被导入冲掉，实际 %q", status)
	}
	if title != "NAF 改过标题" {
		t.Fatalf("元数据应更新，实际 %q", title)
	}
}

func TestUnsafeAndDuplicateKeysAreSkipped(t *testing.T) {
	f := newFixture(t)
	f.write(t, f.paths.QueueFile(), `{"papers":[
		{"arxiv":"../../app/config","title":"穿越键"},
		{"arxiv":"2209.14540","title":"甲"},
		{"id":"2209.14540","title":"乙"}
	]}`)
	report := run(t, f, false)
	if report.DocumentsAdded != 1 {
		t.Fatalf("只应导入 1 篇，实际 %+v", report)
	}
	joined := strings.Join(report.Warnings, "；")
	if !strings.Contains(joined, "不安全") || !strings.Contains(joined, "重复") {
		t.Fatalf("应同时告警穿越键与重复键，实际 %v", report.Warnings)
	}
	if rows := queryRows(t, f, `SELECT id FROM documents`); len(rows) != 1 || rows[0][0] != "2209.14540" {
		t.Fatalf("重复键应保留第一条: %v", rows)
	}
}

func TestCorruptQueueLeavesDatabaseUntouched(t *testing.T) {
	f := newFixture(t)
	f.write(t, f.paths.QueueFile(), `{"papers":[`)
	if _, err := Run(context.Background(), f.handle, Options{Paths: f.paths, Now: fixedClock}); err == nil {
		t.Fatal("损坏的 queue.json 必须报错")
	}
	if rows := queryRows(t, f, `SELECT COUNT(*) FROM documents`); rows[0][0] != int64(0) {
		t.Fatal("报错前不得写入任何文档")
	}
}

func TestCorruptReadingAbortsWholeImport(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	f.write(t, f.paths.ReadingFile("2209.14540"), `{oops`)
	if _, err := Run(context.Background(), f.handle, Options{Paths: f.paths, Now: fixedClock}); err == nil {
		t.Fatal("损坏的精读记录必须让导入失败")
	}
	if rows := queryRows(t, f, `SELECT COUNT(*) FROM documents`); rows[0][0] != int64(0) {
		t.Fatalf("事务未提交，documents 应为空，实际 %v 行", rows[0][0])
	}
	if _, err := os.Stat(filepath.Join(f.paths.V2Dir(), "backups")); err != nil {
		t.Fatalf("备份仍应保留（它是只读副本）: %v", err)
	}
}

func TestBackupFailureBlocksWrites(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	// 把备份路径做成普通文件 → MkdirAll 必然失败。
	f.write(t, filepath.Join(f.paths.V2Dir(), "backups"), "not a directory")
	_, err := Run(context.Background(), f.handle, Options{Paths: f.paths, Now: fixedClock})
	if err == nil || !strings.Contains(err.Error(), "备份失败") {
		t.Fatalf("备份失败应中止导入，实际 %v", err)
	}
	if rows := queryRows(t, f, `SELECT COUNT(*) FROM documents`); rows[0][0] != int64(0) {
		t.Fatal("备份失败时不得写库")
	}
}

func TestOCRCacheWarns(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	f.write(t, f.paths.TextCacheFile("2209.14540"),
		"=== Page 1 ===\n"+legacy.OCRMarker+"\n识别出来的正文\n")
	report := run(t, f, false)
	joined := strings.Join(report.Warnings, "；")
	if !strings.Contains(joined, "OCR") {
		t.Fatalf("OCR 缓存必须告警，实际 %v", report.Warnings)
	}
}

func TestEmptyRootImportsNothing(t *testing.T) {
	f := newFixture(t)
	report := run(t, f, false)
	if report.DocumentsAdded != 0 {
		t.Fatalf("空数据根不应导入任何内容，实际 %+v", report)
	}
	if report.BackupDir != "" {
		t.Fatalf("没有可备份内容时不应留下备份目录，实际 %q", report.BackupDir)
	}
}

func TestLastRunReportIsStored(t *testing.T) {
	f := newFixture(t)
	f.standardData(t)
	report := run(t, f, false)
	var body string
	if err := f.handle.QueryRow(`SELECT value_json FROM app_state WHERE key='import.lastRun'`).Scan(&body); err != nil {
		t.Fatal(err)
	}
	var stored Report
	if err := json.Unmarshal([]byte(body), &stored); err != nil {
		t.Fatalf("上次导入报告应可解析: %v", err)
	}
	if stored.DocumentsAdded != report.DocumentsAdded || stored.StartedAt != report.StartedAt {
		t.Fatalf("存储的报告与返回值不一致: %+v vs %+v", stored, report)
	}
	// 旧版状态文件整体留档，S6 做库管理时不必再回头读 JSON。
	for _, key := range []string{"legacy.library", "legacy.progress"} {
		if err := f.handle.QueryRow(`SELECT value_json FROM app_state WHERE key=?`, key).Scan(&body); err != nil {
			t.Fatalf("%s 未存档: %v", key, err)
		}
	}
}

func TestYearFallbackFromPublished(t *testing.T) {
	f := newFixture(t)
	f.write(t, f.paths.QueueFile(), fmt.Sprintf(`{"papers":[{"id":"only-published","title":"T","published":"2026-08-24"}]}`))
	run(t, f, false)
	var year sql.NullInt64
	if err := f.handle.QueryRow(`SELECT year FROM documents WHERE id='only-published'`).Scan(&year); err != nil {
		t.Fatal(err)
	}
	if !year.Valid || year.Int64 != 2026 {
		t.Fatalf("published 里的年份应被取出，实际 %v", year)
	}
}
