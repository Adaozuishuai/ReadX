package tasks

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// memStore 是 Store 的内存实现，兼作调用记录器。
type memStore struct {
	mu    sync.Mutex
	saved []Snapshot
	calls int
	dels  []string
}

func (m *memStore) Save(s Snapshot) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	for i, old := range m.saved {
		if old.ID == s.ID {
			m.saved[i] = s
			return
		}
	}
	m.saved = append(m.saved, s)
}
func (m *memStore) Delete(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.dels = append(m.dels, id)
}
func (m *memStore) LoadAll() []Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Snapshot(nil), m.saved...)
}

func waitFor(t *testing.T, r *Registry, id string, timeout time.Duration) Snapshot {
	t.Helper()
	deadline := time.After(timeout)
	for {
		if done := r.Done(id); done != nil {
			select {
			case <-done:
				snap, _ := r.Get(id)
				return snap
			case <-deadline:
				t.Fatalf("任务 %s 在 %s 内未终态", id, timeout)
			}
		}
		select {
		case <-deadline:
			t.Fatalf("任务 %s 在 %s 内未终态", id, timeout)
		case <-time.After(2 * time.Millisecond):
		}
	}
}

func TestRunToSuccessWithProgressAndStore(t *testing.T) {
	store := &memStore{}
	r := New(Options{Kind: "import"}, store)
	defer r.Close()
	snap, err := r.Submit("job-1", func(ctx context.Context, report func(int, string)) error {
		report(30, "翻译第 3/10 页")
		return nil
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if snap.State != Queued {
		t.Fatalf("初始状态 = %s, want queued", snap.State)
	}
	final := waitFor(t, r, "job-1", time.Second)
	if final.State != Succeeded || final.Progress != "翻译第 3/10 页" || final.Percent != 30 {
		t.Fatalf("终态 = %+v", final)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.calls < 3 {
		t.Fatalf("Store.Save 调用过少: %d 次", store.calls)
	}
}

func waitRunning(t *testing.T, r *Registry, id string) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		snap, ok := r.Get(id)
		if ok && snap.State == Running {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("任务 %s 未进入 running", id)
		case <-time.After(2 * time.Millisecond):
		}
	}
}

func TestCancelIsTerminalAndWorkerCannotOverwrite(t *testing.T) {
	r := New(Options{Kind: "download"}, nil)
	defer r.Close()
	workerReturned := make(chan struct{})
	r.Submit("dl-1", func(ctx context.Context, report func(int, string)) error {
		<-ctx.Done() // 模拟响应取消的 worker
		close(workerReturned)
		return errors.New("worker 迟到的失败") // 终态生效后到达，不得覆盖 Cancelled
	})
	waitRunning(t, r, "dl-1")
	if !r.Cancel("dl-1") {
		t.Fatal("取消在途任务应返回 true")
	}
	<-workerReturned
	final := waitFor(t, r, "dl-1", time.Second)
	if final.State != Cancelled {
		t.Fatalf("终态 = %s, want cancelled（worker 回写不得覆盖）", final.State)
	}
	if r.Cancel("dl-1") {
		t.Fatal("取消已终态任务应返回 false")
	}
}

func TestTimeoutFailsTask(t *testing.T) {
	r := New(Options{Kind: "build", Timeout: 30 * time.Millisecond}, nil)
	defer r.Close()
	r.Submit("b-1", func(ctx context.Context, report func(int, string)) error {
		time.Sleep(500 * time.Millisecond) // 忽略 ctx 的慢 worker 也会被硬超时终结
		return nil
	})
	final := waitFor(t, r, "b-1", time.Second)
	if final.State != Failed {
		t.Fatalf("终态 = %s, want failed", final.State)
	}
	if final.Error == "" {
		t.Fatal("超时错误信息不应为空")
	}
}

func TestQueuedTaskExpiresWhileSlotIsStillOccupied(t *testing.T) {
	r := New(Options{MaxActive: 1, Timeout: 40 * time.Millisecond}, nil)
	defer r.Close()
	blocked := make(chan struct{})
	defer close(blocked)
	_, err := r.Submit("slow-cleanup", func(ctx context.Context, _ func(int, string)) error {
		<-ctx.Done()
		<-blocked
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	waitRunning(t, r, "slow-cleanup")
	waitFor(t, r, "slow-cleanup", time.Second)
	_, err = r.Submit("waiting", func(context.Context, func(int, string)) error {
		t.Error("expired queued task must not execute")
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	snap := waitFor(t, r, "waiting", time.Second)
	if snap.State != Failed || !snap.StartedAt.IsZero() {
		t.Fatalf("queued deadline was not enforced: %+v", snap)
	}
}

func TestSubmitDeduplicatesLiveIDAndRerunsTerminalID(t *testing.T) {
	r := New(Options{Kind: "download"}, nil)
	defer r.Close()
	block := make(chan struct{})
	started := make(chan struct{})
	r.Submit("same", func(ctx context.Context, report func(int, string)) error {
		close(started)
		<-block
		return nil
	})
	<-started
	second, err := r.Submit("same", func(ctx context.Context, report func(int, string)) error {
		t.Fatal("进行中任务被复用，第二个 run 不应执行")
		return nil
	})
	if err != nil {
		t.Fatalf("复用提交失败: %v", err)
	}
	if second.ID != "same" {
		t.Fatalf("应复用同 id: %+v", second)
	}
	close(block)
	waitFor(t, r, "same", time.Second)

	// 终态后同 id 可重跑
	third, err := r.Submit("same", func(ctx context.Context, report func(int, string)) error { return nil })
	if err != nil {
		t.Fatalf("重跑提交失败: %v", err)
	}
	if third.ID != "same" {
		t.Fatalf("重跑 id = %s", third.ID)
	}
	waitFor(t, r, "same", time.Second)
}

func TestCapacityEvictsTerminalThenBusy(t *testing.T) {
	store := &memStore{}
	r := New(Options{Kind: "dl", Capacity: 2, TTL: time.Hour}, store) // TTL 拉长，只考察容量驱逐
	defer r.Close()
	r.Submit("a", func(ctx context.Context, report func(int, string)) error { return nil })
	waitFor(t, r, "a", time.Second)
	r.Submit("b", func(ctx context.Context, report func(int, string)) error { return nil })
	waitFor(t, r, "b", time.Second)

	// 容量 2 已满，但 a/b 均终态 → 驱逐最旧的 a
	if _, err := r.Submit("c", func(ctx context.Context, report func(int, string)) error { return nil }); err != nil {
		t.Fatalf("应驱逐终态后放行: %v", err)
	}
	waitFor(t, r, "c", time.Second)
	if _, still := r.Get("a"); still {
		t.Fatal("最旧终态任务 a 应被驱逐")
	}
	store.mu.Lock()
	if len(store.dels) == 0 {
		store.mu.Unlock()
		t.Fatal("驱逐应同步调用 Store.Delete")
	}
	store.mu.Unlock()

	// 两个长期占用槽位的活跃任务占满容量 → 满
	block := make(chan struct{})
	defer close(block)
	for _, id := range []string{"d", "e"} {
		r.Submit(id, func(ctx context.Context, report func(int, string)) error {
			<-block
			return nil
		})
	}
	waitRunning(t, r, "d")
	waitRunning(t, r, "e")
	if _, err := r.Submit("f", func(ctx context.Context, report func(int, string)) error { return nil }); !errors.Is(err, ErrBusy) {
		t.Fatalf("活跃任务满时应返回 ErrBusy, got %v", err)
	}
}

func TestTTLCleanupRemovesExpiredTerminal(t *testing.T) {
	store := &memStore{}
	r := New(Options{Kind: "dl", Capacity: 10, TTL: 40 * time.Millisecond}, store)
	defer r.Close()
	r.Submit("gone", func(ctx context.Context, report func(int, string)) error { return nil })
	waitFor(t, r, "gone", time.Second)

	deadline := time.After(2 * time.Second)
	for {
		if _, ok := r.Get("gone"); !ok {
			break // TTL 清理已移除 —— 原 comparison_jobs 从不清理，这里是修复点
		}
		select {
		case <-deadline:
			t.Fatal("终态任务未被 TTL 清理（泄漏语义未修复）")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestRestartMarksNonTerminalAsInterrupted(t *testing.T) {
	store := &memStore{}
	store.Save(Snapshot{ID: "old-live", Kind: "import", State: Running})
	store.Save(Snapshot{ID: "old-done", Kind: "import", State: Succeeded})
	r := New(Options{Kind: "import"}, store)
	defer r.Close()
	live, ok := r.Get("old-live")
	if !ok || live.State != Failed || live.Error == "" {
		t.Fatalf("重启后非终态任务应改判 Failed(中断): %+v", live)
	}
	if done, ok := r.Get("old-done"); !ok || done.State != Succeeded {
		t.Fatalf("重启后终态任务应原样读回: %+v", done)
	}
}

func TestCloseCancelsLiveTasks(t *testing.T) {
	r := New(Options{Kind: "x"}, nil)
	ended := make(chan struct{})
	r.Submit("live", func(ctx context.Context, report func(int, string)) error {
		<-ctx.Done()
		close(ended)
		return ctx.Err()
	})
	waitRunning(t, r, "live")
	r.Close()
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatal("Close 应取消在途任务")
	}
	waitFor(t, r, "live", time.Second)
	if _, err := r.Submit("after-close", func(ctx context.Context, report func(int, string)) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("关闭后提交应返回 ErrClosed, got %v", err)
	}
}

func TestConcurrentSubmitAllComplete(t *testing.T) {
	r := New(Options{Kind: "bulk", MaxActive: 4, Capacity: 64}, nil)
	defer r.Close()
	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmtID(i)
			if _, err := r.Submit(id, func(ctx context.Context, report func(int, string)) error {
				time.Sleep(time.Millisecond)
				return nil
			}); err != nil {
				t.Errorf("Submit(%s): %v", id, err)
			}
		}(i)
	}
	wg.Wait()
	deadline := time.After(2 * time.Second)
	for {
		if allDone(t, r, n) {
			return
		}
		select {
		case <-deadline:
			t.Fatal("并发任务未全部完成")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func fmtID(i int) string {
	return "t" + string(rune('a'+i%26)) + string(rune('a'+i/26))
}

func allDone(t *testing.T, r *Registry, n int) bool {
	t.Helper()
	for i := 0; i < n; i++ {
		snap, ok := r.Get(fmtID(i))
		if !ok || snap.State != Succeeded {
			return false
		}
	}
	return true
}
