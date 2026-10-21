// documents.go：S1 的文档接口——导入、列表筛选、详情、逐页正文、正文上传、PDF 流。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"cbctv2/server/internal/importer"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/publication"
	"cbctv2/server/internal/safekey"
)

// maxPageBody 限制单次上传的页文本大小：正文按页传，1 MiB 已远超正常论文单页；
// 不设上限会让一个坏客户端把 SQLite 撑爆。
const maxPageBody = 1 << 20

type pageText struct {
	Page      int    `json:"page"`
	Text      string `json:"text"`
	Chars     int    `json:"chars"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt"`
}

type documentDetail struct {
	Sections []publication.Section `json:"sections"`
	Document DocumentSummary       `json:"document"`
	Pages    []pageSummary         `json:"pages"`
	Reading  *json.RawMessage      `json:"reading"`
	HasPDF   bool                  `json:"hasPdf"`
	HasText  bool                  `json:"hasText"`
	FromOCR  bool                  `json:"fromOcr"`
}

type pageSummary struct {
	Page      int    `json:"page"`
	Chars     int    `json:"chars"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt"`
}

// handleImport 执行「旧 JSON → SQLite」的一次性导入。幂等，可反复调用。
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ForceBackup bool `json:"forceBackup"`
	}
	if err := decodeOptionalJSON(w, r, &body); err != nil {
		return
	}
	report, err := importer.Run(r.Context(), s.handle, importer.Options{
		Paths:       legacy.NewPaths(s.cfg.DataRoot),
		ForceBackup: body.ForceBackup,
	})
	if err != nil {
		writeError(w, statusForError(err), "导入失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleDocument(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	document, err := s.loadDocument(r.Context(), key)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pages, err := s.listPages(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	detail := documentDetail{Document: document, Pages: pages, HasText: len(pages) > 0}
	detail.Sections, err = s.listSections(r.Context(), key)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if len(detail.Sections) > 0 {
		detail.HasText = true
	}
	if raw, found, err := s.loadReading(r.Context(), key); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	} else if found {
		encoded := json.RawMessage(raw)
		detail.Reading = &encoded
	}
	if document.HasPDF {
		detail.HasPDF = true
		detail.FromOCR = s.pagesLookLikeOCR(r.Context(), key)
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) handlePageList(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	// 与 /pages/{page} 和 /documents/{key} 保持一致：文档不存在返回 404，
	// 否则客户端无法区分「文档不存在」和「还没抽过页」。
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	pages, err := s.listPages(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "pages": pages, "total": len(pages)})
}

func (s *Server) handlePageGet(w http.ResponseWriter, r *http.Request) {
	key, number, ok := pathKeyAndPage(w, r)
	if !ok {
		return
	}
	var item pageText
	var updatedAt sql.NullString
	err := s.handle.QueryRowContext(r.Context(),
		`SELECT page, text, hash, updated_at FROM document_pages WHERE document_id = ? AND page = ?`,
		key, number).Scan(&item.Page, &item.Text, &item.Hash, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, fmt.Sprintf("第 %d 页还没有正文", number))
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	item.Chars = len([]rune(item.Text))
	item.UpdatedAt = updatedAt.String
	writeJSON(w, http.StatusOK, item)
}

// handlePagePut 接收渲染进程 pdf.js 抽出的单页正文。服务端不解析 PDF，只存文本——
// 与旧版 library/text/<key>-v3.txt 的分工一致（Go 生态没有可靠的 PDF 文本抽取库）。
func (s *Server) handlePagePut(w http.ResponseWriter, r *http.Request) {
	key, number, ok := pathKeyAndPage(w, r)
	if !ok {
		return
	}
	if number < 1 || number > 5000 {
		writeError(w, http.StatusBadRequest, "页码超出合理范围")
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPageBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "单页正文超过 1 MiB 上限")
			return
		}
		writeError(w, http.StatusBadRequest, "请求体必须是 {\"text\": \"...\"} 形式的 JSON")
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeError(w, http.StatusBadRequest, "正文为空；确实没有文本层请改用 OCR 通道，不要写空页")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档，先导入队列")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hash := hashText(text)
	updatedAt := nowStamp()
	_, err := s.handle.ExecContext(r.Context(),
		`INSERT INTO document_pages(document_id, page, text, hash, updated_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(document_id, page) DO UPDATE SET text = excluded.text, hash = excluded.hash, updated_at = excluded.updated_at`,
		key, number, text, hash, updatedAt)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "写入正文失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "page": number, "hash": hash, "chars": len([]rune(text)), "updatedAt": updatedAt})
}

