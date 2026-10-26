package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"cbctv2/server/internal/db"
)

func TestDocumentJobsListsConcurrentImportsAndLatestRetranslation(t *testing.T) {
	cfg := defaultTestConfig(t.TempDir())
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	fetch := func(server *Server) []documentProcessingJob {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/v1/document-jobs?q=unrelated", nil)
		r.Header.Set("Authorization", "Bearer "+cfg.Token)
		w := httptest.NewRecorder()
		server.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("list jobs: HTTP %d: %s", w.Code, w.Body)
		}
		var response struct {
			Jobs []documentProcessingJob `json:"jobs"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Jobs == nil {
			t.Fatal("jobs must be an array, including when empty")
		}
		return response.Jobs
	}
	if jobs := fetch(s); len(jobs) != 0 {
		t.Fatalf("empty library has jobs: %+v", jobs)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://127.0.0.1/v1/document-jobs", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("job list bypassed authentication: %d", w.Code)
	}

	// Neither upload has reached the documents table yet.
	s.beginImportJob("upload-a", "a.pdf", 4, nil)
	s.jobStage("upload-a", "translate", "running", "translating", 2, 8)
	s.jobStage("upload-a", "render", "running", "rendering", 1, 4)
	s.beginImportJob("upload-b", "b.pdf", 0, nil)
	s.jobStage("upload-b", "ocr", "running", "recognizing", 0, 0)
	s.beginImportJob("paper", "paper.pdf", 2, nil)
	s.finishImportJob("paper", "done", "")
	s.beginImportJob("retranslate-old", "old retry", 2, nil)
	s.linkImportJobDocument("retranslate-old", "paper")
	s.finishImportJob("retranslate-old", "done", "")
	s.beginImportJob("retranslate-current", "current retry", 2, nil)
	s.linkImportJobDocument("retranslate-current", "paper")
	s.jobStage("retranslate-current", "translate", "running", "retrying", 1, 5)
	s.beginImportJob("memory", "memory.pdf", 1, nil)
	s.finishImportJob("memory", "done", "")
	s.jobStage("memory", "memory", "running", "building memory", 0, 1)
	s.beginImportJob("failed-upload", "failed.pdf", 1, nil)
	s.finishImportJob("failed-upload", "failed", "OCR unavailable")

	// A fresh in-memory update must win over a slightly older persisted snapshot.
	s.jobsMu.Lock()
	s.importJobs["upload-a"].job.stage("translate").Completed = 3
	s.jobsMu.Unlock()
	jobs := fetch(s)
	if len(jobs) != 5 {
		t.Fatalf("lost uploads or included superseded retries: %+v", jobs)
	}
	for index, job := range jobs {
		if index < 4 && !processingJobRunning(job.DocumentJob) {
			t.Fatalf("running jobs must sort first: %+v", jobs)
		}
		switch job.Key {
		case "upload-a":
			if job.stage("translate").Completed != 3 || job.stage("render").Completed != 1 {
				t.Fatalf("lost concurrent stage progress: %+v", job)
			}
		case "retranslate-current":
			if job.DocumentKey != "paper" {
				t.Fatalf("retry does not link to its library document: %+v", job)
			}
		case "failed-upload":
			if job.Error != "OCR unavailable" {
				t.Fatalf("lost failure detail: %+v", job)
			}
		}
	}

	cold := New(cfg, handle)
	defer cold.comparisonJobs.Close()
	for _, job := range fetch(cold) {
		if processingJobRunning(job.DocumentJob) {
			t.Fatalf("a restarted application shows a stale task as running: %+v", job)
		}
	}
}
