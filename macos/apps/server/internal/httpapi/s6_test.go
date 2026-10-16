package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"
)

func newS6Server(t *testing.T) *httptestServerBundle {
	t.Helper()
	bundle, _ := newSeededServer(t)
	return bundle
}

func patch(t *testing.T, bundle *httptestServerBundle, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodPatch, path, body)
}

func deleteReq(t *testing.T, bundle *httptestServerBundle, path string) (*http.Response, map[string]any) {
	t.Helper()
	return post(t, bundle, http.MethodDelete, path, "")
}

func TestDocumentMetaRoundTrip(t *testing.T) {
	bundle := newS6Server(t)

	res, created := patch(t, bundle, "/v1/documents/2209.14540/meta", `{"favorite":true,"tags":["几何","重建"]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("更新元数据应 200，实际 %d %v", res.StatusCode, created)
	}
	if created["favorite"] != true {
		t.Fatalf("收藏未生效: %v", created)
	}

	// 只改标签不应把收藏清掉（合并式更新）。
	_, updated := patch(t, bundle, "/v1/documents/2209.14540/meta", `{"tags":["几何"]}`)
	if updated["favorite"] != true {
		t.Fatalf("局部更新不得重置收藏: %v", updated)
	}
	tags := updated["tags"].([]any)
	if len(tags) != 1 || tags[0] != "几何" {
		t.Fatalf("标签未更新: %v", updated["tags"])
	}

	// 回收站语义：标记 deleted，不物理删除。
	_, trashed := patch(t, bundle, "/v1/documents/2209.14540/meta", `{"deleted":true}`)
	if trashed["deleted"] != true || trashed["favorite"] != true {
		t.Fatalf("回收站标记应保留其它字段: %v", trashed)
	}

	list := decode(t, get(t, bundle.frontend, "/v1/documents-meta", bundle.token))
	items := list["meta"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["deleted"] != true {
		t.Fatalf("元数据列表异常: %v", list)
	}
}

func TestDocumentMetaGuards(t *testing.T) {
	bundle := newS6Server(t)
	if res, _ := patch(t, bundle, "/v1/documents/no-such-doc/meta", `{"favorite":true}`); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
	// 标签含换行必须被拒（会破坏导出与展示）。
	if res, _ := patch(t, bundle, "/v1/documents/2209.14540/meta", "{\"tags\":[\"a\\nb\"]}"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法标签应 400，实际 %d", res.StatusCode)
	}
}

func TestTagListAggregatesAndDedupes(t *testing.T) {
	bundle := newS6Server(t)
	patch(t, bundle, "/v1/documents/2209.14540/meta", `{"tags":["几何","重建"]}`)
	patch(t, bundle, "/v1/documents/intratomo-2021/meta", `{"tags":["重建","低剂量"]}`)
	payload := decode(t, get(t, bundle.frontend, "/v1/tags", bundle.token))
	tags := payload["tags"].([]any)
	if len(tags) != 3 {
		t.Fatalf("标签应去重后为 3 个，实际 %v", tags)
	}
	if tags[0] != "低剂量" {
		t.Fatalf("标签应排序，实际 %v", tags)
	}
}

func TestTrendsReportSampleAndCoverage(t *testing.T) {
	bundle := newS6Server(t)
	payload := decode(t, get(t, bundle.frontend, "/v1/trends", bundle.token))
	sample := payload["sample"].(map[string]any)
	if sample["count"] != float64(2) {
		t.Fatalf("样本数应为 2，实际 %v", sample)
	}
	if payload["minimum"] != float64(5) {
		t.Fatalf("最小样本量应披露为 5，实际 %v", payload["minimum"])
	}
	if _, ok := payload["findings"].([]any); !ok {
		t.Fatalf("findings 应为数组: %v", payload["findings"])
	}
	if res := do(t, bundle.frontend, http.MethodGet, "/v1/trends?status=nope", bundle.token); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知 status 应 400，实际 %d", res.StatusCode)
	}
}

func TestIdeaCRUDAndStatusWorkflow(t *testing.T) {
	bundle := newS6Server(t)

	res, created := post(t, bundle, http.MethodPost, "/v1/ideas",
		`{"question":"能否把 NAF 用到稀疏角度？","status":"Idea","evidence":[{"origin":"AI 解释","paperKey":"2209.14540","paperTitle":"NAF","excerpt":"可能可以"}]}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("创建想法应 201，实际 %d %v", res.StatusCode, created)
	}
	id, _ := created["id"].(string)
	if id == "" || created["status"] != "Idea" {
		t.Fatalf("返回体异常: %v", created)
	}

	// AI 解释来源不需要逐字摘录，应直接通过。
	_, planned := patch(t, bundle, "/v1/idea/"+id, `{"status":"Planned"}`)
	if planned["status"] != "Planned" {
		t.Fatalf("状态流转失败: %v", planned)
	}

	res, _ = patch(t, bundle, "/v1/idea/"+id, `{"status":"Nope"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法状态应 400，实际 %d", res.StatusCode)
	}

	list := decode(t, get(t, bundle.frontend, "/v1/ideas", bundle.token))
	if len(list["ideas"].([]any)) != 1 {
		t.Fatalf("列表应有 1 条: %v", list)
	}

	res, _ = deleteReq(t, bundle, "/v1/idea/"+id)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删除应 200，实际 %d", res.StatusCode)
	}
	if res, _ := deleteReq(t, bundle, "/v1/idea/"+id); res.StatusCode != http.StatusNotFound {
		t.Fatalf("重复删除应 404，实际 %d", res.StatusCode)
	}
}

func TestIdeaPaperEvidenceMustVerify(t *testing.T) {
	bundle := newS6Server(t)

	// origin=论文原文 且摘录能在该页逐字找到：通过。
	res, _ := post(t, bundle, http.MethodPost, "/v1/ideas",
		`{"question":"q","evidence":[{"origin":"论文原文","paperKey":"2209.14540","paperTitle":"NAF","page":2,"excerpt":"We train using 50 views."}]}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("可核验的原文证据应通过，实际 %d", res.StatusCode)
	}

	// 摘录不在该页：必须被拒，不能凭 origin 标签蒙混。
	res, _ = post(t, bundle, http.MethodPost, "/v1/ideas",
		`{"question":"q","evidence":[{"origin":"论文原文","paperKey":"2209.14540","paperTitle":"NAF","page":2,"excerpt":"这句话并不在原文里"}]}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("无法核验的原文证据应 400，实际 %d", res.StatusCode)
	}

	// 非法 origin：拒。
	if res, _ := post(t, bundle, http.MethodPost, "/v1/ideas",
		`{"question":"q","evidence":[{"origin":"模型猜测","paperKey":"2209.14540","excerpt":"x"}]}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法 origin 应 400，实际 %d", res.StatusCode)
	}
}

