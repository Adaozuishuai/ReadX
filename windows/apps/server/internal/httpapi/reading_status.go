package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

var quintetReadingKinds = [...]string{"motivation", "method", "experiment", "results", "reproduction"}

// setChatActivity tracks whether this paper has any saved assistant conversation.
// Conversation contents remain in the browser's local storage.
func setChatActivity(ctx context.Context, tx *sql.Tx, key string, hasHistory bool) error {
	const stateKey = "documents.chat_activity"
	var body string
	err := tx.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key=?`, stateKey).Scan(&body)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("读取助教对话状态失败: %w", err)
	}
	activity := map[string]bool{}
	if body != "" {
		_ = json.Unmarshal([]byte(body), &activity)
	}
	if activity == nil {
		activity = map[string]bool{}
	}
	if hasHistory {
		activity[key] = true
	} else {
		delete(activity, key)
	}
	encoded, err := json.Marshal(activity)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?)
		ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, stateKey, string(encoded), nowStamp())
	return err
}

// recalculateDocumentStatus applies the library's progress rules from persisted data:
// all five quintet entries means done; any conversation, annotation, or quintet entry means reading.
func (s *Server) recalculateDocumentStatus(ctx context.Context, key string) (string, error) {
	var annotations int
	if err := s.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM annotations WHERE document_id=?`, key).Scan(&annotations); err != nil {
		return "", err
	}
	var readingJSON string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM readings WHERE document_id=?`, key).Scan(&readingJSON)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	completed, anyQuintet := countQuintetEntries(readingJSON)
	chatHistory := false
	var activityJSON string
	if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key='documents.chat_activity'`).Scan(&activityJSON); err == nil {
		var activity map[string]bool
		if json.Unmarshal([]byte(activityJSON), &activity) == nil {
			chatHistory = activity[key]
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	status := "queue"
	if completed == len(quintetReadingKinds) {
		status = "done"
	} else if chatHistory || annotations > 0 || anyQuintet {
		status = "reading"
	}
	// Keep an explicitly archived book out of the active reading buckets.
	var overridesJSON string
	if err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key='documents.status'`).Scan(&overridesJSON); err == nil {
		var overrides map[string]string
		if json.Unmarshal([]byte(overridesJSON), &overrides) == nil && overrides[key] == "archive" {
			status = "archive"
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if _, err := s.handle.ExecContext(ctx, `UPDATE documents SET status=?,updated_at=? WHERE id=? AND status<>?`, status, nowStamp(), key, status); err != nil {
		return "", err
	}
	return status, nil
}

func (s *Server) syncDerivedDocumentStatuses(ctx context.Context) error {
	rows, err := s.handle.QueryContext(ctx, `SELECT id FROM documents`)
	if err != nil {
		return err
	}
	keys := []string{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := s.recalculateDocumentStatus(ctx, key); err != nil {
			return fmt.Errorf("刷新 %s 阅读状态失败: %w", key, err)
		}
	}
	return nil
}

func countQuintetEntries(value string) (completed int, any bool) {
	var entries map[string]json.RawMessage
	if json.Unmarshal([]byte(value), &entries) != nil {
		return 0, false
	}
	if nested, ok := entries["entries"]; ok {
		var wrapped map[string]json.RawMessage
		if json.Unmarshal(nested, &wrapped) == nil {
			entries = wrapped
		}
	}
	for _, kind := range quintetReadingKinds {
		key := kind
		raw, exists := entries[key]
		if !exists && kind == "experiment" {
			key, raw, exists = "experimentJSON", entries["experimentJSON"], entries["experimentJSON"] != nil
		}
		if !exists && kind == "results" {
			key, raw, exists = "resultsJSON", entries["resultsJSON"], entries["resultsJSON"] != nil
		}
		if !exists || len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var legacyValue string
		if json.Unmarshal(raw, &legacyValue) == nil && legacyValue != "" {
			any = true
			completed++
			continue
		}
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil || len(object) == 0 {
			continue
		}
		if encodedValue, hasValue := object["value"]; hasValue {
			var entryValue string
			if json.Unmarshal(encodedValue, &entryValue) == nil && entryValue != "" {
				any = true
				completed++
			}
		} else {
			// Older saved quintet results stored their structured value directly.
			any = true
			completed++
		}
	}
	return completed, any
}
