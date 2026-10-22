// citations.go：书目导出（BibTeX / RIS）。
//
// 范围三种：指定 keys、按书架（category）、整库。真正决定「导出成什么样」的逻辑全在
// internal/citation（纯函数、有测试），这里只负责取题录、拼范围、如实回报跳过了几篇。
//
// 条目类型是按会场名推断的，所以另给一个 preview 接口把推断依据先摊给界面看：
// 用户应该在下载之前就知道哪些条目被写成了 @misc，而不是打开 .bib 才发现。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"cbctv2/server/internal/citation"
	"cbctv2/server/internal/legacy"
)

const (
	citationBibTeX = "bibtex"
	citationRIS    = "ris"
)

type citationQuery struct {
	format   string
	keys     []string
	category string
}

func parseCitationQuery(r *http.Request) (citationQuery, error) {
	query := citationQuery{
		format:   strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format"))),
		category: strings.TrimSpace(r.URL.Query().Get("category")),
	}
	if query.format == "" {
		query.format = citationBibTeX
	}
	if query.format != citationBibTeX && query.format != citationRIS {
		return citationQuery{}, fmt.Errorf("format 只能是 bibtex 或 ris")
	}
	for _, raw := range strings.Split(r.URL.Query().Get("keys"), ",") {
		key := strings.TrimSpace(raw)
		if key == "" {
			continue
		}
		query.keys = append(query.keys, key)
	}
	if len(query.keys) > 0 && query.category != "" {
		return citationQuery{}, fmt.Errorf("keys 与 category 只能给一个")
	}
	return query, nil
}

// loadCitationWorks 取这次导出的论文。
//
// 整库/按书架导出时跳过回收站里的论文；显式指定 keys 时以调用方给的顺序为准，
// 找不到的键计入 skipped 并由界面披露，不静默少导出。
func (s *Server) loadCitationWorks(ctx context.Context, query citationQuery) ([]citation.Work, int, error) {
	byKey := map[string]citation.Work{}
	order := []string{}
	// 连接池只有一条连接：Rows 的生命周期收在闭包里，读完就归还，
	// 免得后面查 app_state 时被自己占着的连接卡住（表现为请求永不返回）。
	err := func() error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT id, title, authors, year, venue, doi, url FROM documents`)
		if err != nil {
			return fmt.Errorf("读取题录失败: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key, title, authorsJSON, venue, doi, url string
			var year sql.NullInt64
			if err := rows.Scan(&key, &title, &authorsJSON, &year, &venue, &doi, &url); err != nil {
				return fmt.Errorf("解析题录失败: %w", err)
			}
			work := citation.Work{
				Key:     key,
				Title:   normalizePaperTitle(title),
				Venue:   venue,
				DOI:     doi,
				URL:     url,
				ArxivID: citation.ArxivID(url, doi),
			}
			if year.Valid {
				work.Year = int(year.Int64)
			}
			if err := json.Unmarshal([]byte(authorsJSON), &work.Authors); err != nil || work.Authors == nil {
				work.Authors = []string{}
			}
			byKey[key] = work
			order = append(order, key)
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, 0, err
	}

	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, 0, err
	}

	selected := []string{}
	skipped := 0
	switch {
	case len(query.keys) > 0:
		for _, key := range query.keys {
			if _, found := byKey[key]; !found {
				skipped++
				continue
			}
			selected = append(selected, key)
		}
	case query.category != "":
		for _, key := range order {
			if meta[key].Deleted || !containsString(meta[key].Categories, query.category) {
				continue
			}
			selected = append(selected, key)
		}
	default:
		for _, key := range order {
			if meta[key].Deleted {
				continue
			}
			selected = append(selected, key)
		}
	}

	works := make([]citation.Work, 0, len(selected))
	for _, key := range selected {
		work := byKey[key]
		work.Keywords = citation.SortedKeywords(meta[key].Tags, meta[key].Categories)
		works = append(works, work)
	}
	if len(query.keys) == 0 && query.category == "" {
		// 整库导出按年份倒序、同年按标题：书目文件的顺序应当是稳定的。
		sort.SliceStable(works, func(i, j int) bool {
			if works[i].Year != works[j].Year {
				return works[i].Year > works[j].Year
			}
			return works[i].Title < works[j].Title
		})
	}
	return works, skipped, nil
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// handleCitations 输出书目文件。跳过的篇数放在响应头里，界面据此如实提示。
func (s *Server) handleCitations(w http.ResponseWriter, r *http.Request) {
	query, err := parseCitationQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	works, skipped, err := s.loadCitationWorks(r.Context(), query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	now := time.Now()
	body := citation.BibTeX(works, now)
	contentType := "application/x-bibtex; charset=utf-8"
	extension := "bib"
	if query.format == citationRIS {
		body = citation.RIS(works, now)
		contentType = "application/x-research-info-systems; charset=utf-8"
		extension = "ris"
	}
	name := "readx-citations"
	if len(query.keys) == 1 {
		name = legacy.SafeFileStem(query.keys[0])
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.%s"`, name, extension))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-ReadX-Exported", fmt.Sprintf("%d", len(works)))
	w.Header().Set("X-ReadX-Skipped", fmt.Sprintf("%d", skipped))
	_, _ = w.Write([]byte(body))
}

// handleCitationPreview 在下载之前把「会写成什么条目类型、依据是什么、哪些字段是空的」摊开。
func (s *Server) handleCitationPreview(w http.ResponseWriter, r *http.Request) {
	query, err := parseCitationQuery(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	works, skipped, err := s.loadCitationWorks(r.Context(), query)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	used := map[string]int{}
	items := make([]map[string]any, 0, len(works))
	basisCount := map[string]int{}
	basisOrder := []string{}
	missingVenue, missingYear, missingDOI := 0, 0, 0
	for _, work := range works {
		class := citation.Classify(work)
		if _, seen := basisCount[class.Basis]; !seen {
			basisOrder = append(basisOrder, class.Basis)
		}
		basisCount[class.Basis]++
		if strings.TrimSpace(work.Venue) == "" {
			missingVenue++
		}
		if work.Year == 0 {
			missingYear++
		}
		if strings.TrimSpace(work.DOI) == "" {
			missingDOI++
		}
		items = append(items, map[string]any{
			"key":     work.Key,
			"title":   work.Title,
			"citeKey": citation.CiteKey(work, used),
			"kind":    string(class.Kind),
			"field":   class.Field,
			"value":   class.Value,
			"basis":   class.Basis,
		})
	}

	bases := make([]map[string]any, 0, len(basisOrder))
	for _, basis := range basisOrder {
		bases = append(bases, map[string]any{"basis": basis, "count": basisCount[basis]})
	}
	warnings := []string{}
	if missingVenue > 0 {
		warnings = append(warnings, fmt.Sprintf("%d 篇没有会场/期刊信息，条目类型无法判断", missingVenue))
	}
	if missingYear > 0 {
		warnings = append(warnings, fmt.Sprintf("%d 篇没有年份", missingYear))
	}
	if missingDOI > 0 {
		warnings = append(warnings, fmt.Sprintf("%d 篇没有 DOI", missingDOI))
	}
	if skipped > 0 {
		warnings = append(warnings, fmt.Sprintf("%d 篇指定的论文不在库中，已跳过", skipped))
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"format":   query.format,
		"count":    len(works),
		"skipped":  skipped,
		"items":    items,
		"bases":    bases,
		"warnings": warnings,
	})
}