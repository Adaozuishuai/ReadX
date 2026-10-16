// duplicates.go：S6 重复检测。判定逻辑全在 internal/catalog（从旧版 paper.ts 移植，parity 背书），
// 这里只负责把库里的论文喂进去、把「哪些键互为重复」如实回给界面。
//
// 只报告，不自动合并：S6 范围内先让用户看见重复，合并动作（保留哪条、元数据怎么并）留给人工确认，
// 自动合并一旦判错就会静默丢论文。
package httpapi

import (
	"encoding/json"
	"net/http"

	"cbctv2/server/internal/catalog"
)

type duplicateGroup struct {
	PrimaryKey string   `json:"primaryKey"`
	Keys       []string `json:"keys"`
}

// handleDuplicates 返回库里互为重复的论文分组（按首次出现顺序）。
func (s *Server) handleDuplicates(w http.ResponseWriter, r *http.Request) {
	rows, err := s.handle.QueryContext(r.Context(),
		`SELECT id, title, authors, raw_json FROM documents ORDER BY added_at, id`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()

	keys := []string{}
	papers := []catalog.PaperIdentity{}
	for rows.Next() {
		var id, title, authorsJSON, rawJSON string
		if err := rows.Scan(&id, &title, &authorsJSON, &rawJSON); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		authors := []string{}
		_ = json.Unmarshal([]byte(authorsJSON), &authors)
		identity := catalog.PaperIdentity{ID: id, Title: title, Authors: authors}
		if rawJSON != "" {
			raw := map[string]any{}
			if json.Unmarshal([]byte(rawJSON), &raw) == nil {
				if value, ok := raw["arxiv"].(string); ok {
					identity.Arxiv = value
				}
				if value, ok := raw["doi"].(string); ok {
					identity.DOI = value
				}
			}
		}
		keys = append(keys, id)
		papers = append(papers, identity)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	groups := []duplicateGroup{}
	for _, group := range catalog.FindDuplicates(papers) {
		members := make([]string, 0, len(group.MemberIndexes))
		for _, index := range group.MemberIndexes {
			members = append(members, keys[index])
		}
		groups = append(groups, duplicateGroup{PrimaryKey: keys[group.PrimaryIndex], Keys: members})
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups, "total": len(groups)})
}
