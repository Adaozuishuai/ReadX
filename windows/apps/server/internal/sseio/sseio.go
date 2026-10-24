// Package sseio 统一所有 SSE 端点的写出机制。
//
// 此前本仓库有 9 处手写 emit 闭包（同一形态的 marshal + Fprintf + Flush）：
// ai.go 四份（chat :115、presentation-theme :191、presentation-plan :299、
// generate :480——唯一带互斥与心跳的）、latex_ai.go :145、latex_autofix.go :157、
// publications.go 两份（arxiv-pdf :697、import/url :900）、import_progress.go
// 的 importEvents（蓝本：互斥、2s 心跳、断连取消）。
//
// 本包收敛的是**机制**，不改任何线上协议：各端点的事件载荷与终止帧
// （{"error"} / {"done":true} / {"results"}）保持原样，前端零变化。
// Send 的签名与原闭包一致（func(payload any)），接入是逐字替换。
// 收敛后的共同收益：
//   - 全部写出互斥（原先只有 generate 的 writeMu 有）；
//   - 统一的断连检测（写失败即进入 broken 态，后续写静默跳过；OnBreak 回调
//     保留 importEvents「断连即取消上游」的语义）；
//   - 心跳一处实现（HeartbeatPayload 沿用各端点既有的心跳帧格式）。
//
// 例外：lee_import.go 的 OpenAI 风格桥（data: [DONE]，chunked JSON 行）服务
// LeePDF 运行时的外部客户端，协议属兼容面，刻意不迁入。
package sseio

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Writer 是并发安全的 SSE 写出器。零值不可用，必须经 Begin 创建。
type Writer struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	rc      *http.ResponseController
	onBreak []func()
	broken  bool
}

// Begin 设置 SSE 响应头并返回 Writer。与原各端点开头的三行 SetHeader 等价，
// 不发出任何额外帧（保持各端点现有首帧行为）。
func Begin(w http.ResponseWriter) *Writer {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	return &Writer{w: w, rc: http.NewResponseController(w)}
}

// OnBreak 注册断连回调：首次写失败/flush 失败时调用一次（importEvents 的
// cancel() 语义）。必须在首次 Send 之前注册。
func (s *Writer) OnBreak(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.broken {
		s.onBreak = append(s.onBreak, fn)
	}
}

func (s *Writer) breakLocked() {
	if s.broken {
		return
	}
	s.broken = true
	for _, fn := range s.onBreak {
		fn()
	}
}

// Send 写出一个数据帧。签名与原 emit 闭包一致（吞错误），因此接入是机械替换：
// emit := out.Send。写失败后进入 broken 态，后续 Send 静默跳过——上游可以继续
// 跑完（与原闭包行为一致），或用 Broken() 提前收工。
func (s *Writer) Send(payload any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.broken {
		return
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	if _, err := fmt.Fprintf(s.w, "data: %s\n\n", encoded); err != nil {
		s.breakLocked()
		return
	}
	if err := s.rc.Flush(); err != nil {
		s.breakLocked()
	}
}

// Broken 报告连接是否已不可写（可用于长任务提前收工；不调用也不影响正确性）。
func (s *Writer) Broken() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.broken
}

// HeartbeatPayload 周期发送数据帧心跳，帧内容由 fn 现场构造（沿用各端点既有
// 格式：generate 复述当前进度并带 "heartbeat":true，importEvents 发
// {"heartbeat":true}）。返回 stop；与原实现一致由调用方 defer。
// fn 返回 nil 时跳过该次心跳。
func (s *Writer) HeartbeatPayload(interval time.Duration, fn func() any) (stop func()) {
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if payload := fn(); payload != nil {
					s.Send(payload)
				}
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-stopped
		})
	}
}
