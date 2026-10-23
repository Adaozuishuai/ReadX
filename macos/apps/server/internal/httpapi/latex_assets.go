package httpapi

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"

	"cbctv2/server/internal/latex"
)

// handleLatexAsset serves a project-local binary preview or adds one without
// replacing an existing resource. The client uses the same path validation as
// the text-file API; binary bytes never pass through the source editor.
func (s *Server) handleLatexAsset(w http.ResponseWriter, r *http.Request) {
	relative := strings.TrimSpace(r.URL.Query().Get("path"))
	if relative == "" {
		writeError(w, http.StatusBadRequest, "缺少 path 参数")
		return
	}
	service := s.latexService()
	switch r.Method {
	case http.MethodGet:
		content, cleanPath, err := service.ReadAsset(r.Context(), r.PathValue("id"), relative)
		if err != nil {
			writeLatexError(w, err)
			return
		}
		contentType := mime.TypeByExtension(path.Ext(cleanPath))
		if contentType == "" {
			contentType = http.DetectContentType(content)
		}
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(content)
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, latex.MaxAssetBytes+1)
		content, err := io.ReadAll(r.Body)
		if err != nil {
			var sizeError *http.MaxBytesError
			if errors.As(err, &sizeError) {
				writeError(w, http.StatusRequestEntityTooLarge, "单个资源不能超过 64 MiB")
				return
			}
			writeError(w, http.StatusBadRequest, "读取上传资源失败")
			return
		}
		if len(content) > latex.MaxAssetBytes {
			writeError(w, http.StatusRequestEntityTooLarge, "单个资源不能超过 64 MiB")
			return
		}
		if err := service.WriteAsset(r.Context(), r.PathValue("id"), relative, bytes.NewReader(content), int64(len(content))); err != nil {
			writeLatexError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"path": relative, "size": len(content)})
	default:
		writeError(w, http.StatusMethodNotAllowed, "只允许 GET / POST")
	}
}
