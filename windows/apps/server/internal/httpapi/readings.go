package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"cbctv2/server/internal/validate"
)

// readingKinds 是允许写入的精读产物类型；白名单而不是自由字符串，
// 避免把任意键写进 readings 表（旧版 main.ts 也是 kind 白名单）。
var readingKinds = map[string]bool{"motivation": true, "method": true, "experiment": true, "results": true, "reproduction": true}

// ReadingEntry 是一次生成物的保存形态：原文、降级清单、未核验原因。
// 三者一起存，界面才能如实标注「哪些字段被降级」「哪份是未核验的」。
type ReadingEntry struct {
	Value           string   `json:"value"`
	Demoted         []string `json:"demoted"`
	ValidationError *string  `json:"validationError"`
	UpdatedAt       string   `json:"updatedAt"`
}

type readingSaveResponse struct {
	Saved           bool     `json:"saved"`
	Kind            string   `json:"kind"`
	Pruned          bool     `json:"pruned"`
	Demoted         []string `json:"demoted"`
	ValidationError *string  `json:"validationError"`
}

// handleReadingPut 走四层兜底里的「本地层」：先原样校验，失败则本地修剪，
// 修剪也救不回才按未核验保存（带可见标注）。AI 修复轮在 S3 接入重试层。
func (s *Server) handleReadingPut(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	kind := r.PathValue("kind")
	if !readingKinds[kind] {
		writeError(w, http.StatusBadRequest, "不支持的精读类型，只接受 motivation / method / experiment / results / reproduction")
		return
	}
	var body struct {
		Value string `json:"value"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求体必须是 {\"value\": \"<生成物 JSON 字符串>\"}")
		return
	}
	if strings.TrimSpace(body.Value) == "" {
		writeError(w, http.StatusBadRequest, "value 为空")
		return
	}

	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档，先导入队列")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	source, err := s.sourceText(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if source == "" {
		writeError(w, http.StatusConflict, "这篇论文还没有正文缓存，无法做逐字核验")
		return
	}

	entry := ReadingEntry{Demoted: []string{}}
	pruned := false
	if validationErr := validate.ValidateGenerated(kind, body.Value, source); validationErr != nil {
		if result := validate.PruneGenerated(kind, body.Value, source); result != nil {
			entry.Value = result.Value
			entry.Demoted = result.Demoted
			pruned = true
		} else {
			message := validationErr.Error()
			entry.Value = body.Value
			entry.ValidationError = &message
		}
	} else {
		entry.Value = body.Value
	}
	entry.UpdatedAt = nowStamp()

	if err := s.saveReadingEntry(r.Context(), key, kind, entry); err != nil {
		writeError(w, http.StatusInternalServerError, "保存精读记录失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, readingSaveResponse{
		Saved:           true,
		Kind:            kind,
		Pruned:          pruned,
		Demoted:         entry.Demoted,
		ValidationError: entry.ValidationError,
	})
}

// handleReadingGet 返回整份精读记录（含旧版遗留键），界面按 kind 取用。
func (s *Server) handleReadingGet(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body string
	err := s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM readings WHERE document_id = ?`, key).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusOK, map[string]any{"key": key, "entries": map[string]any{}})
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		writeError(w, http.StatusInternalServerError, "精读记录已损坏: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"key": key, "entries": decoded})
}

// sourceText 把逐页正文还原成校验器认识的 `=== Page N ===` 格式。
func (s *Server) sourceText(ctx context.Context, key string) (string, error) {
	rows, err := s.handle.QueryContext(ctx,
		`SELECT page, text FROM document_pages WHERE document_id = ? ORDER BY page`, key)
	if err != nil {
		return "", fmt.Errorf("读取正文失败: %w", err)
	}
	defer rows.Close()

	blocks := []string{}
	found := false
	for rows.Next() {
		var page int
		var text string
		if err := rows.Scan(&page, &text); err != nil {
			return "", fmt.Errorf("解析正文失败: %w", err)
		}
		found = true
		blocks = append(blocks, fmt.Sprintf("=== Page %d ===\n%s", page, text))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if !found {
		return "", nil
	}
	return strings.Join(blocks, "\n"), nil
}

// saveReadingEntry 按 kind 合并进 readings.value_json，保留旧版遗留键不覆盖。
func (s *Server) saveReadingEntry(ctx context.Context, key, kind string, entry ReadingEntry) error {
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var existing string
	err = tx.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id = ?`, key).Scan(&existing)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	merged := map[string]any{}
	if existing != "" {
		if err := json.Unmarshal([]byte(existing), &merged); err != nil {
			// 旧记录损坏时不覆盖整份：把旧内容留档到 legacy 键下再写新值。
			merged = map[string]any{"legacyCorrupt": existing}
		}
	}
	if merged == nil {
		merged = map[string]any{}
	}
	merged[kind] = entry
	encoded, err := json.Marshal(merged)
	if err != nil {
		return err
	}
	stamp := nowStamp()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO readings(document_id, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(document_id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(encoded), stamp); err != nil {
		return err
	}
	return tx.Commit()
}
