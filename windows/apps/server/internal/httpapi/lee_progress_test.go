package httpapi

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"cbctv2/server/internal/db"
)

func TestLeeImportLogStreamsQueueProgressAndSummarizesFailure(t *testing.T) {
	var log bytes.Buffer
	var events []leeStageObservation
	w := &leeImportLogWriter{sink: &log, observe: func(event leeStageObservation) {
		events = append(events, event)
	}}
	output := "OCR request retry\n" +
		`{"schema":"pipeline_stage_observation_v1","user_stage":"ocr","stage_detail":"等待 OCR 服务空位"}` + "\n" +
		"Traceback: private internal details\n" +
		`structured failure json: {"summary":"Paddle OCR 队列已满","suggestion":"Paddle OCR 队列已满，请稍后重试","traceback":"private internal details"}`
	// Child output can split a JSON record and a multibyte Chinese character.
	for start := 0; start < len(output); start += 7 {
		if _, err := w.Write([]byte(output[start:min(start+7, len(output))])); err != nil {
			t.Fatal(err)
		}
	}
	w.flush()
	if log.String() != output {
		t.Fatal("original process log was not preserved")
	}
	if len(events) != 1 || events[0].Detail != "等待 OCR 服务空位" {
		t.Fatalf("missing queue observation: %+v", events)
	}
	if w.failure != "Paddle OCR 队列已满，请稍后重试" || strings.Contains(w.failure, "Traceback") {
		t.Fatalf("expected concise classified failure, got %q", w.failure)
	}
}

func TestLeeQueueProgressKeepsTranslationPendingUntilOCRFinishes(t *testing.T) {
	cfg := defaultTestConfig(t.TempDir())
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	s := New(cfg, handle)
	s.beginImportJob("queue-doc", "paper.pdf", 10, nil)
	s.leeImportObservation("queue-doc", leeStageObservation{UserStage: "ocr", Detail: "等待 OCR 服务空位"})
	job, ok := s.loadImportJob(context.Background(), "queue-doc")
	if !ok || job.Status != "running" || job.stage("ocr").Status != "running" || job.stage("translate").Status != "pending" {
		t.Fatalf("queue wait must remain an active OCR job: %+v", job)
	}
	current, total := 1, 6
	s.leeImportObservation("queue-doc", leeStageObservation{
		UserStage: "translation", Detail: "翻译中", Current: &current, Total: &total, Unit: "batch",
	})
	job, _ = s.loadImportJob(context.Background(), "queue-doc")
	if job.stage("ocr").Status != "done" || job.stage("translate").Unit != "批" || job.stage("translate").Total != 6 {
		t.Fatalf("provider progress must retain its actual unit: %+v", job.Stages)
	}
	s.finishImportJob("queue-doc", "cancelled", "已取消")
	s.leeImportObservation("queue-doc", leeStageObservation{UserStage: "render", Detail: "late event"})
	job, _ = s.loadImportJob(context.Background(), "queue-doc")
	if job.Status != "cancelled" || job.stage("render").Status != "pending" {
		t.Fatal("late process output changed a cancelled job")
	}
}

func TestLeeUnclassifiedFailurePreservesConcreteCause(t *testing.T) {
	w := &leeImportLogWriter{sink: &bytes.Buffer{}}
	_, _ = w.Write([]byte(`structured failure json: {"failure_code":"python_unhandled_exception","summary":"任务失败，但暂未识别出明确根因","detail":"missing package: example","traceback":"private traceback"}` + "\n"))
	if w.failure != "missing package: example" {
		t.Fatalf("concrete failure cause was hidden: %q", w.failure)
	}
}
