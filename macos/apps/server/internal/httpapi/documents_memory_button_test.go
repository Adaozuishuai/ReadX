package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"cbctv2/server/internal/db"
)

// 「处理」按钮以 paperMemoryStatus !== 'done' 点亮（LibraryCard/LibraryScreen 三处）。
// 重新翻译把记忆阶段标成 skipped（复用已有记忆）——skipped 必须不外露，
// 否则任务早已终态、按钮却永远显示。普通导入在 AI 未就绪时跳过记忆同理。
func TestDocumentsListHidesSkippedPaperMemory(t *testing.T) {
	cfg := defaultTestConfig(t.TempDir())
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	s := New(cfg, handle)
	t.Cleanup(func() { s.comparisonJobs.Close() })
	frontend := httptest.NewServer(s.Handler())
	t.Cleanup(frontend.Close)

	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('m1','m1','Memory paper')`); err != nil {
		t.Fatal(err)
	}
	cancel := func() {}
	s.beginImportJob("retranslate-x", "Memory paper（重新翻译）", 3, cancel)
	s.linkImportJobDocument("retranslate-x", "m1")
	s.jobStage("retranslate-x", "memory", "skipped", "复用书库中已有论文记忆", -1, -1)

	fetch := func() map[string]any {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, frontend.URL+"/v1/documents", nil)
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
		res, err := frontend.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var payload struct {
			Documents []struct {
				Key               string `json:"key"`
				PaperMemoryStatus string `json:"paperMemoryStatus"`
			} `json:"documents"`
		}
		if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		for _, doc := range payload.Documents {
			if doc.Key == "m1" {
				return map[string]any{"paperMemoryStatus": doc.PaperMemoryStatus}
			}
		}
		t.Fatal("文档列表里找不到 m1")
		return nil
	}

	if got := fetch()["paperMemoryStatus"]; got != "" {
		t.Fatalf("skipped 的记忆阶段不应外露 paperMemoryStatus（按钮会卡住常亮）, got %q", got)
	}

	// 对照：running 状态正常外露（这时按钮该亮，用户要看进度）
	s.jobStage("retranslate-x", "memory", "running", "正在准备论文记忆", 0, 1)
	if got := fetch()["paperMemoryStatus"]; got != "running" {
		t.Fatalf("running 的记忆阶段应外露, got %q", got)
	}
}
