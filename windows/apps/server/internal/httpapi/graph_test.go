package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"cbctv2/server/internal/validate"
)

// graph_test.go：知识图谱三接口的行为契约。
//
// 夹具（newS6Server）里 2209.14540 有正文缓存（页 1「NAF abstract line.」、
// 页 2「We train using 50 views.」），intratomo-2021 没有正文；
// 模型侧复用 translate_test 的 fakeUpstream，不真花额度。

func graphExtract(t *testing.T, bundle *httptestServerBundle, body string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodPost, "/v1/graph/extract", body)
}

// validGraphJSON 是一份「诚实」的模型输出：三种 kind 的实体 + 两条关系，
// 证据都是夹具正文里真实存在的逐字摘录。
const validGraphJSON = `{
	"entities": [
		{"label": "Neural Attenuation Fields", "kind": "concept"},
		{"label": "volume rendering", "kind": "method"},
		{"label": "50 views suffice for training", "kind": "conclusion"}
	],
	"relations": [
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "使用",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "volume rendering", "to": "50 views suffice for training", "label": "得到",
			"evidence": [{"page": 1, "excerpt": "NAF abstract line."}]}
	]
}`

// fabricatedGraphJSON：第一条关系的证据是编造的（不在该页），第二条证据真实——
// 用来验证「丢证据计数 + 因无证据丢边 + 好边保留」三件事同时发生。
const fabricatedGraphJSON = `{
	"entities": [
		{"label": "Neural Attenuation Fields", "kind": "concept"},
		{"label": "Ghost Method", "kind": "method"},
		{"label": "volume rendering", "kind": "method"}
	],
	"relations": [
		{"from": "Neural Attenuation Fields", "to": "Ghost Method", "label": "使用",
			"evidence": [{"page": 2, "excerpt": "这句摘录根本不在原文里"}]},
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "使用",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]}
	]
}`

// countingGraphUpstream 起一个每次调用计数的 fake 上游，把计数透传给 reply，
// 供「skipped 不调模型 / force 才再调」这类断言使用。
func countingGraphUpstream(t *testing.T, reply func(calls int32) (string, int)) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	upstream := fakeUpstream(t, func(_ []string) (string, int) {
		return reply(calls.Add(1))
	})
	return upstream, &calls
}