func TestIdeasCorruptionIsNotSilentlyDropped(t *testing.T) {
	bundle := newS6Server(t)
	if _, err := bundle.handle.Exec(
		`INSERT INTO app_state(key, value_json, updated_at) VALUES('ideas', 'not-json', '')`); err != nil {
		t.Fatal(err)
	}
	// 损坏数据应报错而不是返回空列表——返回空会让下一次写入覆盖用户的全部想法。
	res, _ := post(t, bundle, http.MethodPost, "/v1/ideas", `{"question":"q"}`)
	if res.StatusCode != http.StatusInternalServerError {
		t.Fatalf("损坏想法数据应 500，实际 %d", res.StatusCode)
	}
}

func TestDuplicatesEndpoint(t *testing.T) {
	bundle := newS6Server(t)
	payload := decode(t, get(t, bundle.frontend, "/v1/duplicates", bundle.token))
	groups, ok := payload["groups"].([]any)
	if !ok {
		t.Fatalf("groups 应为数组: %v", payload["groups"])
	}
	// 5 篇互不重复的真实论文：不应凭空报重复。
	if len(groups) != 0 || payload["total"] != float64(0) {
		t.Fatalf("库里无重复时应为空，实际 %v", payload)
	}

	// 插入一篇 arXiv 同号（带版本号）的重复项，应被识别为一组。
	if _, err := bundle.handle.Exec(
		`INSERT INTO documents(id, key, title, authors, status, added_at, updated_at, raw_json) VALUES
		 ('dup-1','dup-1','NAF duplicate','[]','queue','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{"arxiv":"2209.14540v3"}')`); err != nil {
		t.Fatal(err)
	}
	payload = decode(t, get(t, bundle.frontend, "/v1/duplicates", bundle.token))
	groups = payload["groups"].([]any)
	if len(groups) != 1 {
		t.Fatalf("应识别出 1 组重复，实际 %v", groups)
	}
	keys := groups[0].(map[string]any)["keys"].([]any)
	if len(keys) != 2 {
		t.Fatalf("重复组应含 2 个键，实际 %v", keys)
	}
}