// handleStatusPatch 记录用户手改的阅读状态；导入器会读它，重跑导入不会冲掉。
func (s *Server) handleStatusPatch(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Status string `json:"status"`
	}
	if err := decodeOptionalJSON(w, r, &body); err != nil {
		return
	}
	switch body.Status {
	case "queue", "reading", "done", "archive":
	default:
		writeError(w, http.StatusBadRequest, "status 只能是 queue / reading / done / archive")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if body.Status == "archive" {
		tx, err := s.handle.BeginTx(r.Context(), nil)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		defer func() { _ = tx.Rollback() }()
		if _, err := tx.ExecContext(r.Context(), `UPDATE documents SET status = ?, updated_at = ? WHERE id = ?`, body.Status, nowStamp(), key); err != nil {
			writeError(w, http.StatusInternalServerError, "更新状态失败: "+err.Error())
			return
		}
		if err := recordStatusOverride(r.Context(), tx, key, body.Status); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if err := tx.Commit(); err != nil {
			writeError(w, http.StatusInternalServerError, "提交失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"key": key, "status": body.Status})
		return
	}
	if body.Status != "queue" && body.Status != "reading" {
		status, err := s.recalculateDocumentStatus(r.Context(), key)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "计算阅读状态失败: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"key": key, "status": status})
		return
	}
	tx, err := s.handle.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := setChatActivity(r.Context(), tx, key, body.Status == "reading"); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "提交失败: "+err.Error())
		return
	}
	status, err := s.recalculateDocumentStatus(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "计算阅读状态失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "status": status})
}

func (s *Server) documentHasPDF(key string) bool {
	_, found := legacy.NewPaths(s.cfg.DataRoot).PDFFile(key)
	return found
}

// ---- 数据访问 ----

func (s *Server) loadDocument(ctx context.Context, key string) (DocumentSummary, error) {
	if _, err := s.recalculateDocumentStatus(ctx, key); err != nil {
		return DocumentSummary{}, err
	}
	var item DocumentSummary
	var authorsJSON string
	var year sql.NullInt64
	err := s.handle.QueryRowContext(ctx,
		`SELECT id, key, title, authors, year, venue, doi, url, status, pdf_path, added_at, updated_at, format, translated_title
		 FROM documents WHERE id = ?`, key).
		Scan(&item.ID, &item.Key, &item.Title, &authorsJSON, &year, &item.Venue, &item.DOI,
			&item.URL, &item.Status, &item.PDFPath, &item.AddedAt, &item.UpdatedAt, &item.Format, &item.TranslatedTitle)
	if err != nil {
		return DocumentSummary{}, err
	}
	item.Title = normalizePaperTitle(item.Title)
	if err := json.Unmarshal([]byte(authorsJSON), &item.Authors); err != nil || item.Authors == nil {
		item.Authors = []string{}
	}
	if year.Valid {
		parsed := int(year.Int64)
		item.Year = &parsed
	}
	item.HasPDF = s.documentHasPDF(item.Key)
	return item, nil
}

func (s *Server) listPages(ctx context.Context, key string) ([]pageSummary, error) {
	rows, err := s.handle.QueryContext(ctx,
		`SELECT page, length(text), hash, updated_at FROM document_pages WHERE document_id = ? ORDER BY page`, key)
	if err != nil {
		return nil, fmt.Errorf("读取页列表失败: %w", err)
	}
	defer rows.Close()

	out := []pageSummary{}
	for rows.Next() {
		var item pageSummary
		var chars sql.NullInt64
		var updatedAt sql.NullString
		if err := rows.Scan(&item.Page, &chars, &item.Hash, &updatedAt); err != nil {
			return nil, fmt.Errorf("解析页列表失败: %w", err)
		}
		item.Chars = int(chars.Int64)
		item.UpdatedAt = updatedAt.String
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Server) loadReading(ctx context.Context, key string) (string, bool, error) {
	var body string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id = ?`, key).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("读取精读记录失败: %w", err)
	}
	return body, true, nil
}

func (s *Server) pagesLookLikeOCR(ctx context.Context, key string) bool {
	var sample string
	err := s.handle.QueryRowContext(ctx,
		`SELECT text FROM document_pages WHERE document_id = ? ORDER BY page LIMIT 1`, key).Scan(&sample)
	if err != nil {
		return false
	}
	return strings.Contains(sample, legacy.OCRMarker)
}

func recordStatusOverride(ctx context.Context, tx *sql.Tx, key, status string) error {
	var body string
	err := tx.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = 'documents.status'`).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		body = "{}"
	} else if err != nil {
		return fmt.Errorf("读取状态覆盖失败: %w", err)
	}
	overrides := map[string]any{}
	if err := json.Unmarshal([]byte(body), &overrides); err != nil || overrides == nil {
		overrides = map[string]any{}
	}
	overrides[key] = status
	encoded, err := json.Marshal(overrides)
	if err != nil {
		return fmt.Errorf("序列化状态覆盖失败: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES('documents.status', ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		string(encoded), nowStamp()); err != nil {
		return fmt.Errorf("写入状态覆盖失败: %w", err)
	}
	return nil
}

// ---- 辅助 ----

// statusForError 把「数据本身有问题」与「服务器故障」分开：前者是 422，客户端改了数据
// 重跑就能成功；后者才是 500。
func statusForError(err error) int {
	var syntax *json.SyntaxError
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &syntax) || errors.As(err, &typeErr) || strings.Contains(err.Error(), "不是合法") {
		return http.StatusUnprocessableEntity
	}
	if strings.Contains(err.Error(), "备份失败") {
		return http.StatusServiceUnavailable
	}
	return http.StatusInternalServerError
}

