// citation_network.go：库内引用关系。
//
// 数据来源是 OpenAlex 的 referenced_works / cited_by，**不是**解析 PDF 里的参考文献列表：
// 解析参考文献是另一件工程（参考文献格式杂乱、跨行、缩写），而且只对拿到参考文献文本的论文有效。
// 用 OpenAlex 的代价是：**只有收录了 DOI 的论文可查**，且结果滞后于最新发表。
// 这两条都写进 disclosure 一起返回，界面照实显示。
//
// 缓存 7 天：OpenAlex 有限流，而且用户反复开关同一个对话框不该每次都打三次请求。
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	citationNetworkPrefix = "citation-network:"
	citationNetworkTTL    = 7 * 24 * time.Hour
	// OpenAlex 单次 filter 上限 50 个 ID：超出的参考文献只解析前 50 条并如实披露。
	citationResolveBatch = 50
	citationExternalCap  = 8
)

// citationEdge 是库内的一篇相关论文。
type citationEdge struct {
	Key      string `json:"key"`
	Title    string `json:"title"`
	Year     int    `json:"year"`
	DOI      string `json:"doi"`
	Relation string `json:"relation"` // reference：本文引用了它；citation：它引用了本文
}

// citationExternal 是库外的一篇相关论文（只够给出题录，供用户自己去找）。
type citationExternal struct {
	Title string `json:"title"`
	Year  int    `json:"year"`
	DOI   string `json:"doi"`
}

type citationNetworkCounts struct {
	References          int `json:"references"`
	Citations           int `json:"citations"`
	ResolvedReferences  int `json:"resolvedReferences"`
	InLibraryReferences int `json:"inLibraryReferences"`
	InLibraryCitations  int `json:"inLibraryCitations"`
}

type citationNetworkPayload struct {
	Key        string                `json:"key"`
	Title      string                `json:"title"`
	DOI        string                `json:"doi"`
	Available  bool                  `json:"available"`
	OpenAlexID string                `json:"openAlexId,omitempty"`
	FetchedAt  string                `json:"fetchedAt,omitempty"`
	FromCache  bool                  `json:"fromCache"`
	InLibrary  []citationEdge        `json:"inLibrary"`
	External   []citationExternal    `json:"external"`
	Counts     citationNetworkCounts `json:"counts"`
	Disclosure []string              `json:"disclosure"`
}

// openAlexWorkRef 是解析引用关系所需的最小字段集。
type openAlexWorkRef struct {
	ID    string `json:"id"`
	DOI   string `json:"doi"`
	Title string `json:"title"`
	Year  int    `json:"publication_year"`
}

func (s *Server) handleCitationNetwork(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	document, err := s.loadDocument(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	}
	doi := normalizePublicationDOI(document.DOI)
	base := citationNetworkPayload{
		Key: key, Title: document.Title, DOI: doi,
		InLibrary: []citationEdge{}, External: []citationExternal{},
	}
	if doi == "" {
		// 没有 DOI 不是错误：这一条要在界面上说清楚，而不是报错让人以为功能坏了。
		base.Available = false
		base.Disclosure = []string{
			"这篇论文没有 DOI，无法用 OpenAlex 查引用关系。在论文卡片上补齐 DOI 后可以再试。",
		}
		writeJSON(w, http.StatusOK, base)
		return
	}

	refresh := strings.TrimSpace(r.URL.Query().Get("refresh")) != ""
	if !refresh {
		if cached, fetchedAt, ok := s.loadCitationNetworkCache(r.Context(), key); ok {
			// The cache is keyed by document key, but the DOI can be edited in
			// the library. Never serve relationships fetched for a previous DOI.
			if normalizePublicationDOI(cached.DOI) == doi {
				cached.FromCache = true
				cached.FetchedAt = fetchedAt
				writeJSON(w, http.StatusOK, cached)
				return
			}
		}
	}

	payload, err := s.fetchCitationNetwork(r.Context(), base)
	if err != nil {
		// 已经失败过就不要把错误缓存起来：下次进来应当重新尝试。
		base.Available = false
		base.Disclosure = []string{err.Error()}
		writeJSON(w, http.StatusOK, base)
		return
	}
	payload.FetchedAt = time.Now().UTC().Format(time.RFC3339)
	s.saveCitationNetworkCache(r.Context(), key, payload)
	writeJSON(w, http.StatusOK, payload)
}

