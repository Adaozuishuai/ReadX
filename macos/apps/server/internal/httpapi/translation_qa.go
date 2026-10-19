package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

const translationQAStatePrefix = "translation-numeric-qa:"

func translationQAKey(key string) string { return translationQAStatePrefix + key }

// handleTranslationQA returns the document-wide numeric QA report generated
// after OCR paragraph translations have been assembled.
func (s *Server) handleTranslationQA(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	var raw string
	if err := s.handle.QueryRowContext(r.Context(), `SELECT value_json FROM app_state WHERE key=?`, translationQAKey(key)).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "这篇文档还没有数字核验记录")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	var report json.RawMessage
	if err := json.Unmarshal([]byte(raw), &report); err != nil || len(report) == 0 {
		writeError(w, http.StatusInternalServerError, "数字核验记录格式无效")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(report)
}
