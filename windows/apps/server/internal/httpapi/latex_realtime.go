package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"cbctv2/server/internal/config"
	"cbctv2/server/internal/latex"
)

type latexRealtimeSession struct {
	projectID, src string
	process        *latex.RealtimeProcess
}

func (s *Server) handleLatexRealtimeRuntime(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		if err := latex.InstallRealtime(r.Context(), s.cfg.DataRoot); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
	}
	writeJSON(w, http.StatusOK, latex.DetectRealtime(r.Context(), s.cfg.DataRoot))
}

func (s *Server) handleLatexRealtime(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	service := s.latexService()
	project, err := service.Get(r.Context(), id)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	if project.Engine != "lualatex" {
		writeError(w, http.StatusBadRequest, "rtex 实时预览需要将项目引擎设为 LuaLaTeX。")
		return
	}
	rt := latex.DetectRealtime(r.Context(), s.cfg.DataRoot)
	if !rt.Ready {
		writeError(w, http.StatusServiceUnavailable, rt.Reason)
		return
	}
	src, err := service.SrcDir(id)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	main, err := latex.NormalizeRelative(project.MainFile)
	if err != nil {
		writeLatexError(w, err)
		return
	}
	if _, err = latex.ResolveUnder(src, main); err != nil {
		writeLatexError(w, err)
		return
	}
	token, err := config.NewToken()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	build, err := service.BuildDir(id, "realtime-"+token[:16])
	if err != nil {
		writeLatexError(w, err)
		return
	}
	process, err := latex.StartRealtime(rt, src, main, build)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.realtimeMu.Lock()
	if s.realtimeSessions == nil {
		s.realtimeSessions = make(map[string]*latexRealtimeSession)
	}
	s.realtimeSessions[token] = &latexRealtimeSession{projectID: id, src: src, process: process}
	s.realtimeMu.Unlock()
	defer func() {
		s.realtimeMu.Lock()
		delete(s.realtimeSessions, token)
		s.realtimeMu.Unlock()
		process.Close()
		os.RemoveAll(build) // Server-generated per-session build directory; source is elsewhere.
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}
	send := func(v any) bool {
		data, e := json.Marshal(v)
		if e != nil {
			return false
		}
		_, e = fmt.Fprintf(w, "data: %s\n\n", data)
		flusher.Flush()
		return e == nil
	}
	if !send(map[string]any{"event": "ReadXReady", "sessionId": token}) {
		return
	}
	keepAlive := time.NewTicker(15 * time.Second)
	defer keepAlive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case line, open := <-process.Events:
			if !open {
				send(map[string]any{"event": "ReadXError", "message": "实时预览已停止。" + process.Log()})
				return
			}
			if !send(line) {
				return
			}
		case <-keepAlive.C:
			if _, e := fmt.Fprint(w, ": keepalive\n\n"); e != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (s *Server) handleLatexRealtimeEdit(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
		Cmd       string `json:"cmd"`
		Path      string `json:"path"`
		Text      string `json:"text"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 50<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "无效的实时编辑请求: "+err.Error())
		return
	}
	s.realtimeMu.Lock()
	session := s.realtimeSessions[body.SessionID]
	s.realtimeMu.Unlock()
	if session == nil || session.projectID != r.PathValue("id") {
		writeError(w, http.StatusConflict, "实时预览会话已结束，请重新开启。")
		return
	}
	command := map[string]any{"cmd": "request_layout"}
	if body.Cmd != "request_layout" {
		if body.Cmd != "" && body.Cmd != "set_document" {
			writeError(w, 400, "不支持的实时编辑命令")
			return
		}
		if len(body.Text) > latex.MaxFileBytes || !utf8.ValidString(body.Text) {
			writeError(w, http.StatusRequestEntityTooLarge, "源码超过 8 MiB 或不是 UTF-8")
			return
		}
		rel, err := latex.NormalizeRelative(body.Path)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		if !strings.Contains("|.tex|.sty|.cls|.bib|.ltx|.cfg|.def|", "|"+strings.ToLower(filepath.Ext(rel))+"|") {
			writeError(w, 400, "实时编辑仅接收 LaTeX 源文件")
			return
		}
		if _, err = latex.ResolveUnder(session.src, rel); err != nil {
			writeLatexError(w, err)
			return
		}
		command = map[string]any{"cmd": "set_document", "path": rel, "text": body.Text}
	}
	if err := session.process.Send(command); err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

// CloseRealtime releases child engines before HTTP shutdown waits for streaming requests.
func (s *Server) CloseRealtime() {
	s.realtimeMu.Lock()
	sessions := make([]*latex.RealtimeProcess, 0, len(s.realtimeSessions))
	for _, session := range s.realtimeSessions {
		sessions = append(sessions, session.process)
	}
	s.realtimeMu.Unlock()
	for _, process := range sessions {
		process.Close()
	}
}