func TestCategoryCRUDAndAssignment(t *testing.T) {
	bundle := newS6Server(t)

	res, payload := post(t, bundle, http.MethodPost, "/v1/categories", `{"name":"几何","color":"sky"}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("新建分类应 201，实际 %d %v", res.StatusCode, payload)
	}
	// 同名再提交是改色（upsert），不是新建。
	res, payload = post(t, bundle, http.MethodPost, "/v1/categories", `{"name":"几何","color":"rose"}`)
	if res.StatusCode != http.StatusOK || payload["updated"] != true {
		t.Fatalf("同名应改色: %d %v", res.StatusCode, payload)
	}

	// 把分类挂到论文上。
	_, meta := patch(t, bundle, "/v1/documents/2209.14540/meta", `{"categories":["几何"]}`)
	cats := meta["categories"].([]any)
	if len(cats) != 1 || cats[0] != "几何" {
		t.Fatalf("分类未挂上: %v", meta["categories"])
	}

	list := decode(t, get(t, bundle.frontend, "/v1/categories", bundle.token))
	if len(list["categories"].([]any)) != 1 {
		t.Fatalf("分类列表异常: %v", list)
	}

	// 删分类定义应同时摘掉论文上的引用。
	res, _ = post(t, bundle, http.MethodDelete, "/v1/category/几何", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删除分类应 200，实际 %d", res.StatusCode)
	}
	metaList := decode(t, get(t, bundle.frontend, "/v1/documents-meta", bundle.token))
	for _, raw := range metaList["meta"].([]any) {
		item := raw.(map[string]any)
		if cs := item["categories"].([]any); len(cs) != 0 {
			t.Fatalf("删分类后论文不应残留该引用: %v", item)
		}
	}
	if res, _ := post(t, bundle, http.MethodDelete, "/v1/category/%E4%B8%8D%E5%AD%98%E5%9C%A8", ""); res.StatusCode != http.StatusNotFound {
		t.Fatalf("删除不存在的分类应 404，实际 %d", res.StatusCode)
	}
}

func TestCategoryGuards(t *testing.T) {
	bundle := newS6Server(t)
	if res, _ := post(t, bundle, http.MethodPost, "/v1/categories", `{"name":"  "}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("空名应 400，实际 %d", res.StatusCode)
	}
	if res, _ := post(t, bundle, http.MethodPost, "/v1/categories", `{"name":"x","color":"chartreuse"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知颜色应 400，实际 %d", res.StatusCode)
	}
	if res, _ := patch(t, bundle, "/v1/documents/2209.14540/meta", "{\"categories\":[\"a\nb\"]}"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("分类名含换行应 400，实际 %d", res.StatusCode)
	}
}

func TestReproductionAnalyzeAndTaskBoard(t *testing.T) {
	bundle := newS6Server(t)

	// 没有全文缓存的论文：拒绝（无原文依据无法校验）。
	if res, _ := post(t, bundle, http.MethodPost, "/v1/reproduction/intratomo-2021/analyze", `{"value":"{}"}`); res.StatusCode != http.StatusConflict {
		t.Fatalf("无正文缓存应 409，实际 %d", res.StatusCode)
	}

	// 五组都必须 1–4 项（与 v1 校验一致）；只有 resources 有真实页码证据，其余走「论文未说明」。
	analysis := `{"resources":[{"finding":{"k":"代码","v":"提供代码","page":2,"excerpt":"We train using 50 views."},"assessment":"已确认","action":"克隆仓库"}],"environment":[{"finding":{"k":"依赖","v":"论文未说明","page":null,"excerpt":null},"assessment":"未知","action":"核对 requirements"}],"cost":[{"finding":{"k":"显存","v":"论文未说明","page":null,"excerpt":null},"assessment":"未知","action":"实测占用"}],"missing":[{"finding":{"k":"预处理","v":"论文未说明","page":null,"excerpt":null},"assessment":"未知","action":"核对预处理"}],"risks":[{"finding":{"k":"评测协议","v":"论文未说明","page":null,"excerpt":null},"assessment":"未知","action":"对齐协议"}]}`
	res, payload := post(t, bundle, http.MethodPost, "/v1/reproduction/2209.14540/analyze", `{"value":`+jsonString(analysis)+`}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("合法分析应 200，实际 %d %v", res.StatusCode, payload)
	}
	revision, _ := payload["revision"].(string)
	if revision == "" {
		t.Fatalf("应返回 revision: %v", payload)
	}
	if payload["unknownCount"] != float64(4) {
		t.Fatalf("未知项计数应为 4，实际 %v", payload["unknownCount"])
	}

	// 更新单个核对项状态。
	_, task := patch(t, bundle, "/v1/reproduction/2209.14540/task",
		`{"revision":"`+revision+`","itemId":"代码|2","status":"verified","note":"已跑通"}`)
	board := task["task"].(map[string]any)
	if board["status"] != "verified" || board["note"] != "已跑通" {
		t.Fatalf("核对项未保存: %v", board)
	}

	// 读回清单应保留状态。
	got := decode(t, get(t, bundle.frontend, "/v1/reproduction/2209.14540", bundle.token))
	checklist := got["checklist"].(map[string]any)
	revisions := checklist["revisions"].(map[string]any)
	if revisions[revision] == nil {
		t.Fatalf("清单应按指纹保留 revision: %v", revisions)
	}
}

