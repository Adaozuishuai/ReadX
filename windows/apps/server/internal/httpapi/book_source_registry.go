package httpapi

import (
	"encoding/json"
	"mime"
	"net/http"
	"path/filepath"
	"time"

	"cbctv2/server/internal/booksources"
)

func (s *Server) sourceRegistry() *booksources.Registry {
	s.bookSourcesOnce.Do(func() {
		s.zLibrary = booksources.NewZLibrary(filepath.Join(s.cfg.DataRoot, "app", "config", "zlibrary.json"), sourceProxyFromEnvironment)
		s.bookSources = booksources.New(filepath.Join(s.cfg.DataRoot, "cache", "book-downloads"), booksources.DefaultProvidersWithZLibrary(sourceProxyFromEnvironment, s.zLibrary)...)
	})
	return s.bookSources
}
func sourceError(w http.ResponseWriter, err error) {
	e := booksources.PublicError(err)
	writeJSON(w, e.Status, e)
}
func (s *Server) handleBookSources(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"sources": s.sourceRegistry().Sources()})
}
func (s *Server) handleSourceSearch(w http.ResponseWriter, r *http.Request) {
	out, err := s.sourceRegistry().Search(r.Context(), r.PathValue("provider"), r.URL.Query().Get("q"), r.URL.Query().Get("cursor"))
	if err != nil {
		sourceError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func (s *Server) handleSourceDetail(w http.ResponseWriter, r *http.Request) {
	out, err := s.sourceRegistry().Detail(r.Context(), r.PathValue("provider"), r.PathValue("id"))
	if err != nil {
		sourceError(w, err)
		return
	}
	writeJSON(w, 200, out)
}
func (s *Server) handleSourceDownload(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Format         string `json:"format"`
		UserAuthorized bool   `json:"userAuthorized"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil {
		writeError(w, 400, "下载参数无效")
		return
	}
	task, err := s.sourceRegistry().StartAuthorized(r.Context(), r.PathValue("provider"), r.PathValue("id"), body.Format, body.UserAuthorized)
	if err != nil {
		sourceError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, task)
}
func (s *Server) handleBookDownloadTask(w http.ResponseWriter, r *http.Request) {
	var task booksources.Task
	var err error
	if r.Method == http.MethodDelete {
		task, err = s.sourceRegistry().Release(r.PathValue("task"), r.URL.Query().Get("lease"))
	} else {
		task, err = s.sourceRegistry().Status(r.PathValue("task"))
	}
	if err != nil {
		sourceError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, task)
}
func (s *Server) handleBookDownloadFile(w http.ResponseWriter, r *http.Request) {
	task, file, err := s.sourceRegistry().File(r.PathValue("task"))
	if err != nil {
		sourceError(w, err)
		return
	}
	defer file.Close()
	w.Header().Set("Content-Type", task.ContentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": task.FileName}))
	w.Header().Set("X-Content-SHA256", task.SHA256)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, task.FileName, time.Time{}, file)
}