func TestGraphExtractAndListVerifiedEvidence(t *testing.T) {
	bundle := newS6Server(t)
	upstream, calls := countingGraphUpstream(t, func(int32) (string, int) {
		return validGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("首次抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if payload["skipped"] != false {
		t.Fatalf("首次抽取应 skipped=false: %v", payload)
	}
	paper, ok := payload["paper"].(map[string]any)
	if !ok {
		t.Fatalf("缺少 paper: %v", payload)
	}
	if paper["key"] != "2209.14540" || paper["title"] != "NAF: Neural Attenuation Fields" {
		t.Fatalf("paper 基本信息异常: %v", paper)
	}
	if paper["nodeCount"] != float64(3) || paper["relationCount"] != float64(2) || paper["dropped"] != float64(0) {
		t.Fatalf("paper 计数异常（应 3/2/0）: %v", paper)
	}
	if stamp, _ := paper["extractedAt"].(string); stamp == "" {
		t.Fatal("extractedAt 不应为空")
	}
	if calls.Load() != 1 {
		t.Fatalf("应恰好调用模型 1 次，实际 %d", calls.Load())
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	nodes, _ := graph["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("应合并出 3 个节点，实际 %d: %v", len(nodes), graph["nodes"])
	}
	kinds := map[string]bool{}
	for _, raw := range nodes {
		node := raw.(map[string]any)
		docs, _ := node["docs"].([]any)
		if len(docs) != 1 || docs[0] != "2209.14540" {
			t.Fatalf("节点 docs 异常: %v", node)
		}
		kind, _ := node["kind"].(string)
		kinds[kind] = true
	}
	for _, kind := range []string{"concept", "method", "conclusion"} {
		if !kinds[kind] {
			t.Fatalf("缺少 kind=%s 的节点: %v", kind, kinds)
		}
	}

	edges, _ := graph["edges"].([]any)
	if len(edges) != 2 {
		t.Fatalf("应有 2 条边，实际 %d: %v", len(edges), graph["edges"])
	}
	edge := edges[0].(map[string]any)
	if edge["id"] != "neural attenuation fields→volume rendering→使用" {
		t.Fatalf("边 id 应为归一化端点拼接，实际 %v", edge["id"])
	}
	if docs, _ := edge["docs"].([]any); len(docs) != 1 || docs[0] != "2209.14540" {
		t.Fatalf("边 docs 异常: %v", edge)
	}
	evidence, _ := edge["evidence"].([]any)
	if len(evidence) != 1 {
		t.Fatalf("边应带 1 条证据，实际 %d", len(evidence))
	}
	item := evidence[0].(map[string]any)
	if item["paperKey"] != "2209.14540" || item["paperTitle"] != "NAF: Neural Attenuation Fields" {
		t.Fatalf("证据必须由后端注入 paperKey/paperTitle: %v", item)
	}
	if item["page"] != float64(2) || item["excerpt"] != "We train using 50 views." {
		t.Fatalf("证据内容应是逐字摘录: %v", item)
	}

	papers, _ := graph["papers"].([]any)
	if len(papers) != 1 {
		t.Fatalf("papers 应只有已抽取的一篇，实际 %v", graph["papers"])
	}
	if graph["totalDocuments"] != float64(1) {
		t.Fatalf("totalDocuments 应为 1（仅 2209.14540 有正文缓存），实际 %v", graph["totalDocuments"])
	}
}

func TestGraphFabricatedEvidenceIsDropped(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
		return fabricatedGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("抽取本身应 200（证据问题计入 dropped 而非整体失败），实际 %d %v", res.StatusCode, payload)
	}
	paper := payload["paper"].(map[string]any)
	// 1 条编造证据 + 因此失去全部证据的 1 条关系 = 2。
	if dropped, _ := paper["dropped"].(float64); dropped < 2 {
		t.Fatalf("编造证据应计入 dropped（≥2），实际 %v", paper)
	}
	if paper["relationCount"] != float64(1) {
		t.Fatalf("无有效证据的关系不应落库，实际 %v", paper)
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	edges, _ := graph["edges"].([]any)
	if len(edges) != 1 {
		t.Fatalf("编造证据的边不应出现，只留好边；实际 %v", graph["edges"])
	}
	edge := edges[0].(map[string]any)
	if edge["id"] != "neural attenuation fields→volume rendering→使用" {
		t.Fatalf("应保留证据真实的那条边: %v", edge["id"])
	}
	for _, raw := range edges {
		for _, rawEvidence := range raw.(map[string]any)["evidence"].([]any) {
			if excerpt, _ := rawEvidence.(map[string]any)["excerpt"].(string); strings.Contains(excerpt, "编造") || strings.Contains(excerpt, "不在原文") {
				t.Fatalf("编造的证据不得出现在图里: %v", rawEvidence)
			}
		}
	}
	papers, _ := graph["papers"].([]any)
	if len(papers) != 1 || papers[0].(map[string]any)["dropped"].(float64) < 2 {
		t.Fatalf("GET 的 papers 应带 dropped 计数: %v", graph["papers"])
	}
}

func TestGraphExtractSkipsUnlessForce(t *testing.T) {
	bundle := newS6Server(t)
	upstream, calls := countingGraphUpstream(t, func(int32) (string, int) {
		return validGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	if res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("首次抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 1 {
		t.Fatalf("首次应调模型 1 次，实际 %d", calls.Load())
	}

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK || payload["skipped"] != true {
		t.Fatalf("重复抽取非 force 应 200 且 skipped=true，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 1 {
		t.Fatalf("skipped 不得调模型，实际调用 %d 次", calls.Load())
	}
	if paper, _ := payload["paper"].(map[string]any); paper == nil || paper["nodeCount"] != float64(3) {
		t.Fatalf("skipped 应回当前 paper 信息: %v", payload)
	}

	res, payload = graphExtract(t, bundle, `{"key":"2209.14540","force":true}`)
	if res.StatusCode != http.StatusOK || payload["skipped"] != false {
		t.Fatalf("force 应重抽并 200，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 2 {
		t.Fatalf("force 应再次调模型，实际调用 %d 次", calls.Load())
	}
}

func TestGraphExtractRequiresSourceAndAIConfig(t *testing.T) {
	bundle := newS6Server(t) // 故意不写 config.json

	// 没有正文缓存 → 409（先于 AI 配置检查：没有原文就谈不上抽取）。
	res, payload := graphExtract(t, bundle, `{"key":"intratomo-2021"}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("无正文缓存应 409，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "正文缓存") {
		t.Fatalf("错误应说明缺正文缓存: %v", payload["error"])
	}

	// 有正文但未配置 AI → 409，文案指向先配置 AI。
	res, payload = graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("未配置 AI 应 409，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "config.json") {
		t.Fatalf("错误应提示先配置 AI: %v", payload["error"])
	}
}

func TestGraphExtractGuards(t *testing.T) {
	bundle := newS6Server(t)
	if res, _ := graphExtract(t, bundle, `{"key":""}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空 key 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := graphExtract(t, bundle, `{"key":"../etc"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法 key 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := graphExtract(t, bundle, `{oops`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("坏 JSON 应 400，实际 %d", res.StatusCode)
	}
	if res, _ := graphExtract(t, bundle, `{"key":"no-such-doc"}`); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
}

func TestGraphMergesSharedEntityAcrossPapers(t *testing.T) {
	bundle := newS6Server(t)
	upstream, calls := countingGraphUpstream(t, func(int32) (string, int) {
		return validGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	// 第二篇文档 + 正文夹具（SQL 直造，参考 s6_test 的 INSERT 写法）：
	// 两页正文与 2209.14540 相同，同一份模型输出对两篇都可通过逐字核验。
	if _, err := bundle.handle.Exec(
		`INSERT INTO documents(id, key, title, authors, status, added_at, updated_at, raw_json) VALUES
		 ('k2','k2','Second Paper','[]','queue','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','{}')`); err != nil {
		t.Fatal(err)
	}
	for _, page := range []struct {
		number int
		text   string
	}{{1, "NAF abstract line."}, {2, "We train using 50 views."}} {
		if _, err := bundle.handle.Exec(
			`INSERT INTO document_pages(document_id, page, text, hash, updated_at) VALUES('k2', ?, ?, 'h', '')`,
			page.number, page.text); err != nil {
			t.Fatal(err)
		}
	}

	if res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("第一篇抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if res, payload := graphExtract(t, bundle, `{"key":"k2"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("第二篇抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 2 {
		t.Fatalf("应调模型 2 次，实际 %d", calls.Load())
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	merged := false
	for _, raw := range graph["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["id"] != "neural attenuation fields" {
			continue
		}
		merged = true
		docs, _ := node["docs"].([]any)
		if len(docs) != 2 || docs[0] != "2209.14540" || docs[1] != "k2" {
			t.Fatalf("同名实体应合并成一个节点且 docs 升序: %v", docs)
		}
	}
	if !merged {
		t.Fatalf("两篇的同名实体未合并: %v", graph["nodes"])
	}

	papers, _ := graph["papers"].([]any)
	if len(papers) != 2 {
		t.Fatalf("papers 应有两篇，实际 %v", graph["papers"])
	}
	if key0, _ := papers[0].(map[string]any)["key"].(string); key0 != "2209.14540" {
		t.Fatalf("papers 应按 docKey 升序: %v", graph["papers"])
	}
	if key1, _ := papers[1].(map[string]any)["key"].(string); key1 != "k2" {
		t.Fatalf("papers 应按 docKey 升序: %v", graph["papers"])
	}
	if graph["totalDocuments"] != float64(2) {
		t.Fatalf("totalDocuments 应为 2，实际 %v", graph["totalDocuments"])
	}
}

func TestGraphDelete(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
		return validGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)
	if res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("抽取应 200，实际 %d %v", res.StatusCode, payload)
	}

	res, payload := deleteReq(t, bundle, "/v1/graph/2209.14540")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删除应 200，实际 %d %v", res.StatusCode, payload)
	}
	if payload["key"] != "2209.14540" || payload["deleted"] != true {
		t.Fatalf("删除响应应为 {key, deleted:true}: %v", payload)
	}
	if res, _ := deleteReq(t, bundle, "/v1/graph/2209.14540"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删除应 404，实际 %d", res.StatusCode)
	}
	if res, _ := deleteReq(t, bundle, "/v1/graph/intratomo-2021"); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未抽取过的键也应 404，实际 %d", res.StatusCode)
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	if nodes, _ := graph["nodes"].([]any); len(nodes) != 0 {
		t.Fatalf("删除后图应为空: %v", graph["nodes"])
	}
	if papers, _ := graph["papers"].([]any); len(papers) != 0 {
		t.Fatalf("删除后 papers 应为空: %v", graph["papers"])
	}
}

func TestGraphRejectsMalformedModelOutput(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(calls int32) (string, int) {
		if calls == 1 {
			return "这不是 JSON，只是一段散文。", http.StatusOK
		}
		return `{"entities":[{"label":"NAF","kind":"idea"}],"relations":[]}`, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	// 非 JSON → 502，错误里带原文摘要，且不落库。
	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("模型输出非 JSON 应 502，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "原文摘要") {
		t.Fatalf("502 应带模型原文摘要: %v", payload["error"])
	}
	assertGraphStateEmpty(t, bundle)

	// kind 白名单外 → 整份拒收 502，同样不落库。
	res, payload = graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusBadGateway {
		t.Fatalf("非法 kind 应 502，实际 %d %v", res.StatusCode, payload)
	}
	if msg, _ := payload["error"].(string); !strings.Contains(msg, "kind 非法") {
		t.Fatalf("错误应点明 kind 非法: %v", payload["error"])
	}
	assertGraphStateEmpty(t, bundle)
}

// assertGraphStateEmpty 断言失败的抽取没有写过 app_state['knowledge-graph']。
func assertGraphStateEmpty(t *testing.T, bundle *httptestServerBundle) {
	t.Helper()
	var count int
	if err := bundle.handle.QueryRow(
		`SELECT COUNT(*) FROM app_state WHERE key = 'knowledge-graph'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("失败的抽取不得写 app_state，实际存在 %d 行", count)
	}
}

// TestGraphListedEvidenceAlwaysRevalidates 锁死「每条关系都能回到原文依据」这条硬要求：
// 把 GET /v1/graph 吐出的每一条证据原样喂回校验器，必须全部通过——
// 也就是说列表里出现的任何摘录，都真的逐字存在于它标注的那一页。
//
// 这条断言独立于抽取路径：即便将来有人改了写入侧的判定，只要列表出现了
// 站不住脚的证据，这个测试就会红。混入一份「一半编造」的模型输出是刻意的。
func TestGraphListedEvidenceAlwaysRevalidates(t *testing.T) {
	for name, modelJSON := range map[string]string{
		"全部诚实": validGraphJSON,
		"半真半假": fabricatedGraphJSON,
	} {
		t.Run(name, func(t *testing.T) {
			bundle := newS6Server(t)
			upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
				return modelJSON, http.StatusOK
			})
			writeAIConfig(t, bundle, upstream.URL)

			if res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`); res.StatusCode != http.StatusOK {
				t.Fatalf("抽取应 200，实际 %d %v", res.StatusCode, payload)
			}

			graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
			// 用真实 handler 的同一条 sourceText 通路取正文，避免测试自造一份"更容易通过"的文本。
			source, err := New(bundle.cfg, bundle.handle).sourceText(context.Background(), "2209.14540")
			if err != nil {
				t.Fatal(err)
			}
			edges, _ := graph["edges"].([]any)
			if len(edges) == 0 {
				t.Fatal("列表里应当有边可核")
			}
			checked := 0
			for _, rawEdge := range edges {
				edge := rawEdge.(map[string]any)
				for _, rawEvidence := range edge["evidence"].([]any) {
					item := rawEvidence.(map[string]any)
					page := int(item["page"].(float64))
					excerpt, _ := item["excerpt"].(string)
					// 证据自带的 paperKey 必须指向它真正来自的那篇文档。
					if item["paperKey"] != "2209.14540" {
						t.Fatalf("证据 paperKey 异常: %v", item)
					}
					if err := validate.ValidateIdeaEvidence(validate.IdeaEvidence{
						Origin:   validate.OriginPaperText,
						PaperKey: "2209.14540",
						Page:     &page,
						Excerpt:  excerpt,
					}, source); err != nil {
						t.Fatalf("列表里的证据没通过逐字核验（说明有不可核的证据被展示）: page=%d excerpt=%q err=%v",
							page, excerpt, err)
					}
					checked++
				}
			}
			if checked == 0 {
				t.Fatal("应至少核验到一条证据")
			}
		})
	}
}

// ---- v2：规范术语/别名合并、受控关系词表、结论压力、缓存失效 ----

// insertGraphSecondPaper 造第二篇「正文与 2209.14540 逐字相同」的论文：
// 同一份模型输出对两篇都能通过逐字核验，跨文献合并才测得出东西。
func insertGraphSecondPaper(t *testing.T, bundle *httptestServerBundle) {
	t.Helper()
	if _, err := bundle.handle.Exec(
		`INSERT INTO documents(id, key, title, authors, status, added_at, updated_at, raw_json) VALUES
		 ('k2','k2','Second Paper','[]','queue','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','{}')`); err != nil {
		t.Fatal(err)
	}
	for _, page := range []struct {
		number int
		text   string
	}{{1, "NAF abstract line."}, {2, "We train using 50 views."}} {
		if _, err := bundle.handle.Exec(
			`INSERT INTO document_pages(document_id, page, text, hash, updated_at) VALUES('k2', ?, ?, 'h', '')`,
			page.number, page.text); err != nil {
			t.Fatal(err)
		}
	}
}

// seedGraphState 直接往 app_state 写一份图谱 JSON，绕开抽取通路：
// 用来测读取侧的版本门与「旧记录缺字段」的向后兼容。
func seedGraphState(t *testing.T, bundle *httptestServerBundle, body string) {
	t.Helper()
	if _, err := bundle.handle.Exec(
		`INSERT INTO app_state(key, value_json, updated_at) VALUES('knowledge-graph', ?, '')
		 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, body); err != nil {
		t.Fatal(err)
	}
}

// graphStateRows 返回 app_state['knowledge-graph'] 的行数：用于断言「过期记录不展示但也没被删」。
func graphStateRows(t *testing.T, bundle *httptestServerBundle) int {
	t.Helper()
	var count int
	if err := bundle.handle.QueryRow(
		`SELECT COUNT(*) FROM app_state WHERE key = 'knowledge-graph'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// aliasedGraphJSONA / aliasedGraphJSONB 是两篇各自抽出的「同一个概念」：
// label 一个中文一个英文，只有 aliases 相交。服务端只认「归一化后完全相等」，
// 所以 A 的别名与 B 的 label 必须折叠成同一个键才该合并。
const aliasedGraphJSONA = `{
	"entities": [
		{"label": "稀疏视角CT", "kind": "concept", "aliases": ["sparse-view CT"]}
	],
	"relations": []
}`

const aliasedGraphJSONB = `{
	"entities": [
		{"label": "Sparse-View CT", "kind": "concept", "aliases": ["稀疏视角 CT"]}
	],
	"relations": []
}`

// TestGraphMergesAliasedEntitiesAcrossPapers 是这次改造的核心：跨篇抽取看不到彼此，
// 只有把 aliases 纳入归一化键，中英各写一版的同一概念才不会被永久拆成两个节点。
func TestGraphMergesAliasedEntitiesAcrossPapers(t *testing.T) {
	bundle := newS6Server(t)
	insertGraphSecondPaper(t, bundle)
	upstream, calls := countingGraphUpstream(t, func(calls int32) (string, int) {
		if calls == 1 {
			return aliasedGraphJSONA, http.StatusOK
		}
		return aliasedGraphJSONB, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	if res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("第一篇抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if res, payload := graphExtract(t, bundle, `{"key":"k2"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("第二篇抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	if calls.Load() != 2 {
		t.Fatalf("应调模型 2 次，实际 %d", calls.Load())
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	nodes, _ := graph["nodes"].([]any)
	if len(nodes) != 1 {
		t.Fatalf("别名相交的两篇实体的应合并成 1 个节点，实际 %d: %v", len(nodes), nodes)
	}
	node := nodes[0].(map[string]any)
	// 展示沿用「首个出现者赢」：docKey 升序下 2209.14540 在前，所以 label 取它的中文写法。
	if node["label"] != "稀疏视角CT" {
		t.Fatalf("合并后 label 应取首个出现的原文写法，实际 %v", node["label"])
	}
	if node["id"] != "稀疏视角 ct" {
		t.Fatalf("合并后 id 应是归一化后的键，实际 %v", node["id"])
	}
	docs, _ := node["docs"].([]any)
	if len(docs) != 2 || docs[0] != "2209.14540" || docs[1] != "k2" {
		t.Fatalf("合并节点应带两篇来源且升序，实际 %v", docs)
	}
	aliases, _ := node["aliases"].([]any)
	// aliases 是「并集去重」：A 的 "sparse-view CT" 与 B 的 label "Sparse-View CT" 折叠后同键，
	// 所以保留首个出现的写法一份；与最终 label 同键的 "稀疏视角 CT" 必须被剔除。
	if len(aliases) != 1 || aliases[0] != "sparse-view CT" {
		t.Fatalf("别名应并集去重后只留一份英文写法，实际 %v", aliases)
	}
	for _, raw := range aliases {
		if normalizeEntityID(raw.(string)) == normalizeEntityID(node["label"].(string)) {
			t.Fatalf("与最终 label 归一化后同键的别名应被剔除，实际 %v", aliases)
		}
	}

	stats, _ := graph["stats"].(map[string]any)
	if stats["crossDocumentNodes"] != float64(1) || stats["mergedEntities"] != float64(1) {
		t.Fatalf("顶层统计应披露跨文献合并情况，实际 %v", graph["stats"])
	}
}

// legacyGraphJSONWithoutVersion / legacyGraphJSONV1 是旧契约的落库形状：
// 一份根本没有 promptVersion 字段，一份写着 v1。两者都必须被版本门判为过期。
// 里面刻意放了一条真实证据的边——「不展示」不能是因为没数据。
const legacyGraphJSONWithoutVersion = `{
	"docs": {
		"2209.14540": {
			"title": "NAF: Neural Attenuation Fields",
			"extractedAt": "2026-01-01T00:00:00Z",
			"entities": [
				{"id": "neural attenuation fields", "label": "Neural Attenuation Fields", "kind": "concept"},
				{"id": "volume rendering", "label": "volume rendering", "kind": "method"}
			],
			"relations": [
				{"from": "neural attenuation fields", "to": "volume rendering", "label": "使用",
					"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]}
			],
			"dropped": 0
		}
	}
}`

const legacyGraphJSONV1 = `{
	"promptVersion": "v1",
	"docs": {
		"2209.14540": {
			"title": "NAF: Neural Attenuation Fields",
			"extractedAt": "2026-01-01T00:00:00Z",
			"entities": [
				{"id": "neural attenuation fields", "label": "Neural Attenuation Fields", "kind": "concept"},
				{"id": "volume rendering", "label": "volume rendering", "kind": "method"}
			],
			"relations": [
				{"from": "neural attenuation fields", "to": "volume rendering", "label": "使用",
					"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]}
			],
			"dropped": 0
		}
	}
}`

// TestGraphStalePromptVersionIsIgnored 锁死缓存失效：改了提示词与合并逻辑之后，
// 旧记录必须整份视为「没抽过」——GET 返回空图，POST extract 重新抽，而不是把旧提示词
// 抽出的实体名继续展示。注意旧数据本身不删除。
func TestGraphStalePromptVersionIsIgnored(t *testing.T) {
	for name, stale := range map[string]string{
		"缺 promptVersion": legacyGraphJSONWithoutVersion,
		"v1 旧版本":          legacyGraphJSONV1,
	} {
		t.Run(name, func(t *testing.T) {
			bundle := newS6Server(t)
			upstream, calls := countingGraphUpstream(t, func(int32) (string, int) {
				return validGraphJSON, http.StatusOK
			})
			writeAIConfig(t, bundle, upstream.URL)
			seedGraphState(t, bundle, stale)

			graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
			for _, field := range []string{"nodes", "edges", "papers"} {
				if list, _ := graph[field].([]any); len(list) != 0 {
					t.Fatalf("过期记录不该展示，%s 应为空: %v", field, graph[field])
				}
			}
			if graph["totalDocuments"] != float64(1) {
				t.Fatalf("totalDocuments 与抽取无关，仍应是 1，实际 %v", graph["totalDocuments"])
			}
			// 只是不展示，数据本身不许被删掉。
			if rows := graphStateRows(t, bundle); rows != 1 {
				t.Fatalf("过期记录应原样留在 app_state 里: %d", rows)
			}

			res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
			if res.StatusCode != http.StatusOK || payload["skipped"] != false {
				t.Fatalf("过期记录必须允许重抽（skipped=false），实际 %d %v", res.StatusCode, payload)
			}
			if calls.Load() != 1 {
				t.Fatalf("重抽应调模型 1 次，实际 %d", calls.Load())
			}
			graph = decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
			if nodes, _ := graph["nodes"].([]any); len(nodes) != 3 {
				t.Fatalf("重抽后应看到新图（3 个节点），实际 %v", graph["nodes"])
			}
		})
	}
}

// offVocabularyGraphJSON：中间那条关系用了词表外的口语说法，其余两条合法。
const offVocabularyGraphJSON = `{
	"entities": [
		{"label": "Neural Attenuation Fields", "kind": "concept"},
		{"label": "volume rendering", "kind": "method"},
		{"label": "50 views suffice for training", "kind": "conclusion"}
	],
	"relations": [
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "搞定了",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "使用",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "volume rendering", "to": "50 views suffice for training", "label": "得出",
			"evidence": [{"page": 1, "excerpt": "NAF abstract line."}]}
	]
}`

// TestGraphDropsOffVocabularyRelation 验证受控词表是「丢这条关系 + 计入 dropped」，
// 而不是整份 502：一条措辞跑偏不该废掉整篇抽取。
func TestGraphDropsOffVocabularyRelation(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
		return offVocabularyGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("词表外的关系应只丢这一条，整体仍 200，实际 %d %v", res.StatusCode, payload)
	}
	paper := payload["paper"].(map[string]any)
	if paper["relationCount"] != float64(2) {
		t.Fatalf("两条合法关系应保留，实际 %v", paper)
	}
	if paper["dropped"] != float64(1) {
		t.Fatalf("词表外的关系应计入 dropped（恰好 1），实际 %v", paper)
	}
	if dropped := payload["stats"].(map[string]any)["droppedVocabulary"]; dropped != float64(1) {
		t.Fatalf("stats 应披露丢弃原因，实际 %v", payload["stats"])
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	edges, _ := graph["edges"].([]any)
	if len(edges) != 2 {
		t.Fatalf("应只有两条合法边，实际 %v", graph["edges"])
	}
	for _, raw := range edges {
		if label := raw.(map[string]any)["label"]; label != "使用" && label != "得出" {
			t.Fatalf("词表外的关系不得落库，实际 label=%v", label)
		}
	}
}

// englishRelationGraphJSON：三种英文/大小写写法，都必须映射回受控词表的中文 label。
const englishRelationGraphJSON = `{
	"entities": [
		{"label": "Neural Attenuation Fields", "kind": "concept"},
		{"label": "volume rendering", "kind": "method"}
	],
	"relations": [
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "use",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "Based on",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "Neural Attenuation Fields", "to": "volume rendering", "label": "Outperforms",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]}
	]
}`

// TestGraphNormalizesEnglishRelationSynonyms 验证词表归一化容忍英文同义词与大小写，
// 落库/展示的 label 一律是受控词表里的中文词（这是关系可比、前端图例能收敛的前提）。
func TestGraphNormalizesEnglishRelationSynonyms(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
		return englishRelationGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("英文同义词应被归一化而不是丢弃，实际 %d %v", res.StatusCode, payload)
	}
	if paper := payload["paper"].(map[string]any); paper["relationCount"] != float64(3) || paper["dropped"] != float64(0) {
		t.Fatalf("三条英文关系都应保留且不计 dropped，实际 %v", paper)
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	edges, _ := graph["edges"].([]any)
	if len(edges) != 3 {
		t.Fatalf("应有 3 条边，实际 %v", graph["edges"])
	}
	got := map[string]bool{}
	for _, raw := range edges {
		label, _ := raw.(map[string]any)["label"].(string)
		got[label] = true
	}
	for _, want := range []string{"使用", "基于", "优于"} {
		if !got[want] {
			t.Fatalf("英文写法应落成受控 label %q，实际 %v", want, got)
		}
	}
}

// aliasFreeGraphJSON 是一份「promptVersion 已经是 v2、但实体没有 aliases 字段」的记录：
// aliases 是可选字段，缺了必须按空数组处理，绝不能报错。
const aliasFreeGraphJSON = `{
	"promptVersion": "v2",
	"docs": {
		"2209.14540": {
			"title": "NAF: Neural Attenuation Fields",
			"extractedAt": "2026-01-01T00:00:00Z",
			"entities": [
				{"id": "neural attenuation fields", "label": "Neural Attenuation Fields", "kind": "concept"},
				{"id": "volume rendering", "label": "volume rendering", "kind": "method"}
			],
			"relations": [
				{"from": "neural attenuation fields", "to": "volume rendering", "label": "使用",
					"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]}
			],
			"dropped": 0
		}
	}
}`

// TestGraphToleratesLegacyRecordWithoutAliases 锁死存储契约的向后兼容：
// 旧记录（或手写记录）没有 aliases 字段时，读取侧不报错、节点照常合并展示。
func TestGraphToleratesLegacyRecordWithoutAliases(t *testing.T) {
	bundle := newS6Server(t)
	seedGraphState(t, bundle, aliasFreeGraphJSON)

	res := get(t, bundle.frontend, "/v1/graph", bundle.token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("缺 aliases 字段的记录应正常返回 200，实际 %d", res.StatusCode)
	}
	graph := decode(t, res)
	nodes, _ := graph["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("应正常合并出 2 个节点，实际 %v", graph["nodes"])
	}
	for _, raw := range nodes {
		node := raw.(map[string]any)
		aliases, ok := node["aliases"].([]any)
		if !ok {
			t.Fatalf("aliases 应是数组而不是 null: %v", node)
		}
		if len(aliases) != 0 {
			t.Fatalf("没有别名的节点 aliases 应为空数组，实际 %v", aliases)
		}
	}
	if edges, _ := graph["edges"].([]any); len(edges) != 1 {
		t.Fatalf("旧记录里的边应照常展示，实际 %v", graph["edges"])
	}
}

// conclusionRichGraphJSON：3 条结论 + 3 条指向结论的关系，用来验证「结论不能被丢」。
const conclusionRichGraphJSON = `{
	"entities": [
		{"label": "Neural Attenuation Fields", "kind": "concept", "aliases": ["NAF"]},
		{"label": "50 views suffice for training", "kind": "conclusion", "aliases": []},
		{"label": "稀疏视角重建质量下降", "kind": "conclusion", "aliases": []},
		{"label": "该方法需要视角先验", "kind": "conclusion", "aliases": []}
	],
	"relations": [
		{"from": "Neural Attenuation Fields", "to": "50 views suffice for training", "label": "得出",
			"evidence": [{"page": 2, "excerpt": "We train using 50 views."}]},
		{"from": "NAF", "to": "稀疏视角重建质量下降", "label": "导致",
			"evidence": [{"page": 1, "excerpt": "NAF abstract line."}]},
		{"from": "Neural Attenuation Fields", "to": "该方法需要视角先验", "label": "包含",
			"evidence": [{"page": 1, "excerpt": "NAF abstract line."}]}
	]
}`

// TestGraphKeepsConclusionsAndLinksToThem 验证结论类实体以及与结论相连的关系全部保留
// （kind 正确、不被词表/端点判定误伤），并且结论占比统计与提示词配额一致。
func TestGraphKeepsConclusionsAndLinksToThem(t *testing.T) {
	bundle := newS6Server(t)
	upstream, _ := countingGraphUpstream(t, func(int32) (string, int) {
		return conclusionRichGraphJSON, http.StatusOK
	})
	writeAIConfig(t, bundle, upstream.URL)

	res, payload := graphExtract(t, bundle, `{"key":"2209.14540"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("抽取应 200，实际 %d %v", res.StatusCode, payload)
	}
	paper := payload["paper"].(map[string]any)
	if paper["nodeCount"] != float64(4) || paper["relationCount"] != float64(3) || paper["dropped"] != float64(0) {
		t.Fatalf("3 条结论与 3 条关系都应保留（4/3/0），实际 %v", paper)
	}
	stats := payload["stats"].(map[string]any)
	// 端点 "NAF" 是别名，应解析回同一个概念节点。
	if stats["conclusions"] != float64(3) || stats["conclusionLinks"] != float64(3) {
		t.Fatalf("结论与指向结论的关系计数异常: %v", stats)
	}
	if stats["conclusionRatio"] != float64(1) || stats["conclusionQuotaMet"] != true {
		t.Fatalf("结论占比与配额标记异常: %v", stats)
	}
	if stats["mergedEntities"] != float64(0) {
		t.Fatalf("这篇内部没有靠别名合并的实体，实际 %v", stats)
	}

	graph := decode(t, get(t, bundle.frontend, "/v1/graph", bundle.token))
	conclusions := 0
	for _, raw := range graph["nodes"].([]any) {
		node := raw.(map[string]any)
		if node["kind"] == "conclusion" {
			conclusions++
			continue
		}
		if node["kind"] != "concept" {
			t.Fatalf("kind 只应是 concept/conclusion，实际 %v", node)
		}
	}
	if conclusions != 3 {
		t.Fatalf("三条 conclusion 都要落库，实际 %d: %v", conclusions, graph["nodes"])
	}
	edges, _ := graph["edges"].([]any)
	if len(edges) != 3 {
		t.Fatalf("指向结论的边应全部保留，实际 %v", graph["edges"])
	}
	// 别名端点必须改写成合并后的节点 id，不能留下悬空边。
	for _, raw := range edges {
		edge := raw.(map[string]any)
		if edge["from"] != "neural attenuation fields" {
			t.Fatalf("别名端点应改写为合并后的节点 id，实际 %v", edge)
		}
	}
	if stats := graph["stats"].(map[string]any); stats["crossDocumentNodes"] != float64(0) {
		t.Fatalf("只有一篇时应无跨文献节点，实际 %v", stats)
	}
}