// fetchCitationNetwork 打三次 OpenAlex：解析 DOI、批量取参考文献题录、取引用本文的论文。
func (s *Server) fetchCitationNetwork(ctx context.Context, base citationNetworkPayload) (citationNetworkPayload, error) {
	probe, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	work, err := fetchOpenAlexWork(probe, base.DOI)
	if err != nil {
		return base, err
	}
	base.OpenAlexID = work.ID
	payload, err := fetchOpenAlexWorkDetail(probe, work.ID)
	if err != nil {
		return base, err
	}
	base.Counts.References = len(payload.ReferencedWorks)
	base.Counts.Citations = payload.CitedByCount

	references, err := resolveOpenAlexWorks(probe, payload.ReferencedWorks)
	if err != nil {
		return base, err
	}
	base.Counts.ResolvedReferences = len(references)
	citing, err := fetchOpenAlexCitingWorks(probe, work.ID)
	if err != nil {
		return base, err
	}

	inLibrary, edges, external := s.matchCitationNetwork(ctx, base.Key, references, citing)
	base.InLibrary = edges
	base.External = external
	base.Counts.InLibraryReferences = inLibrary.InLibraryReferences
	base.Counts.InLibraryCitations = inLibrary.InLibraryCitations
	base.Available = true
	base.Disclosure = []string{
		"引用关系来自 OpenAlex 的元数据，不是解析 PDF 参考文献；OpenAlex 未收录或尚未回填的条目会缺失。",
		"只有题录里有 DOI 的论文才能进入这张关系网；库内匹配同样按 DOI（没有 DOI 时按题名归一化匹配）。",
	}
	if len(payload.ReferencedWorks) > citationResolveBatch {
		base.Disclosure = append(base.Disclosure,
			fmt.Sprintf("本文有 %d 条参考文献，只解析了前 %d 条。", len(payload.ReferencedWorks), citationResolveBatch))
	}
	return base, nil
}

type openAlexWorkDetail struct {
	ReferencedWorks []string
	CitedByCount    int
}

func fetchOpenAlexWork(ctx context.Context, doi string) (openAlexWorkRef, error) {
	endpoint := "https://api.openalex.org/works/https://doi.org/" + url.PathEscape(doi) +
		"?select=id,doi,title,publication_year"
	raw, _, err := fetchPublic(ctx, endpoint, 2<<20)
	if err != nil {
		return openAlexWorkRef{}, fmt.Errorf("OpenAlex 查询失败：%w", err)
	}
	var work openAlexWorkRef
	if err := json.Unmarshal(raw, &work); err != nil {
		return openAlexWorkRef{}, fmt.Errorf("OpenAlex 返回了无法识别的数据：%w", err)
	}
	return work, nil
}

func fetchOpenAlexWorkDetail(ctx context.Context, id string) (openAlexWorkDetail, error) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(id), "https://openalex.org/")
	if trimmed == "" {
		return openAlexWorkDetail{}, fmt.Errorf("OpenAlex 没有给这篇论文分配 ID")
	}
	endpoint := "https://api.openalex.org/works/" + url.PathEscape(trimmed) +
		"?select=id,referenced_works,cited_by_count"
	raw, _, err := fetchPublic(ctx, endpoint, 4<<20)
	if err != nil {
		return openAlexWorkDetail{}, fmt.Errorf("OpenAlex 读取参考文献失败：%w", err)
	}
	var detail struct {
		ReferencedWorks []string `json:"referenced_works"`
		CitedByCount    int      `json:"cited_by_count"`
	}
	if err := json.Unmarshal(raw, &detail); err != nil {
		return openAlexWorkDetail{}, fmt.Errorf("OpenAlex 返回了无法识别的参考文献数据：%w", err)
	}
	return openAlexWorkDetail{ReferencedWorks: detail.ReferencedWorks, CitedByCount: detail.CitedByCount}, nil
}

