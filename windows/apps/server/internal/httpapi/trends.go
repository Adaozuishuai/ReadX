// trends.go：S6 趋势面板。
//
// 这里只做「计数 + 证据集合 + 时间窗口」的如实披露，不输出趋势百分比——
// 判定逻辑全在 internal/catalog（从旧版 trend.ts 移植，parity 测试背书）。
// 服务端负责把库里的论文归拢成输入（标签派生 + 年份），前端只负责渲染 claim/caveat。
package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"

	"cbctv2/server/internal/catalog"
)

// handleTrends 对全库（或某个状态子集）跑系统标签聚合，返回带披露的趋势条目。
func (s *Server) handleTrends(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status != "" && !knownStatus(status) {
		writeError(w, http.StatusBadRequest, "status 只能是 queue / reading / done / archive")
		return
	}

	papers, err := s.loadTrendInputs(r.Context(), status)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	labels := make([]string, len(papers))
	years := make([]catalog.YearCarrier, len(papers))
	tagsByIndex := make([][]catalog.SystemTag, len(papers))
	for index, paper := range papers {
		labels[index] = paper.label
		years[index] = catalog.YearCarrier{Year: paper.year}
		tagsByIndex[index] = catalog.Derive(paper.fields)
	}

	findings := catalog.Findings(labels, years, func(index int, _ string) []catalog.SystemTag {
		return tagsByIndex[index]
	})

	// 汇总每个标签命中的论文键，供「证据集合」下钻。
	evidence := map[string][]string{}
	for _, finding := range findings {
		evidence[finding.Topic] = []string{}
	}
	for index, paper := range papers {
		for _, tag := range tagsByIndex[index] {
			evidence[tag.Value] = append(evidence[tag.Value], paper.key)
		}
	}

	coverage := catalog.Coverage(catalog.Derive(flattenFields(papers)))

	writeJSON(w, http.StatusOK, map[string]any{
		"sample":   map[string]any{"papers": labels, "count": len(labels)},
		"findings": findings,
		"evidence": evidence,
		"coverage": coverage,
		"minimum":  catalog.MinimumSample,
	})
}

type trendInput struct {
	key    string
	label  string
	year   *string
	fields []string
}

// loadTrendInputs 取出参与统计的论文，并按 tagFields 的顺序汇总可检索文本。
func (s *Server) loadTrendInputs(ctx context.Context, status string) ([]trendInput, error) {
	query := `SELECT id, title, authors, year, venue, raw_json FROM documents`
	var args []any
	if status != "" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY added_at DESC, id`
	rows, err := s.handle.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []trendInput{}
	for rows.Next() {
		var key, title, authorsJSON, venue, rawJSON string
		var year sql.NullInt64
		if err := rows.Scan(&key, &title, &authorsJSON, &year, &venue, &rawJSON); err != nil {
			return nil, err
		}
		authors := []string{}
		_ = json.Unmarshal([]byte(authorsJSON), &authors)
		abstract := ""
		why := ""
		if rawJSON != "" {
			raw := map[string]any{}
			if json.Unmarshal([]byte(rawJSON), &raw) == nil {
				if value, ok := raw["abstract"].(string); ok {
					abstract = value
				}
				if value, ok := raw["why"].(string); ok {
					why = value
				}
			}
		}
		fields := catalog.TagFields(title, abstract, venue, why)
		label := title
		if label == "" {
			label = key
		}
		item := trendInput{key: key, label: label, fields: fields}
		if year.Valid {
			value := itoaYear(int(year.Int64))
			item.year = &value
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func flattenFields(papers []trendInput) []string {
	out := []string{}
	for _, paper := range papers {
		out = append(out, paper.fields...)
	}
	return out
}

func itoaYear(value int) string {
	return strconv.Itoa(value)
}
