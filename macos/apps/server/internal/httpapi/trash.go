package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/safekey"
)

// Permanently remove database records and imported copies owned by those records.
// Files outside the managed library directory remain untouched.
func (s *Server) handleTrashEmpty(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Keys []string `json:"keys"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	keys := []string{}
	seen := map[string]bool{}
	for _, key := range body.Keys {
		if err := safekey.Check(key); err != nil {
			writeError(w, http.StatusBadRequest, "非法论文键")
			return
		}
		if !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	s.appStateMu.Lock()
	defer s.appStateMu.Unlock()
	all, err := s.loadAllMeta(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	// Use the confirmed snapshot, and never remove a document restored meanwhile.
	for _, key := range keys {
		if !all[key].Deleted {
			writeError(w, http.StatusConflict, "回收站内容已变化，请刷新后重新确认")
			return
		}
	}
	tx, err := s.handle.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	defer tx.Rollback()
	libraryCopies := map[string]struct{}{}
	leeJobDirs := map[string]struct{}{}
	libraryDir := legacy.NewPaths(s.cfg.DataRoot).LibraryDir()
	leeJobsRoot := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).DataDir(), "retain", "jobs")
	var statusJSON string
	statuses := map[string]json.RawMessage{}
	err = tx.QueryRowContext(r.Context(), `SELECT value_json FROM app_state WHERE key = 'documents.status'`).Scan(&statusJSON)
	if err == nil {
		if err = json.Unmarshal([]byte(statusJSON), &statuses); err != nil || statuses == nil {
			writeError(w, 500, "论文状态数据已损坏，未清空回收站")
			return
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		writeError(w, 500, err.Error())
		return
	}
	for _, key := range keys {
		if jobDir, ok := managedLeeJobDir(leeJobsRoot, key); ok {
			leeJobDirs[jobDir] = struct{}{}
		}
		var pdfPath string
		err = tx.QueryRowContext(r.Context(), `SELECT pdf_path FROM documents WHERE key = ?`, key).Scan(&pdfPath)
		if err == nil {
			if path, ok := managedLibraryFilePath(libraryDir, pdfPath); ok {
				libraryCopies[path] = struct{}{}
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			writeError(w, 500, err.Error())
			return
		}
		// Foreign keys cascade to pages, translations, notes and reading locations.
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM documents WHERE key = ?`, key); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM app_state WHERE key = ?`, "reproduction:"+key); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM app_state WHERE key = ?`, translationQAKey(key)); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM app_state WHERE key IN (?,?)`, jobStatePrefix+key, jobDocumentPrefix+key); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		prefix := paperCachePrefix(key)
		if _, err = tx.ExecContext(r.Context(), `DELETE FROM app_state WHERE substr(key,1,length(?))=?`, prefix, prefix); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		delete(all, key)
		delete(statuses, key)
	}
	for stateKey, value := range map[string]any{"documents.meta": all, "documents.status": statuses} {
		encoded, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			writeError(w, 500, marshalErr.Error())
			return
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?)
			ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`, stateKey, string(encoded), nowStamp()); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	if err = tx.Commit(); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	removedCopies := 0
	for _, key := range keys {
		s.cancelImportJob(key)
		s.jobsMu.Lock()
		delete(s.importJobs, key)
		s.jobsMu.Unlock()
		_, _ = s.handle.ExecContext(r.Context(), `DELETE FROM app_state WHERE key IN (?,?)`, jobStatePrefix+key, jobDocumentPrefix+key)
	}
	for path := range libraryCopies {
		if s.removeUnreferencedLibraryFile(r.Context(), path) {
			removedCopies++
		}
	}
	removedJobDirs := 0
	for dir := range leeJobDirs {
		if err := os.RemoveAll(dir); err == nil {
			removedJobDirs++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"deletedKeys": keys, "libraryCopiesRemoved": removedCopies, "leeJobCachesRemoved": removedJobDirs, "originalFilesPreserved": true,
	})
}

func managedLeeJobDir(jobsRoot, key string) (string, bool) {
	if safekey.Check(key) != nil {
		return "", false
	}
	root, err := filepath.Abs(jobsRoot)
	if err != nil {
		return "", false
	}
	target, err := filepath.Abs(filepath.Join(root, key))
	if err != nil {
		return "", false
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative != key || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return target, true
}

func managedLibraryFilePath(libraryDir, target string) (string, bool) {
	if strings.TrimSpace(target) == "" {
		return "", false
	}
	libraryRoot, err := filepath.Abs(libraryDir)
	if err != nil {
		return "", false
	}
	filePath, err := filepath.Abs(target)
	if err != nil {
		return "", false
	}
	relative, err := filepath.Rel(libraryRoot, filePath)
	if err != nil || relative == "." || relative == ".." || filepath.IsAbs(relative) || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return filePath, true
}