// resolveOpenAlexWorks 把参考文献的 OpenAlex ID 批量换成题录。
func resolveOpenAlexWorks(ctx context.Context, ids []string) ([]openAlexWorkRef, error) {
	trimmed := make([]string, 0, len(ids))
	for _, id := range ids {
		bare := strings.TrimPrefix(strings.TrimSpace(id), "https://openalex.org/")
		if bare != "" {
			trimmed = append(trimmed, bare)
		}
		if len(trimmed) >= citationResolveBatch {
			break
		}
	}
	if len(trimmed) == 0 {
		return []openAlexWorkRef{}, nil
	}
	fields := "id,doi,title,publication_year"
	endpoint := "https://api.openalex.org/works?per-page=" + fmt.Sprintf("%d", citationResolveBatch) +
		"&select=" + url.QueryEscape(fields) +
		"&filter=" + url.QueryEscape("openalex_id:"+strings.Join(trimmed, "|"))
	raw, _, err := fetchPublic(ctx, endpoint, 8<<20)
	if err != nil {
		return nil, fmt.Errorf("OpenAlex 解析参考文献题录失败：%w", err)
	}
	var response struct {
		Results []openAlexWorkRef `json:"results"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("OpenAlex 返回了无法识别的题录数据：%w", err)
	}
	return response.Results, nil
}

// fetchOpenAlexCitingWorks 取引用了本文的论文（只取最近的一批）。
func fetchOpenAlexCitingWorks(ctx context.Context, id string) ([]openAlexWorkRef, error) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(id), "https://openalex.org/")
	if trimmed == "" {
		return []openAlexWorkRef{}, nil
	}
	fields := "id,doi,title,publication_year"
	endpoint := "https://api.openalex.org/works?per-page=50&sort=publication_date:desc" +
		"&select=" + url.QueryEscape(fields) +
		"&filter=" + url.QueryEscape("cites:"+trimmed)
	raw, _, err := fetchPublic(ctx, endpoint, 8<<20)
	if err != nil {
		return nil, fmt.Errorf("OpenAlex 读取引用本文的论文失败：%w", err)
	}
	var response struct {
		Results []openAlexWorkRef `json:"results"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("OpenAlex 返回了无法识别的引用数据：%w", err)
	}
	return response.Results, nil
}

