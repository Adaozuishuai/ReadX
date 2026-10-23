package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestCiteTitleKeyRejectsShortTitles(t *testing.T) {
	cases := []struct {
		title string
		empty bool
	}{
		{"NAF: Neural Attenuation Fields", false},
		{"Sparse-View CT Reconstruction", false},
		{"CT", true},
		{"", true},
		{"   ", true},
		{"《稀疏视角重建》", false},
	}
	for _, tc := range cases {
		got := citeTitleKey(tc.title)
		if tc.empty && got != "" {
			t.Fatalf("citeTitleKey(%q) = %q，应当拒绝过短题名", tc.title, got)
		}
		if !tc.empty && got == "" {
			t.Fatalf("citeTitleKey(%q) 不应为空", tc.title)
		}
	}
	// 大小写与标点不应影响匹配键。
	if citeTitleKey("Sparse-View CT!") != citeTitleKey("sparse view ct") {
		t.Fatal("题名归一化没有抹平大小写与标点")
	}
}

// matchCitationNetwork 是这块唯一能脱离网络验证的核心逻辑：DOI/题名匹配、自我排除、去重。
func TestMatchCitationNetwork(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	self := "self"
	rows := []struct{ key, title, doi string }{
		{self, "Sparse view CT reconstruction", "10.1000/self"},
		{"by-doi", "Some referenced paper", "10.1109/TMI.2020.1234567"},
		{"by-title", "Another referenced paper", ""},
		{"citer", "A paper citing us", "10.1000/citer"},
	}
	for _, row := range rows {
		if _, err := handle.Exec(`INSERT INTO documents(id,key,title,doi,year) VALUES(?,?,?,?,2022)`,
			row.key, row.key, row.title, row.doi); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{handle: handle, cfg: cfg}

	references := []openAlexWorkRef{
		// DOI 大小写与 https://doi.org/ 前缀都不应影响命中。
		{DOI: "https://doi.org/10.1109/TMI.2020.1234567", Title: "Some referenced paper", Year: 2020},
		// 没有 DOI：回退到题名匹配。
		{Title: "Another Referenced Paper!", Year: 2021},
		// 指向自己：必须排除，否则会出现「本文引用了本文」。
		{DOI: "10.1000/self", Title: "Sparse view CT reconstruction", Year: 2022},
		// 库外：只进 external。
		{DOI: "10.5555/outside", Title: "Outside work", Year: 2023},
	}
	citing := []openAlexWorkRef{
		{DOI: "10.1000/citer", Title: "A paper citing us", Year: 2024},
		// 既在参考文献又在引用里：只保留一条，优先 reference。
		{DOI: "10.1109/TMI.2020.1234567", Title: "Some referenced paper", Year: 2020},
	}

	counts, edges, external := server.matchCitationNetwork(context.Background(), self, references, citing)
	if counts.InLibraryReferences != 2 {
		t.Fatalf("库内参考文献应为 2 篇，得到 %d（edges=%+v）", counts.InLibraryReferences, edges)
	}
	// by-doi 同时在参考文献与引用列表里（互相引用）：只保留一条边，计数也必须跟着只有 1。
	if counts.InLibraryCitations != 1 {
		t.Fatalf("库内引用应为 1 篇，得到 %d（edges=%+v）", counts.InLibraryCitations, edges)
	}
	if len(edges) != counts.InLibraryReferences+counts.InLibraryCitations {
		t.Fatalf("计数与边表不一致：counts=%d+%d, edges=%d",
			counts.InLibraryReferences, counts.InLibraryCitations, len(edges))
	}
	relations := map[string]string{}
	for _, edge := range edges {
		if edge.Key == self {
			t.Fatal("自我引用必须排除")
		}
		if _, seen := relations[edge.Key]; seen {
			t.Fatalf("同一篇出现了多条边：%s", edge.Key)
		}
		relations[edge.Key] = edge.Relation
	}
	if relations["by-doi"] != "reference" || relations["by-title"] != "reference" || relations["citer"] != "citation" {
		t.Fatalf("关系判定不对：%+v", relations)
	}
	if len(external) == 0 {
		t.Fatal("库外题录不应为空：至少应给出被引用的库外论文")
	}
	for _, item := range external {
		if item.Title == "" {
			t.Fatal("库外题录缺题名")
		}
	}
}

func TestCitationNetworkWithoutDOIIsNotAnError(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('nodoi','nodoi','No DOI paper')`); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/documents/nodoi/citations", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	// 没有 DOI 是「查不了」，不是「服务出错」：界面要能区分这两件事。
	if response.StatusCode != http.StatusOK {
		t.Fatalf("返回 %d：%s", response.StatusCode, body)
	}
	var payload struct {
		Available  bool     `json:"available"`
		Disclosure []string `json:"disclosure"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Available {
		t.Fatal("没有 DOI 时 available 应为 false")
	}
	if len(payload.Disclosure) == 0 {
		t.Fatal("必须说明为什么查不了")
	}
}

func TestCitationNetworkServesCacheWithoutNetwork(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,doi) VALUES('cached','cached','Cached paper','10.1000/cached')`); err != nil {
		t.Fatal(err)
	}
	cached := `{"key":"cached","title":"Cached paper","doi":"10.1000/cached","available":true,` +
		`"openAlexId":"W1","inLibrary":[{"key":"other","title":"Other","year":2020,"doi":"","relation":"reference"}],` +
		`"external":[],"counts":{"references":1,"citations":0,"resolvedReferences":1,"inLibraryReferences":1,"inLibraryCitations":0},` +
		`"disclosure":["来自缓存"]}`
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?)`,
		citationNetworkKey("cached"), cached, nowStamp()); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/documents/cached/citations", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("返回 %d：%s", response.StatusCode, body)
	}
	var payload struct {
		FromCache bool `json:"fromCache"`
		InLibrary []struct {
			Key string `json:"key"`
		} `json:"inLibrary"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	// 命中缓存时不应发起网络请求：这里没有可达的 OpenAlex，能返回就说明走的是缓存。
	if !payload.FromCache {
		t.Fatalf("应标记为缓存命中：%s", body)
	}
	if len(payload.InLibrary) != 1 || payload.InLibrary[0].Key != "other" {
		t.Fatalf("缓存内容没有原样返回：%s", body)
	}
}

func TestCitationNetworkExpiredCacheIsIgnored(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,doi) VALUES('old','old','Old paper','10.1000/old')`); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?)`,
		citationNetworkKey("old"), `{"key":"old","available":true}`, "2020-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	server := &Server{handle: handle, cfg: cfg}
	if _, _, ok := server.loadCitationNetworkCache(context.Background(), "old"); ok {
		t.Fatal("超过 TTL 的缓存必须失效，否则引用关系会一直停在旧数据上")
	}
}
