package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestStatsReportsLibraryReadingAndProcessing(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	for _, row := range []struct{ key, status string }{
		{"a", "reading"}, {"b", "done"}, {"c", "queue"}, {"gone", "done"},
	} {
		if _, err := handle.Exec(
			`INSERT INTO documents(id,key,title,status,year) VALUES(?,?,?,?,2021)`,
			row.key, row.key, "Paper "+row.key, row.status); err != nil {
			t.Fatal(err)
		}
	}
	stamp := "2026-10-20T10:00:00Z"
	if _, err := handle.Exec(
		`INSERT INTO reading_locations(document_id,location_json,updated_at) VALUES('a','{"kind":"pdf","page":3}',?)`, stamp); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(
		`INSERT INTO annotations(id,document_id,page,kind,quote,created_at,updated_at) VALUES('x','a',3,'highlight','quote',?,?)`,
		stamp, stamp); err != nil {
		t.Fatal(err)
	}
	// 回收站里的论文不进统计分母，但要在 trashed 里如实计数。
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES('documents.meta',?)`,
		`{"gone":{"deleted":true},"a":{"favorite":true,"categories":["CBCT"],"tags":["sparse"]}}`); err != nil {
		t.Fatal(err)
	}
	// 一次带阶段时间戳的处理任务 + 一次不带的老任务。
	job := `{"key":"a","name":"Paper a","status":"done","startedAt":"2026-10-20T09:00:00Z","updatedAt":"2026-10-20T09:10:00Z","pages":10,
	 "stages":[
	   {"key":"ocr","label":"OCR","status":"done","startedAt":"2026-10-20T09:00:00Z","finishedAt":"2026-10-20T09:05:00Z"},
	   {"key":"translate","label":"翻译","status":"done","startedAt":"2026-10-20T09:05:00Z","finishedAt":"2026-10-20T09:10:00Z"}],
	 "runs":[{"id":"r1","startedAt":"2026-10-20T09:00:00Z","finishedAt":"2026-10-20T09:10:00Z","status":"done","pages":10}]}`
	legacy := `{"key":"b","name":"Paper b","status":"done","startedAt":"2026-10-19T09:00:00Z","updatedAt":"2026-10-19T09:10:00Z","pages":4,
	 "stages":[{"key":"ocr","label":"OCR","status":"done"}],
	 "runs":[{"id":"r2","startedAt":"2026-10-19T09:00:00Z","finishedAt":"2026-10-19T09:02:00Z","status":"failed","pages":4}]}`
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES(?,?),(?,?)`,
		jobDocumentPrefix+"a", job, jobDocumentPrefix+"b", legacy); err != nil {
		t.Fatal(err)
	}

	response := do(t, frontend, http.MethodGet, "/v1/stats", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("统计返回 %d：%s", response.StatusCode, body)
	}
	var payload struct {
		Library struct {
			Total, Active, Reading, Done, Queue, Favorite, Trashed, Shelves int
		} `json:"library"`
		Reading struct {
			Located, ActiveWeek, ActiveMonth, Annotations int
		} `json:"reading"`
		Processing struct {
			Jobs, Runs, FailedRuns, Pages, MissingStageTiming int
			TotalRunMs, MedianRunMs                           int64
			Stages                                            []struct {
				Key      string `json:"key"`
				Runs     int    `json:"runs"`
				TotalMs  int64  `json:"totalMs"`
				MedianMs int64  `json:"medianMs"`
			} `json:"stages"`
		} `json:"processing"`
		Distribution struct {
			Years []struct {
				Name  string
				Count int
			} `json:"years"`
			Shelves []struct {
				Name  string
				Count int
			} `json:"shelves"`
		} `json:"distribution"`
		Basis []string `json:"basis"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}

	if payload.Library.Total != 4 || payload.Library.Active != 3 || payload.Library.Trashed != 1 {
		t.Fatalf("书库计数不对：%+v", payload.Library)
	}
	// 回收站里那篇是 done：状态桶与收藏数都不许把它算进去，
	// 否则「正在阅读 N 篇」会和同屏的「在库 M 篇」对不上。
	if payload.Library.Reading != 1 || payload.Library.Done != 1 || payload.Library.Queue != 1 || payload.Library.Favorite != 1 {
		t.Fatalf("状态桶含回收站论文：%+v", payload.Library)
	}
	if payload.Reading.Located != 1 || payload.Reading.Annotations != 1 {
		t.Fatalf("阅读活跃度不对：%+v", payload.Reading)
	}
	if payload.Processing.Jobs != 2 || payload.Processing.Runs != 2 || payload.Processing.FailedRuns != 1 {
		t.Fatalf("处理任务计数不对：%+v", payload.Processing)
	}
	if payload.Processing.TotalRunMs != 720000 {
		t.Fatalf("执行总耗时 = %d ms，期望 720000", payload.Processing.TotalRunMs)
	}
	// 老任务有阶段但缺时间戳：必须单独计数，不能拿总耗时去摊派。
	if payload.Processing.MissingStageTiming != 0 {
		t.Fatalf("missingStageTiming 只统计「开始了却没结束」的阶段，得到 %d", payload.Processing.MissingStageTiming)
	}
	byKey := map[string]int64{}
	for _, stage := range payload.Processing.Stages {
		byKey[stage.Key] = stage.TotalMs
	}
	if byKey["ocr"] != 300000 || byKey["translate"] != 300000 {
		t.Fatalf("阶段耗时不对：%+v", payload.Processing.Stages)
	}
	if len(payload.Distribution.Years) != 1 || payload.Distribution.Years[0].Count != 4 {
		t.Fatalf("年份分布不对：%+v", payload.Distribution.Years)
	}
	if len(payload.Distribution.Shelves) != 1 || payload.Distribution.Shelves[0].Name != "CBCT" {
		t.Fatalf("书架分布不对：%+v", payload.Distribution.Shelves)
	}
	if len(payload.Basis) == 0 {
		t.Fatal("统计必须带上口径说明")
	}
}

// 现代流程把「文档 → 任务」存成任务编号字符串（linkImportJobDocument），任务本体在
// import-job:<编号>。统计必须跟着这个指针走：只读索引会把字符串当成坏快照跳过，
// 于是真实使用里一个阶段耗时都统计不到（种子数据用的是旧的对象形态，所以测不出来）。
func TestStatsFollowsDocumentJobPointer(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	server := New(cfg, handle)
	job := `{"key":"retranslate-x","name":"Paper a（重新翻译）","status":"failed","pages":2,
	 "stages":[
	   {"key":"ocr","label":"OCR","status":"done","startedAt":"2026-10-20T09:00:00Z","finishedAt":"2026-10-20T09:05:00Z"},
	   {"key":"translate","label":"翻译","status":"failed","startedAt":"2026-10-20T09:05:00Z","finishedAt":"2026-10-20T09:06:00Z"}],
	 "runs":[{"id":"r1","startedAt":"2026-10-20T09:00:00Z","finishedAt":"2026-10-20T09:06:00Z","status":"failed","pages":2}]}`
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES(?,?)`, jobStatePrefix+"retranslate-x", job); err != nil {
		t.Fatal(err)
	}
	server.linkImportJobDocument("retranslate-x", "doc-a")
	// 同一任务在旧形态里还会以整对象出现在索引上：只能算一次，不能重复计数。
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES(?,?)`, jobDocumentPrefix+"doc-a-legacy", job); err != nil {
		t.Fatal(err)
	}

	response := do(t, frontend, http.MethodGet, "/v1/stats", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("统计返回 %d：%s", response.StatusCode, body)
	}
	var payload struct {
		Processing struct {
			Jobs, Runs int
			Stages     []struct {
				Key     string `json:"key"`
				Runs    int    `json:"runs"`
				TotalMs int64  `json:"totalMs"`
			} `json:"stages"`
		} `json:"processing"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Processing.Jobs != 1 || payload.Processing.Runs != 1 {
		t.Fatalf("同一任务在两种键下只应算一次：%+v", payload.Processing)
	}
	byKey := map[string]int64{}
	runsByKey := map[string]int{}
	for _, stage := range payload.Processing.Stages {
		byKey[stage.Key] = stage.TotalMs
		runsByKey[stage.Key] = stage.Runs
	}
	if byKey["ocr"] != 300000 || byKey["translate"] != 60000 {
		t.Fatalf("跟随指针后阶段耗时应完整：%+v", payload.Processing.Stages)
	}
	if runsByKey["ocr"] != 1 || runsByKey["translate"] != 1 {
		t.Fatalf("阶段次数不对：%+v", payload.Processing.Stages)
	}
}

func TestSetStageStampsTimingOnce(t *testing.T) {
	job := newDocumentJob("k", "name", 3)
	// 进度回报会反复以 running 调用 setStage：开始时间只能盖一次。
	job.setStage("ocr", "running", "第一步", 1, 3)
	first := job.stage("ocr").StartedAt
	if first == "" {
		t.Fatal("转 running 时应记下 StartedAt")
	}
	job.setStage("ocr", "running", "第二步", 2, 3)
	if job.stage("ocr").StartedAt != first {
		t.Fatalf("重复 running 不应改写 StartedAt：%q -> %q", first, job.stage("ocr").StartedAt)
	}
	if job.stage("ocr").FinishedAt != "" {
		t.Fatal("未进终态不应有 FinishedAt")
	}
	job.setStage("ocr", "done", "完成", 3, 3)
	if job.stage("ocr").FinishedAt == "" {
		t.Fatal("进终态应记下 FinishedAt")
	}
	finished := job.stage("ocr").FinishedAt
	job.setStage("ocr", "done", "完成", 3, 3)
	if job.stage("ocr").FinishedAt != finished {
		t.Fatal("重复终态不应改写 FinishedAt")
	}
}