func TestReproductionGuards(t *testing.T) {
	bundle := newS6Server(t)
	// 非法状态
	if res, _ := patch(t, bundle, "/v1/reproduction/2209.14540/task", `{"revision":"r","itemId":"i","status":"nope"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法状态应 400，实际 %d", res.StatusCode)
	}
	// 保留名 revision：会污染内存映射，必须拒绝
	if res, _ := patch(t, bundle, "/v1/reproduction/2209.14540/task", `{"revision":"__proto__","itemId":"i","status":"todo"}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("保留名 revision 应 400，实际 %d", res.StatusCode)
	}
	// 校验不过的分析（未知项缺核对行动）
	bad := `{"resources":[{"finding":{"k":"代码","v":"论文未说明","page":null,"excerpt":null},"assessment":"","action":""}],"environment":[],"cost":[],"missing":[],"risks":[]}`
	if res, _ := post(t, bundle, http.MethodPost, "/v1/reproduction/2209.14540/analyze", `{"value":`+jsonString(bad)+`}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("缺核对行动应 400，实际 %d", res.StatusCode)
	}
}

func TestRepoChecksEndpoint(t *testing.T) {
	bundle := newS6Server(t)
	res, payload := post(t, bundle, http.MethodPost, "/v1/reproduction/repo-checks",
		`{"files":[{"path":"requirements.txt","lines":["torch"]},{"path":"a.py","lines":["# download https://drive.google.com/x"]}]}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("repo-checks 应 200，实际 %d", res.StatusCode)
	}
	checks := payload["checks"].([]any)
	if len(checks) != 2 {
		t.Fatalf("应识别 1 个依赖文件 + 1 个数据下载，实际 %d", len(checks))
	}
}

// jsonString 把一个 JSON 文本安全地嵌进另一个 JSON 字符串字段。
func jsonString(raw string) string {
	encoded, _ := json.Marshal(raw)
	return string(encoded)
}
