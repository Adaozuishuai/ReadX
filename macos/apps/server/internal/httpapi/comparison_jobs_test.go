package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// 本文件补上对照实验任务此前的零测试覆盖：契约形状（idle/completed）、
// 缺失文档、无 AI 配置时的快速失败、终态后可重跑、无任务时取消的 409。
// 取消/超时/TTL 清理的机制行为由 internal/tasks 的测试锁定。

func comparisonJobPath(key string) string {
	return "/v1/documents/" + key + "/comparison-experiment-job"
}

func decodeComparisonJob(t *testing.T, res *http.Response) comparisonExperimentJob {
	t.Helper()
	var job comparisonExperimentJob
	if err := json.NewDecoder(res.Body).Decode(&job); err != nil {
		t.Fatalf("解析任务响应失败: %v", err)
	}
	return job
}

func TestComparisonJobIdleForKnownDocAnd404ForMissing(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('c1','c1','Comparison paper')`); err != nil {
		t.Fatal(err)
	}
	res := do(t, frontend, http.MethodGet, comparisonJobPath("c1"), testToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d", res.StatusCode)
	}
	job := decodeComparisonJob(t, res)
	if job.Status != "idle" || job.Key != "c1" {
		t.Fatalf("无任务时应返回 idle: %+v", job)
	}
	if res := do(t, frontend, http.MethodGet, comparisonJobPath("missing"), testToken); res.StatusCode != http.StatusNotFound {
		t.Fatalf("缺失文档应 404, got %d", res.StatusCode)
	}
}

func TestComparisonJobCachedEntryReturnsCompleted(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('c2','c2','Cached comparison')`); err != nil {
		t.Fatal(err)
	}
	// comparisonExperiment 的值里 dataset 组是数组 → comparisonValueValid 为真
	valueJSON := `{"comparisonExperiment":{"value":"{\"dataset\":[{\"name\":\"MNIST\"}]}","updatedAt":"2026-01-01T00:00:00Z"}}`
	if _, err := handle.Exec(`INSERT INTO readings(document_id, value_json, updated_at) VALUES('c2', ?, 'old')`, valueJSON); err != nil {
		t.Fatal(err)
	}
	res := do(t, frontend, http.MethodGet, comparisonJobPath("c2"), testToken)
	job := decodeComparisonJob(t, res)
	if job.Status != "completed" || job.Percent != 100 || job.Message != "实验配置已保存" {
		t.Fatalf("缓存命中应返回 completed/100: %+v", job)
	}
}

func TestComparisonJobFailsFastWithoutAIConfigThenReruns(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('c3','c3','No config')`); err != nil {
		t.Fatal(err)
	}

	res := do(t, frontend, http.MethodPost, comparisonJobPath("c3"), testToken)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("发起任务应 202, got %d", res.StatusCode)
	}
	started := decodeComparisonJob(t, res)
	if started.Status != "running" || started.Percent < 1 {
		t.Fatalf("发起响应应为 running 且带初始进度: %+v", started)
	}

	// 测试环境没有可用的 AI 配置 → 任务快速失败（错误如实上屏，不编造）
	deadline := time.Now().Add(5 * time.Second)
	for {
		job := decodeComparisonJob(t, do(t, frontend, http.MethodGet, comparisonJobPath("c3"), testToken))
		if job.Status != "running" {
			if job.Status != "failed" || job.Error == "" {
				t.Fatalf("无 AI 配置应 failed 且带错误信息: %+v", job)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("任务未在期限内终态: %+v", job)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// 终态后可重跑（原「同 key 覆盖」语义）
	res = do(t, frontend, http.MethodPost, comparisonJobPath("c3"), testToken)
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("终态后重跑应 202, got %d", res.StatusCode)
	}
}

func TestComparisonJobCancelWithoutLiveJobIs409(t *testing.T) {
	frontend, handle, _ := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('c4','c4','Cancel target')`); err != nil {
		t.Fatal(err)
	}
	// 无任务时取消：与 LaTeX 编译一致的「已经不在运行中」语义
	if res := do(t, frontend, http.MethodDelete, comparisonJobPath("c4"), testToken); res.StatusCode != http.StatusConflict {
		t.Fatalf("无在途任务时取消应 409, got %d", res.StatusCode)
	}

	// 终态任务同样不可取消：先发起并等它因缺 AI 配置失败，再取消
	do(t, frontend, http.MethodPost, comparisonJobPath("c4"), testToken)
	deadline := time.Now().Add(5 * time.Second)
	for {
		job := decodeComparisonJob(t, do(t, frontend, http.MethodGet, comparisonJobPath("c4"), testToken))
		if job.Status != "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("任务未在期限内终态")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if res := do(t, frontend, http.MethodDelete, comparisonJobPath("c4"), testToken); res.StatusCode != http.StatusConflict {
		t.Fatalf("终态任务取消应 409, got %d", res.StatusCode)
	}
}
