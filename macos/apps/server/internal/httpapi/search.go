// search.go：全库全文检索。
//
// 检索语料只有一个来源：document_pages（导入时 OCR 管线写入，阅读器首次打开源文档时也会补写）。
// 因此**覆盖度是不完整的**，必须在响应里如实披露：未翻译且没打开过的论文、扫描页都不会被搜到。
// 把自己知道的范围讲清楚，比给一个看起来全知的结果列表重要。
//
// 这里做的是逐字检索（SQLite LIKE），不做语义检索：向量检索是另一条路，混在一起会让
// 「为什么这条能搜到、那条搜不到」变得无法解释。
package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	searchDefaultLimit = 60
	searchMaxLimit     = 200
	searchMinQueryRune = 2
	searchSnippetPad   = 40
)

type searchHit struct {
	Key      string `json:"key"`
	Title    string `json:"title"`
	Year     int    `json:"year"`
	Status   string `json:"status"`
	Page     int    `json:"page"`
	Count    int    `json:"count"`
	Before   string `json:"before"`
	Match    string `json:"match"`
	After    string `json:"after"`
}

// handleSearch 返回命中页与覆盖度。
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) < searchMinQueryRune {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("搜索词至少 %d 个字符", searchMinQueryRune))
		return
	}
	limit := searchDefaultLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "limit 必须是正整数")
			return
		}
		limit = min(parsed, searchMaxLimit)
	}

	coverage, err := s.searchCoverage(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	hits, total, truncated, err := s.searchPages(r.Context(), query, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	documents := map[string]bool{}
	for _, hit := range hits {
		documents[hit.Key] = true
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"query":     query,
		"hits":      hits,
		"matches":   total,
		"documents": len(documents),
		"truncated": truncated,
		"coverage":  coverage,
	})
}

// searchCoverage 披露索引覆盖：已建索引的论文数、总论文数、逐页文本页数。
//
// 只算**未删除**的论文：回收站里的正文仍在库里，但它不占「在库文献」的分母。
// 混进来会让「还有几篇没索引」被算成 0（实际还有），把披露变成误导。
func (s *Server) searchCoverage(ctx context.Context) (map[string]any, error) {
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, err
	}
	var total int
	if err := s.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM documents`).Scan(&total); err != nil {
		return nil, fmt.Errorf("统计论文总数失败: %w", err)
	}
	deleted := 0
	for _, item := range meta {
		if item.Deleted {
			deleted++
		}
	}

	indexedDocuments, indexedPages := 0, 0
	err = func() error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT document_id, COUNT(*) FROM document_pages WHERE length(text) > 0 GROUP BY document_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			var pages int
			if err := rows.Scan(&key, &pages); err != nil {
				return err
			}
			if meta[key].Deleted {
				continue
			}
			indexedDocuments++
			indexedPages += pages
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, fmt.Errorf("统计索引覆盖失败: %w", err)
	}

	active := total - deleted
	unindexed := active - indexedDocuments
	if unindexed < 0 {
		unindexed = 0
	}
	return map[string]any{
		"documents":          active,
		"indexedDocuments":   indexedDocuments,
		"unindexedDocuments": unindexed,
		"indexedPages":       indexedPages,
		"trashedDocuments":   deleted,
	}, nil
}

// searchPages 逐页匹配。返回的命中按论文分组：命中多的论文排前面，同篇内按页码升序。
//
// 连接池只有一条连接（db.Open 里 SetMaxOpenConns(1)），所以 Rows 的生命周期必须收在一个
// 闭包里：拿着未读完的 Rows 再去查别的表会把自己锁死，表现为整个请求一直不返回。
func (s *Server) searchPages(ctx context.Context, query string, limit int) ([]searchHit, int, bool, error) {
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, 0, false, err
	}

	type pageHit struct {
		key                  string
		page                 int
		before, match, after string
		count                int
	}
	raw := []pageHit{}
	total := 0
	err = func() error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT document_id, page, text FROM document_pages WHERE length(text) > 0 AND text LIKE ? ESCAPE '\'`,
			"%"+escapeLikePattern(query)+"%")
		if err != nil {
			return fmt.Errorf("检索失败: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key, text string
			var page int
			if err := rows.Scan(&key, &page, &text); err != nil {
				return fmt.Errorf("解析检索结果失败: %w", err)
			}
			if meta[key].Deleted {
				// 回收站里的论文不参与检索：用户已经把它移出书库了。
				continue
			}
			before, match, after, count := searchSnippet(text, query)
			if count == 0 {
				// LIKE 命中但片段提取没命中：只可能出现在大小写折叠改变长度的情况下，
				// 这里如实跳过而不是编一个片段出来。
				continue
			}
			total += count
			raw = append(raw, pageHit{key: key, page: page, before: before, match: match, after: after, count: count})
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, 0, false, err
	}

	byDocument := map[string][]searchHit{}
	documentOrder := []string{}
	for _, item := range raw {
		if _, seen := byDocument[item.key]; !seen {
			documentOrder = append(documentOrder, item.key)
		}
		byDocument[item.key] = append(byDocument[item.key], searchHit{
			Key: item.key, Page: item.page, Count: item.count,
			Before: item.before, Match: item.match, After: item.after,
		})
	}

	// 题录信息按需补齐：命中页可能很多，只查真正命中的这些论文。
	type documentInfo struct {
		title string
		year  int
		state string
	}
	infos := map[string]documentInfo{}
	for _, key := range documentOrder {
		info := documentInfo{title: key}
		var title, status string
		var year sql.NullInt64
		err := s.handle.QueryRowContext(ctx,
			`SELECT title, year, status FROM documents WHERE id = ?`, key).Scan(&title, &year, &status)
		if err != nil && err != sql.ErrNoRows {
			return nil, 0, false, fmt.Errorf("读取命中论文题录失败: %w", err)
		}
		if strings.TrimSpace(title) != "" {
			info.title = normalizePaperTitle(title)
		}
		if year.Valid {
			info.year = int(year.Int64)
		}
		info.state = status
		infos[key] = info
	}

	sort.SliceStable(documentOrder, func(i, j int) bool {
		left, right := documentOrder[i], documentOrder[j]
		if len(byDocument[left]) != len(byDocument[right]) {
			return len(byDocument[left]) > len(byDocument[right])
		}
		return infos[left].title < infos[right].title
	})

	hits := []searchHit{}
	truncated := false
	for _, key := range documentOrder {
		info := infos[key]
		pages := byDocument[key]
		sort.SliceStable(pages, func(i, j int) bool { return pages[i].Page < pages[j].Page })
		for _, hit := range pages {
			if len(hits) >= limit {
				truncated = true
				break
			}
			hit.Title = info.title
			hit.Year = info.year
			hit.Status = info.state
			hits = append(hits, hit)
		}
		if truncated {
			break
		}
	}
	return hits, total, truncated, nil
}

