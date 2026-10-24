package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"cbctv2/server/internal/legacy"
)

func TestLeeRetranslatePublishesPDFAndCompletesItsOwnJob(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	const documentKey, jobKey = "paper", "retranslate-paper"
	s.beginImportJob(documentKey, "original import", 20, nil)
	s.beginImportJob(jobKey, "retranslation", 20, nil)
	s.jobStage(jobKey, "render", "running", "compiling", 20, 20)
	data := []byte("%PDF-1.4\ntranslated document\n")
	source := filepath.Join(t.TempDir(), "translated.pdf")
	if err := os.WriteFile(source, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.adoptLeeTranslatedPDF(jobKey, documentKey, source, 20); err != nil {
		t.Fatal(err)
	}
	s.finishImportJob(jobKey, "done", "")
	job, _ := s.loadImportJob(context.Background(), jobKey)
	stage := job.stage("render")
	if job.Status != "done" || stage.Status != "done" || stage.Completed != 20 || stage.Total != 20 || stage.FinishedAt == "" || stage.Unit != "页" {
		t.Fatalf("retranslation did not finish rendering: %+v", job)
	}
	prior, _ := s.loadImportJob(context.Background(), documentKey)
	if prior.stage("render").Status != "pending" {
		t.Fatal("retranslation modified the original import job")
	}
	target := filepath.Join(legacy.NewPaths(cfg.DataRoot).LibraryDir(), documentKey+"-translated.pdf")
	if body, err := os.ReadFile(target); err != nil || string(body) != string(data) {
		t.Fatalf("translated PDF was not published under the document key: %v", err)
	}
}

func TestCompletedLeeJobReconcilesOldProgressFromPublishedOutput(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	const key = "retranslate-legacy"
	root := filepath.Join(legacy.NewPaths(cfg.DataRoot).DataDir(), "retain", "jobs", key)
	for _, folder := range []string{"rendered", "translated"} {
		if err := os.MkdirAll(filepath.Join(root, folder), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "rendered", "readx-translated.pdf"), []byte("%PDF-1.4\n"), 0600); err != nil {
		t.Fatal(err)
	}
	outputs := `[{"page_idx":0,"source_text":"one","translated_text":"first"},{"page_idx":0,"source_text":"two","translated_text":"second"},{"page_idx":0,"source_text":"three","translated_text":"third"}]`
	if err := os.WriteFile(filepath.Join(root, "translated", "page-001.json"), []byte(outputs), 0600); err != nil {
		t.Fatal(err)
	}
	s.beginImportJob(key, "paper", 20, nil)
	s.jobStage(key, "translate", "running", "translating", 2, 4)
	s.jobStage(key, "translate", "done", "cached two paragraphs", 2, 4)
	s.jobStage(key, "render", "running", "rendering pages complete", 20, 20)
	s.updateImportJob(key, func(job *DocumentJob) { job.stage("translate").Unit = "页" })
	s.finishImportJob(key, "done", "")

	// The same record is served consistently before and after a service restart.
	cold := New(cfg, handle)
	defer cold.comparisonJobs.Close()
	for _, server := range []*Server{s, cold} {
		job, ok := server.loadImportJob(context.Background(), key)
		if !ok || job.Status != "done" || job.stage("render").Status != "done" {
			t.Fatalf("published output still appears to be running: %+v", job)
		}
		translation := job.stage("translate")
		if translation.Completed != 3 || translation.Total != 3 || translation.Unit != "块" || translation.ResultCount != 2 || translation.ResultUnit != "段" {
			t.Fatalf("provider outputs and matched cache counts were mixed: %+v", translation)
		}
		if job.stage("render").FinishedAt != job.Runs[len(job.Runs)-1].FinishedAt {
			t.Fatal("historical completion time was replaced by the read time")
		}
	}
	// A published partial artifact must not complete a running/failed job.
	for _, status := range []string{"running", "failed"} {
		job := newDocumentJob(key, "paper", 20)
		job.Status = status
		job.setStage("render", "running", "rendering", 20, 20)
		if s.reconcileCompletedLeeJob(job) || job.stage("render").Status != "running" {
			t.Fatalf("%s job was incorrectly completed", status)
		}
	}
	if err := os.Remove(filepath.Join(root, "rendered", "readx-translated.pdf")); err != nil {
		t.Fatal(err)
	}
	job := newDocumentJob(key, "paper", 20)
	job.Status = "done"
	job.setStage("render", "running", "no output", 20, 20)
	if s.reconcileCompletedLeeJob(job) {
		t.Fatal("missing output must not be reported as a completed render")
	}
}
