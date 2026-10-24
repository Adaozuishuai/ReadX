package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"cbctv2/server/internal/sseio"
)

type importProgress struct {
	Stage     string `json:"stage"`
	Message   string `json:"message"`
	Name      string `json:"name,omitempty"`
	File      int    `json:"file,omitempty"`
	Files     int    `json:"files,omitempty"`
	Completed int    `json:"completed"`
	Total     int    `json:"total"`
	// JobKey 让前端在文件刚进篮筐时就打开任务面板并轮询 /job（OCR/翻译/渲染）。
	JobKey string `json:"jobKey,omitempty"`
}

// JSON remains available to existing clients. SSE carries real work counters;
// heartbeats only confirm the connection is alive and never advance progress.
//
// 写出机制收敛进 sseio（互斥、断连检测、心跳）；本函数保留的只有端点专属的两件事：
// Accept 协商的 JSON 降级，与「断连即 cancel 上游导入」的挂接（OnBreak）。
func importEvents(w http.ResponseWriter, r *http.Request, cancel context.CancelFunc) (func(importProgress), func([]importResult), func()) {
	if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		return func(importProgress) {}, func(results []importResult) { writeJSON(w, 200, map[string]any{"results": results}) }, func() {}
	}
	out := sseio.Begin(w)
	out.OnBreak(cancel)
	stopHeartbeat := out.HeartbeatPayload(2*time.Second, func() any { return map[string]any{"heartbeat": true} })
	return func(progress importProgress) { out.Send(map[string]any{"progress": progress}) },
		func(results []importResult) { out.Send(map[string]any{"results": results}) },
		stopHeartbeat
}
