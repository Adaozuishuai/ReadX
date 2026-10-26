package httpapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
)

type documentProcessingJob struct {
	DocumentJob
	DocumentKey string `json:"documentKey,omitempty"`
}

func processingJobRunning(job DocumentJob) bool {
	if job.Status == "running" {
		return true
	}
	for _, stage := range job.Stages {
		if stage.Status == "running" {
			return true
		}
	}
	return false
}

// Include uploads that have not reached the library yet, as well as the latest
// job for each library document. Search and reading-status filters do not apply.
func (s *Server) handleDocumentJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	saved, err := s.loadDocumentJobs(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	byKey := make(map[string]DocumentJob, len(saved))
	for _, job := range saved {
		byKey[job.Key] = job
	}
	live := map[string]bool{}
	s.jobsMu.Lock()
	for key, runtime := range s.importJobs {
		if runtime != nil && runtime.job != nil {
			byKey[key] = cloneDocumentJob(runtime.job)
			live[key] = true
		}
	}
	s.jobsMu.Unlock()

	rows, err := s.handle.QueryContext(ctx,
		`SELECT key, value_json FROM app_state WHERE key LIKE ?`, jobDocumentPrefix+"%")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取文档任务关联失败: "+err.Error())
		return
	}
	documentForJob := map[string]string{}
	latestForDocument := map[string]string{}
	for rows.Next() {
		var key, body, jobKey string
		if err = rows.Scan(&key, &body); err != nil {
			break
		}
		if json.Unmarshal([]byte(body), &jobKey) != nil {
			var legacy DocumentJob
			if json.Unmarshal([]byte(body), &legacy) != nil {
				continue
			}
			jobKey = legacy.Key
		}
		if jobKey != "" {
			documentKey := strings.TrimPrefix(key, jobDocumentPrefix)
			documentForJob[jobKey] = documentKey
			latestForDocument[documentKey] = jobKey
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取文档任务关联失败: "+err.Error())
		return
	}

	jobs := []documentProcessingJob{}
	for key, job := range byKey {
		// Use the same restart/reconciliation behavior as the single-job panel.
		if !live[key] && processingJobRunning(job) {
			if current, found := s.loadImportJob(ctx, key); found {
				job = *current
			}
		}
		if latest := latestForDocument[key]; latest != "" && latest != key {
			continue // A retranslation superseded this document's original job.
		}
		if strings.HasPrefix(key, "retranslate-") && documentForJob[key] == "" && !processingJobRunning(job) {
			continue // Older retry attempts are available in the document's history.
		}
		jobs = append(jobs, documentProcessingJob{DocumentJob: job, DocumentKey: documentForJob[key]})
	}
	sort.Slice(jobs, func(i, j int) bool {
		left, right := processingJobRunning(jobs[i].DocumentJob), processingJobRunning(jobs[j].DocumentJob)
		if left != right {
			return left
		}
		if jobs[i].UpdatedAt != jobs[j].UpdatedAt {
			return jobs[i].UpdatedAt > jobs[j].UpdatedAt
		}
		return jobs[i].Key < jobs[j].Key
	})
	writeJSON(w, http.StatusOK, map[string]any{"jobs": jobs})
}