// matchCitationNetwork 把库外题录与库内论文对上。
//
// 库内匹配优先用 DOI（归一化后比较，大小写与 https://doi.org/ 前缀都不影响），
// 没有 DOI 的论文回退到题名归一化匹配 —— 这一步会有误配风险，所以只在 DOI 缺失时使用。
func (s *Server) matchCitationNetwork(
	ctx context.Context,
	selfKey string,
	references []openAlexWorkRef,
	citing []openAlexWorkRef,
) (citationNetworkCounts, []citationEdge, []citationExternal) {
	type localPaper struct {
		key   string
		title string
		year  int
		doi   string
	}
	locals := []localPaper{}
	// Rows 收在闭包里：连接池只有一条连接，读完就归还。
	err := func() error {
		rows, err := s.handle.QueryContext(ctx, `SELECT id, title, year, doi FROM documents`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var key, title, doi string
			var year *int
			if scanErr := rows.Scan(&key, &title, &year, &doi); scanErr != nil {
				return scanErr
			}
			item := localPaper{key: key, title: normalizePaperTitle(title), doi: normalizePublicationDOI(doi)}
			if year != nil {
				item.year = *year
			}
			locals = append(locals, item)
		}
		return rows.Err()
	}()
	if err != nil {
		// 匹配失败不该让整张关系网失败：退化成「库内 0 条」并保留库外题录。
		return citationNetworkCounts{}, []citationEdge{}, externalFromWorks(references, citing)
	}

	byDOI := map[string]localPaper{}
	byTitle := map[string]localPaper{}
	for _, item := range locals {
		if item.doi != "" {
			byDOI[item.doi] = item
		}
		if key := citeTitleKey(item.title); key != "" {
			byTitle[key] = item
		}
	}
	match := func(work openAlexWorkRef) (localPaper, bool) {
		if doi := normalizePublicationDOI(work.DOI); doi != "" {
			if item, ok := byDOI[doi]; ok && item.key != selfKey {
				return item, true
			}
		}
		if key := citeTitleKey(normalizePaperTitle(work.Title)); key != "" {
			if item, ok := byTitle[key]; ok && item.key != selfKey {
				return item, true
			}
		}
		return localPaper{}, false
	}

	counts := citationNetworkCounts{}
	edges := []citationEdge{}
	seen := map[string]string{}
	addEdge := func(item localPaper, relation string) {
		if existing, ok := seen[item.key]; ok {
			// 互相引用时同一篇会出现两次：只保留一条边（优先「本文引用了它」），
			// 否则列表里会出现两条指向同一篇论文的重复项。
			if existing == "reference" || relation != "reference" {
				return
			}
		}
		seen[item.key] = relation
		edges = append(edges, citationEdge{
			Key: item.key, Title: item.title, Year: item.year, DOI: item.doi, Relation: relation,
		})
	}
	for _, work := range references {
		item, ok := match(work)
		if !ok {
			continue
		}
		addEdge(item, "reference")
	}
	for _, work := range citing {
		item, ok := match(work)
		if !ok {
			continue
		}
		addEdge(item, "citation")
	}
	// 计数从最终边表得出：界面上的「库内 N 篇」必须和列表条数一致，
	// 否则去重之后计数会多出对不上的那一篇。
	for _, edge := range edges {
		if edge.Relation == "reference" {
			counts.InLibraryReferences++
		} else {
			counts.InLibraryCitations++
		}
	}

	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].Relation != edges[j].Relation {
			return edges[i].Relation == "reference"
		}
		return edges[i].Year > edges[j].Year
	})
	return counts, edges, externalFromWorks(references, citing)
}

// externalFromWorks 只挑库外条目里最近的一批给出题录，供用户自己去找。
func externalFromWorks(references, citing []openAlexWorkRef) []citationExternal {
	all := append([]openAlexWorkRef{}, references...)
	all = append(all, citing...)
	sort.SliceStable(all, func(i, j int) bool { return all[i].Year > all[j].Year })
	out := []citationExternal{}
	seen := map[string]bool{}
	for _, work := range all {
		title := strings.TrimSpace(work.Title)
		if title == "" || seen[title] {
			continue
		}
		seen[title] = true
		out = append(out, citationExternal{Title: title, Year: work.Year, DOI: normalizePublicationDOI(work.DOI)})
		if len(out) >= citationExternalCap {
			break
		}
	}
	return out
}

// citeTitleKey 题名归一化：只留字母数字，避免大小写与标点造成漏配。
func citeTitleKey(title string) string {
	var out strings.Builder
	for _, r := range strings.ToLower(title) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r > 127 {
			out.WriteRune(r)
		}
	}
	value := out.String()
	if len([]rune(value)) < 8 {
		// 太短的题名（或空题名）不足以做匹配依据，宁可不算命中。
		return ""
	}
	return value
}

func citationNetworkKey(key string) string { return citationNetworkPrefix + key }

func (s *Server) loadCitationNetworkCache(ctx context.Context, key string) (citationNetworkPayload, string, bool) {
	var body, updatedAt string
	err := s.handle.QueryRowContext(ctx,
		`SELECT value_json, updated_at FROM app_state WHERE key = ?`, citationNetworkKey(key)).Scan(&body, &updatedAt)
	if err != nil {
		return citationNetworkPayload{}, "", false
	}
	fetched, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(updatedAt))
	if parseErr != nil || time.Since(fetched) > citationNetworkTTL {
		return citationNetworkPayload{}, "", false
	}
	var payload citationNetworkPayload
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return citationNetworkPayload{}, "", false
	}
	return payload, updatedAt, true
}

func (s *Server) saveCitationNetworkCache(ctx context.Context, key string, payload citationNetworkPayload) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = s.handle.ExecContext(ctx,
		`INSERT INTO app_state(key, value_json, updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		citationNetworkKey(key), string(encoded), nowStamp())
}
