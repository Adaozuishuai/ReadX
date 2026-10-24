package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"cbctv2/server/internal/booksources"
)

func (s *Server) handleZLibraryConnection(w http.ResponseWriter, r *http.Request) {
	s.sourceRegistry()
	if s.zLibrary == nil {
		writeError(w, 503, "Z-Library 适配器不可用")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var status booksources.ZLibraryStatus
	var err error
	decode := func(body any) bool {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
		d.DisallowUnknownFields()
		if d.Decode(body) != nil {
			writeError(w, 400, "Z-Library 参数无效")
			return false
		}
		return true
	}
	switch r.Method {
	case http.MethodGet:
		status = s.zLibrary.Status()
	case http.MethodPut:
		var cfg booksources.ZLibraryConfig
		if !decode(&cfg) {
			return
		}
		status, err = s.zLibrary.Configure(ctx, cfg)
	case http.MethodPost:
		var login booksources.ZLibraryLogin
		if !decode(&login) {
			return
		}
		status, err = s.zLibrary.Connect(ctx, login)
	case http.MethodDelete:
		status = s.zLibrary.Disconnect()
	}
	if err != nil {
		sourceError(w, err)
		return
	}
	if r.Method != http.MethodGet {
		s.bookSources.CancelProvider("zlibrary")
	}
	writeJSON(w, 200, status)
}
func (s *Server) handleZLibraryProbe(w http.ResponseWriter, r *http.Request) {
	s.sourceRegistry()
	if s.zLibrary == nil {
		writeError(w, 503, "Z-Library 适配器不可用")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	status, err := s.zLibrary.Probe(ctx)
	if err != nil {
		sourceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, status)
}
func (s *Server) handleZLibraryCover(w http.ResponseWriter, r *http.Request) {
	s.sourceRegistry()
	if s.zLibrary == nil {
		writeError(w, 503, "Z-Library 适配器不可用")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	data, mime, err := s.zLibrary.Cover(ctx, r.PathValue("id"))
	if err != nil {
		sourceError(w, err)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = w.Write(data)
}
