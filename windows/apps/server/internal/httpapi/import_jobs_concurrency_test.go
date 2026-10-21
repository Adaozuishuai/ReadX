package httpapi

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
)

func TestImportJobSnapshotsDoNotShareMutableStages(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	server.beginImportJob("snapshot-test", "paper.pdf", 1, nil)
	first, ok := server.loadImportJob(context.Background(), "snapshot-test")
	if !ok {
		t.Fatal("job missing")
	}
	first.Stages[0].Status = "corrupted"
	first.Runs[0].Status = "corrupted"
	second, _ := server.loadImportJob(context.Background(), "snapshot-test")
	if second.Stages[0].Status == "corrupted" || second.Runs[0].Status == "corrupted" {
		t.Fatal("returned snapshot aliases the mutable job state")
	}
	server.jobStage("snapshot-test", "translate", "done", "latest", 1, 1)
	server.persistImportJob(first)
	var body string
	if err := handle.QueryRow(`SELECT value_json FROM app_state WHERE key=?`, jobStatePrefix+"snapshot-test").Scan(&body); err != nil {
		t.Fatal(err)
	}
	var saved DocumentJob
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.stage("translate").Status != "done" {
		t.Fatalf("old snapshot overwrote current progress: %s", body)
	}
}

func TestImportJobConcurrentUpdatesAndReads(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	server.beginImportJob("concurrent-test", "paper.pdf", 100, nil)
	var workers sync.WaitGroup
	for worker := 0; worker < 4; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for iteration := 0; iteration < 30; iteration++ {
				server.jobStage("concurrent-test", "translate", "running", "progress", iteration, 100)
				job, _ := server.loadImportJob(context.Background(), "concurrent-test")
				if _, err := json.Marshal(job); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	workers.Wait()
	server.jobStage("concurrent-test", "translate", "done", "completed", 100, 100)
	server.finishImportJob("concurrent-test", "done", "")
	var body string
	if err := handle.QueryRow(`SELECT value_json FROM app_state WHERE key=?`, jobStatePrefix+"concurrent-test").Scan(&body); err != nil {
		t.Fatal(err)
	}
	var saved DocumentJob
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Status != "done" || saved.stage("translate").Completed != 100 {
		t.Fatalf("stale persisted job: %s", body)
	}
}
