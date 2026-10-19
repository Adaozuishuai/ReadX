package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
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
func importEvents(w http.ResponseWriter, r *http.Request, cancel context.CancelFunc) (func(importProgress), func([]importResult), func()) {
	if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		return func(importProgress) {}, func(results []importResult) { writeJSON(w, 200, map[string]any{"results": results}) }, func() {}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	var mu sync.Mutex
	emit := func(value any) {
		mu.Lock()
		defer mu.Unlock()
		if r.Context().Err() != nil {
			return
		}
		encoded, _ := json.Marshal(value)
		if _, err := fmt.Fprintf(w, "data: %s\n\n", encoded); err != nil {
			cancel()
			return
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			cancel()
		}
	}
	done, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-r.Context().Done():
				return
			case <-ticker.C:
				emit(map[string]any{"heartbeat": true})
			}
		}
	}()
	return func(progress importProgress) { emit(map[string]any{"progress": progress}) },
		func(results []importResult) { emit(map[string]any{"results": results}) },
		func() { close(done); <-stopped }
}