func knownStatus(value string) bool {
	switch value {
	case "queue", "reading", "done", "archive":
		return true
	}
	return false
}

func pathKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	key := r.PathValue("key")
	if err := safekey.Check(key); err != nil {
		writeError(w, http.StatusBadRequest, "非法论文键: "+err.Error())
		return "", false
	}
	return key, true
}

func pathKeyAndPage(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	key, ok := pathKey(w, r)
	if !ok {
		return "", 0, false
	}
	number, err := strconv.Atoi(r.PathValue("page"))
	if err != nil || number < 1 {
		writeError(w, http.StatusBadRequest, "页码必须是正整数")
		return "", 0, false
	}
	return key, number, true
}

func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		writeError(w, http.StatusBadRequest, "请求体不是合法 JSON: "+err.Error())
		return err
	}
	return nil
}

func hashText(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:8])
}

func nowStamp() string { return time.Now().UTC().Format(time.RFC3339) }

// resolveUnderLibrary 二次确认最终路径仍在 library/ 内：PDFFile 依赖目录扫描，
// 万一将来键规则放宽，这里也不会把 library 之外的文件暴露出去。
func resolveUnderLibrary(paths legacy.Paths, candidate string) (string, error) {
	library, err := filepath.Abs(paths.LibraryDir())
	if err != nil {
		return "", err
	}
	resolved, err := filepath.Abs(candidate)
	if err != nil {
		return "", fmt.Errorf("无法解析 PDF 路径: %w", err)
	}
	relative, err := filepath.Rel(library, resolved)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "", errors.New("PDF 路径越出 library 目录，已拒绝")
	}
	if _, err := os.Stat(resolved); err != nil {
		return "", errors.New("PDF 文件不存在")
	}
	return resolved, nil
}
