package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCancelDocumentJobResolvesRetranslationKey(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.beginImportJob("retry-job", "paper", 2, cancel)
	s.linkImportJobDocument("retry-job", "paper")
	s.jobStage("retry-job", "translate", "running", "translating", 1, 2)
	s.jobStage("retry-job", "render", "running", "rendering", 0, 2)
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.SetPathValue("key", "paper")
	s.handleCancelDocumentJob(w, r)
	var response struct{ Cancelled bool }
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || !response.Cancelled || ctx.Err() == nil {
		t.Fatalf("reopened document panel did not cancel retry: %s, context=%v, decode=%v", w.Body, ctx.Err(), err)
	}
	// A page renderer may finish reporting progress after cancellation.
	s.jobStage("retry-job", "render", "running", "late progress", 1, 2)
	job, _ := s.loadImportJob(context.Background(), "retry-job")
	for _, key := range []string{"translate", "render"} {
		if stage := job.stage(key); stage.Status != "cancelled" || stage.FinishedAt == "" {
			t.Fatalf("cancelled job retains an active stage: %+v", stage)
		}
	}
}

func TestFailedImportStopsOtherActiveStages(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	s.beginImportJob("failed-job", "paper", 2, nil)
	s.jobStage("failed-job", "ocr", "done", "recognized", 2, 2)
	s.jobStage("failed-job", "translate", "running", "translating", 1, 2)
	s.jobStage("failed-job", "render", "running", "rendering", 0, 2)
	s.jobStage("failed-job", "translate", "failed", "provider failed", -1, -1)
	s.finishImportJob("failed-job", "failed", "provider failed")
	job, _ := s.loadImportJob(context.Background(), "failed-job")
	if stage := job.stage("render"); stage.Status != "interrupted" || stage.FinishedAt == "" {
		t.Fatalf("failed translation leaves rendering active: %+v", stage)
	}
	if job.stage("ocr").Status != "done" || job.stage("translate").Status != "failed" {
		t.Fatalf("completed or failed stages were overwritten: %+v", job.Stages)
	}
	cold := New(cfg, handle)
	defer cold.comparisonJobs.Close()
	stored, _ := cold.loadImportJob(context.Background(), "failed-job")
	if stored.stage("render").Status != "interrupted" {
		t.Fatalf("stage termination was not persisted: %+v", stored.Stages)
	}
}

func TestImportRetriesPreserveChronologicalHistory(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	s.beginImportJob("paper", "first run", 1, nil)
	s.finishImportJob("paper", "failed", "first error")
	for attempt := 2; attempt <= 12; attempt++ {
		// Exercise both retries in one process and history after a restart.
		if attempt%2 == 1 {
			next := New(cfg, handle)
			defer next.comparisonJobs.Close()
			s = next
		}
		s.beginImportJob("paper", "retry", attempt, nil)
		s.finishImportJob("paper", "done", "")
		job, _ := s.loadImportJob(context.Background(), "paper")
		if len(job.Runs) != min(attempt, 10) {
			t.Fatalf("attempt %d lost run history: %+v", attempt, job.Runs)
		}
		for index, run := range job.Runs {
			wantPages := max(1, attempt-9) + index
			wantStatus, wantError := "done", ""
			if wantPages == 1 {
				wantStatus, wantError = "failed", "first error"
			}
			if run.Pages != wantPages || run.Status != wantStatus || run.Error != wantError || run.FinishedAt == "" {
				t.Fatalf("attempt %d overwrote run %d: %+v", attempt, index, run)
			}
		}
	}
}
