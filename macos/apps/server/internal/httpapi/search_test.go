package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type searchPayload struct {
	Query     string `json:"query"`
	Matches   int    `json:"matches"`
	Documents int    `json:"documents"`
	Truncated bool   `json:"truncated"`
	Hits      []struct {
		Key    string `json:"key"`
		Title  string `json:"title"`
		Page   int    `json:"page"`
		Count  int    `json:"count"`
		Before string `json:"before"`
		Match  string `json:"match"`
		After  string `json:"after"`
	} `json:"hits"`
	Coverage struct {
		Documents          int `json:"documents"`
		IndexedDocuments   int `json:"indexedDocuments"`
		UnindexedDocuments int `json:"unindexedDocuments"`
		IndexedPages       int `json:"indexedPages"`
		TrashedDocuments   int `json:"trashedDocuments"`
	} `json:"coverage"`
}

func runSearch(t *testing.T, frontend *httptest.Server, token, query string) searchPayload {
	t.Helper()
	response := do(t, frontend, http.MethodGet, "/v1/search?q="+url.QueryEscape(query), token)
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("检索返回 %d：%s", response.StatusCode, body)
	}
	var payload searchPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestSearchFindsPagesAndDisclosesCoverage(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,year) VALUES('a','a','Sparse view CT',2022)`); err != nil {
		t.Fatal(err)
	}
	// 另一篇完全没有逐页正文：它必须计入 unindexedDocuments，而不是被当成「没有命中」。
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title,year) VALUES('b','b','Never opened',2023)`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(
		`INSERT INTO document_pages(document_id,page,text) VALUES
		 ('a',1,'We reconstruct from sparse views. Sparse view imaging is hard.'),
		 ('a',3,'The sparse view setup uses 4 projections.')`); err != nil {
		t.Fatal(err)
	}

	got := runSearch(t, frontend, cfg.Token, "sparse view")
	if got.Documents != 1 || len(got.Hits) != 2 {
		t.Fatalf("命中论文/页数不对：%+v", got)
	}
	// 第 1 页出现两次、第 3 页一次：matches 是命中总数，不是命中页数。
	if got.Matches != 3 {
		t.Fatalf("matches = %d, want 3", got.Matches)
	}
	if got.Hits[0].Page != 1 || got.Hits[0].Count != 2 || got.Hits[1].Page != 3 {
		t.Fatalf("命中页与页内命中数不对：%+v", got.Hits)
	}
	if got.Hits[0].Match != "sparse view" && got.Hits[0].Match != "Sparse view" {
		t.Fatalf("命中原文片段不对：%q", got.Hits[0].Match)
	}
	if !strings.Contains(got.Hits[0].Before+got.Hits[0].After, "reconstruct") {
		t.Fatalf("缺少上下文：%+v", got.Hits[0])
	}
	if got.Coverage.Documents != 2 || got.Coverage.IndexedDocuments != 1 || got.Coverage.UnindexedDocuments != 1 {
		t.Fatalf("覆盖度披露不对：%+v", got.Coverage)
	}
}

func TestSearchExcludesTrashedDocuments(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('gone','gone','Trashed paper')`); err != nil {
		t.Fatal(err)
	}
	// 回收站里的论文有正文，也有一篇在库论文完全没有正文：
	// 覆盖度必须只按在库论文算，否则「未索引篇数」会被回收站的正文抵消成 0。
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('live','live','Live paper')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO document_pages(document_id,page,text) VALUES('gone',1,'deconvolution kernel')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES('documents.meta',?)`,
		`{"gone":{"deleted":true}}`); err != nil {
		t.Fatal(err)
	}
	got := runSearch(t, frontend, cfg.Token, "deconvolution")
	if len(got.Hits) != 0 || got.Matches != 0 {
		t.Fatalf("回收站论文不应出现在检索结果里：%+v", got)
	}
	if got.Coverage.Documents != 1 || got.Coverage.TrashedDocuments != 1 {
		t.Fatalf("回收站论文不应计入覆盖度分母：%+v", got.Coverage)
	}
	if got.Coverage.IndexedDocuments != 0 || got.Coverage.UnindexedDocuments != 1 || got.Coverage.IndexedPages != 0 {
		t.Fatalf("回收站论文的正文不应计入索引覆盖：%+v", got.Coverage)
	}
}

func TestSearchTreatsWildcardsAsLiterals(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('a','a','Paper')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(
		`INSERT INTO document_pages(document_id,page,text) VALUES
		 ('a',1,'accuracy 95% overall'),
		 ('a',2,'nothing relevant here')`); err != nil {
		t.Fatal(err)
	}
	// 搜索词里的 % 是字面量：不能变成通配符把第 2 页也搜出来。
	got := runSearch(t, frontend, cfg.Token, "95%")
	if len(got.Hits) != 1 || got.Hits[0].Page != 1 {
		t.Fatalf("%% 被当成了通配符：%+v", got.Hits)
	}
}

func TestSearchRejectsShortQuery(t *testing.T) {
	frontend, _, cfg := newTestServer(t, nil)
	response := do(t, frontend, http.MethodGet, "/v1/search?q=a", cfg.Token)
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("过短的搜索词应返回 400，得到 %d", response.StatusCode)
	}
}

func TestSearchTruncatesAndSaysSo(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('a','a','Paper')`); err != nil {
		t.Fatal(err)
	}
	for page := 1; page <= 5; page++ {
		if _, err := handle.Exec(
			`INSERT INTO document_pages(document_id,page,text) VALUES('a',?,'keyword appears here')`, page); err != nil {
			t.Fatal(err)
		}
	}
	response := do(t, frontend, http.MethodGet, "/v1/search?q=keyword&limit=2", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	var got searchPayload
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Hits) != 2 {
		t.Fatalf("limit 没有生效：%d 条", len(got.Hits))
	}
	// 截断必须显式告诉界面：否则用户会把「只看到 2 条」当成「只有 2 处」。
	if !got.Truncated {
		t.Fatal("结果被截断时 truncated 必须为 true")
	}
	if got.Matches != 5 {
		t.Fatalf("matches 应反映真实命中总数，得到 %d", got.Matches)
	}
}
