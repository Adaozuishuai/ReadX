package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

type translationPreviewBlock struct {
	Source string     `json:"source"`
	Target string     `json:"target"`
	Box    [4]float64 `json:"box"`
}

// handleTranslationPreview exposes translations as soon as LeePDF has flushed
// a page JSON file and the background importer has persisted its segments.
// It deliberately reads only the translation cache: opening the reader must
// never race the import pipeline by issuing a second AI translation request.
func (s *Server) handleTranslationPreview(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	pageNumber, err := strconv.Atoi(strings.TrimSpace(r.PathValue("page")))
	if err != nil || pageNumber < 1 {
		writeError(w, http.StatusBadRequest, "页码必须是从 1 开始的整数")
		return
	}
	if _, err := s.loadDocument(r.Context(), key); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	layout, available, err := s.loadLayout(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取 OCR 版式数据失败: "+err.Error())
		return
	}
	if !available || pageNumber > len(layout.Pages) {
		writeJSON(w, http.StatusOK, map[string]any{"available": false, "page": pageNumber, "blocks": []translationPreviewBlock{}})
		return
	}
	pages := layoutOCRPages(layout)
	page := pages[pageNumber-1]
	items, owners, _ := pageTranslationItems(page, neighbor(pages, pageNumber-2), neighbor(pages, pageNumber))
	targets, err := s.translatePageItemsMode(r.Context(), key, items, false, true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取本页已完成译文失败: "+err.Error())
		return
	}
	blocks := make([]translationPreviewBlock, 0, len(owners))
	for index, owner := range owners {
		if index >= len(targets) || owner < 0 || owner >= len(page.Blocks) || strings.TrimSpace(targets[index]) == "" {
			continue
		}
		blocks = append(blocks, translationPreviewBlock{
			Source: items[index].Source,
			Target: targets[index],
			Box:    page.Blocks[owner].Box,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available":        true,
		"page":             pageNumber,
		"width":            page.Width,
		"height":           page.Height,
		"translatedBlocks": len(blocks),
		"totalBlocks":      len(owners),
		"blocks":           blocks,
	})
}
