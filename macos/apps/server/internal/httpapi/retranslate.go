package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"cbctv2/server/internal/legacy"
)

type retranslationBackup struct {
	Translations []retranslationCacheEntry `json:"translations"`
}

type retranslationCacheEntry struct {
	Hash      string `json:"hash"`
	Source    string `json:"source"`
	Target    string `json:"target"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) handleRetranslate(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	doc, err := s.loadDocument(r.Context(), key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "书库中没有这篇论文")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	if doc.Format != "pdf" || !doc.HasPDF {
		writeError(w, http.StatusConflict, "只有已入库的 PDF 可以重新翻译")
		return
	}
	if prior, found := s.loadImportJobForDocument(r.Context(), key); found && prior.Status == "running" {
		writeError(w, http.StatusConflict, "这篇论文已有处理任务正在运行")
		return
	}
	layout, available, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取已有 OCR 结果失败: "+err.Error())
		return
	}
	if !available || len(layout.Pages) == 0 {
		writeError(w, http.StatusConflict, "论文没有可复用的 OCR 结果，请重新导入")
		return
	}
	paths := legacy.NewPaths(s.cfg.DataRoot)
	jobID, err := randomLeeJobID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	jobKey := "retranslate-" + jobID
	jobRoot := filepath.Join(paths.DataDir(), "retain", "jobs", jobKey)
	priorJobKey := key
	if prior, found := s.loadImportJobForDocument(r.Context(), key); found && prior.Key != "" {
		priorJobKey = prior.Key
	}
	if filepath.Base(priorJobKey) != priorJobKey {
		writeError(w, http.StatusInternalServerError, "原处理任务编号无效，无法定位 Lee OCR 结果")
		return
	}
	priorSourceJSON := filepath.Join(paths.DataDir(), "retain", "jobs", priorJobKey, "ocr", "normalized", "document.v1.json")
	normalized, err := os.ReadFile(priorSourceJSON)
	if err != nil {
		writeError(w, http.StatusConflict, "找不到原始 Lee OCR 归一化文件，无法复用识别结果: "+err.Error())
		return
	}
	pdf, err := os.ReadFile(doc.PDFPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取书库 PDF 失败: "+err.Error())
		return
	}
	for _, dir := range []string{
		filepath.Join(jobRoot, "source"),
		filepath.Join(jobRoot, "ocr", "normalized"),
		filepath.Join(jobRoot, "translated"),
		filepath.Join(jobRoot, "rendered", "typst"),
		filepath.Join(jobRoot, "artifacts"),
		filepath.Join(jobRoot, "logs"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, "创建重新翻译任务目录失败: "+err.Error())
			return
		}
	}
	if err := os.WriteFile(filepath.Join(jobRoot, "source", "source.pdf"), pdf, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "复制重新翻译输入 PDF 失败: "+err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(jobRoot, "ocr", "normalized", "document.v1.json"), normalized, 0o600); err != nil {
		writeError(w, http.StatusInternalServerError, "复制 Lee OCR 结果失败: "+err.Error())
		return
	}
	backupPath := filepath.Join(jobRoot, "retranslate-backup.json")
	if err := s.backupAndClearTranslations(r.Context(), key, backupPath); err != nil {
		writeError(w, http.StatusInternalServerError, "准备全新翻译缓存失败: "+err.Error())
		return
	}
	previousPDF := filepath.Join(jobRoot, "previous-translated.pdf")
	currentPDF := filepath.Join(paths.LibraryDir(), key+"-translated.pdf")
	if err := os.Rename(currentPDF, previousPDF); err != nil && !errors.Is(err, os.ErrNotExist) {
		_ = restoreRetranslateBackup(context.Background(), s, key, backupPath)
		writeError(w, http.StatusInternalServerError, "暂存旧译文 PDF 失败: "+err.Error())
		return
	}
	jobCtx, cancel := context.WithCancel(context.Background())
	job := s.beginImportJob(jobKey, doc.Title+"（重新翻译）", len(layout.Pages), cancel)
	s.jobStage(job.Key, "ocr", "done", "复用已有 Lee OCR 与段落结构", len(layout.Pages), len(layout.Pages))
	s.jobStage(job.Key, "translate", "running", "正在重新翻译全文（忽略旧译文缓存）", 0, countLeeTranslationUnits(layoutOCRPages(layout)))
	s.jobStage(job.Key, "memory", "skipped", "复用书库中已有论文记忆", -1, -1)
	s.linkImportJobDocument(jobKey, key)
	pages := layoutOCRPages(layout)
	go func() {
		defer cancel()
		s.runLeeTranslationInBackground(jobCtx, jobKey, key, doc.Title+".pdf", pages, true)
	}()
	writeJSON(w, http.StatusAccepted, map[string]any{"jobKey": jobKey, "status": "running"})
}

func (s *Server) backupAndClearTranslations(ctx context.Context, key, backupPath string) error {
	rows, err := s.handle.QueryContext(ctx, `SELECT para_hash, source, target, updated_at FROM translations WHERE document_id=?`, key)
	if err != nil {
		return err
	}
	backup := retranslationBackup{Translations: []retranslationCacheEntry{}}
	for rows.Next() {
		var item retranslationCacheEntry
		if err := rows.Scan(&item.Hash, &item.Source, &item.Target, &item.UpdatedAt); err != nil {
			rows.Close()
			return err
		}
		backup.Translations = append(backup.Translations, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	encoded, err := json.Marshal(backup)
	if err != nil {
		return err
	}
	if err := os.WriteFile(backupPath, encoded, 0o600); err != nil {
		return err
	}
	_, err = s.handle.ExecContext(ctx, `DELETE FROM translations WHERE document_id=?`, key)
	return err
}

func restoreRetranslateBackup(ctx context.Context, s *Server, key, path string) error {
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var backup retranslationBackup
	if err := json.Unmarshal(encoded, &backup); err != nil {
		return err
	}
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range backup.Translations {
		if _, err := tx.ExecContext(ctx, `INSERT INTO translations(document_id,para_hash,source,target,updated_at) VALUES(?,?,?,?,?)
			ON CONFLICT(document_id,para_hash) DO UPDATE SET source=excluded.source,target=excluded.target,updated_at=excluded.updated_at`,
			key, item.Hash, item.Source, item.Target, item.UpdatedAt); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return os.Remove(path)
}

func restoreRetranslatePDF(s *Server, key, previousPath string) error {
	if _, err := os.Stat(previousPath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	target := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).LibraryDir(), key+"-translated.pdf")
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove partial translated PDF: %w", err)
	}
	return os.Rename(previousPath, target)
}