// escapeLikePattern 转义 LIKE 的通配符：搜索词里的 % 和 _ 是字面量，不是通配符。
// 注意 SQLite 的 LIKE 默认没有 ESCAPE 子句时 '\' 不是转义符，所以这里显式声明 ESCAPE。
const searchLikeEscape = `\`

func escapeLikePattern(value string) string {
	replacer := strings.NewReplacer(
		searchLikeEscape, searchLikeEscape+searchLikeEscape,
		"%", searchLikeEscape+"%",
		"_", searchLikeEscape+"_",
	)
	return replacer.Replace(value)
}

// searchSnippet 在压平空白后的正文里找 query，返回上下文、命中原文与该页命中数。
//
// 与阅读器内查找同一套语义：不回溯、不重叠，按出现顺序计数。
func searchSnippet(text, query string) (before, match, after string, count int) {
	flat := strings.Join(strings.Fields(text), " ")
	if flat == "" {
		return "", "", "", 0
	}
	runes := []rune(flat)
	folded := []rune(strings.ToLower(flat))
	needle := []rune(strings.ToLower(query))
	if len(folded) != len(runes) || len(needle) == 0 {
		return "", "", "", 0
	}
	first := -1
	for from := 0; from+len(needle) <= len(folded); {
		index := indexRunes(folded, needle, from)
		if index < 0 {
			break
		}
		count++
		if first < 0 {
			first = index
		}
		from = index + len(needle)
	}
	if first < 0 {
		return "", "", "", 0
	}
	start := max(0, first-searchSnippetPad)
	end := min(len(runes), first+len(needle)+searchSnippetPad)
	if start > 0 {
		before = "…"
	}
	before += string(runes[start:first])
	if end < len(runes) {
		after = string(runes[first+len(needle):end]) + "…"
	} else {
		after = string(runes[first+len(needle):end])
	}
	return before, string(runes[first : first+len(needle)]), after, count
}

func indexRunes(haystack, needle []rune, from int) int {
	if len(needle) == 0 || from < 0 {
		return -1
	}
	for i := from; i+len(needle) <= len(haystack); i++ {
		matched := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				matched = false
				break
			}
		}
		if matched {
			return i
		}
	}
	return -1
}