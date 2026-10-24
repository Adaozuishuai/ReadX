package sseio

import (
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newWriter() (*Writer, *httptest.ResponseRecorder) {
	rec := httptest.NewRecorder()
	return Begin(rec), rec
}

// 机制收敛的验证基础：帧格式与原闭包逐字节一致（data: <json>\n\n）。
func TestSendFrameMatchesLegacyEmit(t *testing.T) {
	s, rec := newWriter()
	s.Send(map[string]any{"delta": "hi"})
	s.Send(map[string]any{"done": true, "text": "hi"})
	body := rec.Body.String()
	if body != "data: {\"delta\":\"hi\"}\n\ndata: {\"done\":true,\"text\":\"hi\"}\n\n" {
		t.Fatalf("帧格式与原实现不一致:\n%q", body)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("X-Accel-Buffering") != "no" {
		t.Fatal("SSE 响应头缺失")
	}
}

// 原先 9 处闭包只有 generate 有互斥——现在全部有。
func TestConcurrentSendNeverInterleaves(t *testing.T) {
	s, rec := newWriter()
	const n = 64
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.Send(map[string]any{"tick": "0123456789"})
		}()
	}
	wg.Wait()
	frames := strings.Split(strings.TrimRight(rec.Body.String(), "\n\n"), "\n\n")
	if len(frames) != n {
		t.Fatalf("帧数 = %d, want %d", len(frames), n)
	}
	for _, f := range frames {
		if f != "data: {\"tick\":\"0123456789\"}" {
			t.Fatalf("交错或残缺帧: %q", f)
		}
	}
}

// failingRecorder 让 Write 从第 failAt 次起失败。
type failingRecorder struct {
	*httptest.ResponseRecorder
	writes atomic.Int32
	failAt int32
}

func (r *failingRecorder) Write(p []byte) (int, error) {
	if r.writes.Add(1) > r.failAt {
		return 0, errConnectionReset
	}
	return r.ResponseRecorder.Write(p)
}

type constError string

func (e constError) Error() string { return string(e) }

var errConnectionReset = constError("connection reset")

func TestBreakOnWriteFailureFiresOnceAndSilences(t *testing.T) {
	rec := &failingRecorder{ResponseRecorder: httptest.NewRecorder(), failAt: 1}
	s := Begin(rec)
	breaks := make(chan struct{}, 4)
	s.OnBreak(func() { breaks <- struct{}{} })
	s.Send(map[string]any{"first": true})  // 成功（第 1 次写）
	s.Send(map[string]any{"second": true}) // 失败 → broken
	s.Send(map[string]any{"third": true})  // 静默跳过
	select {
	case <-breaks:
	default:
		t.Fatal("写失败应触发一次 OnBreak")
	}
	select {
	case <-breaks:
		t.Fatal("OnBreak 只应触发一次")
	default:
	}
	if !s.Broken() {
		t.Fatal("Broken 应为 true")
	}
}

func TestHeartbeatPayloadUsesCallerFrame(t *testing.T) {
	s, rec := newWriter()
	var ticks atomic.Int32
	stop := s.HeartbeatPayload(5*time.Millisecond, func() any {
		ticks.Add(1)
		return map[string]any{"heartbeat": true, "n": ticks.Load()}
	})
	time.Sleep(35 * time.Millisecond)
	stop()
	before := strings.Count(rec.Body.String(), "heartbeat")
	if before == 0 {
		t.Fatal("心跳帧未发出")
	}
	time.Sleep(25 * time.Millisecond)
	if after := strings.Count(rec.Body.String(), "heartbeat"); after != before {
		t.Fatalf("stop() 后心跳仍在发送: %d -> %d", before, after)
	}
	// 心跳帧沿用调用方格式（importEvents 风格）
	if !strings.Contains(rec.Body.String(), `data: {"heartbeat":true,"n":1}`) {
		t.Fatalf("心跳帧格式不符:\n%s", rec.Body.String())
	}
}

func TestHeartbeatPayloadSkipsNil(t *testing.T) {
	s, rec := newWriter()
	stop := s.HeartbeatPayload(5*time.Millisecond, func() any { return nil })
	time.Sleep(25 * time.Millisecond)
	stop()
	if rec.Body.Len() != 0 {
		t.Fatalf("nil 心跳载荷不应发送任何帧: %q", rec.Body.String())
	}
}
