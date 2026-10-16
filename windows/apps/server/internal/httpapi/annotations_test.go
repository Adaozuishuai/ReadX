package httpapi

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func newAnnotationServer(t *testing.T) *httptestServerBundle {
	t.Helper()
	bundle, _ := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	return bundle
}

func TestAnnotationCRUDRoundTrip(t *testing.T) {
	bundle := newAnnotationServer(t)

	create := func(body string) (*http.Response, map[string]any) {
		return post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540", body)
	}

	res, created := create(`{"page":1,"kind":"highlight","quote":"We train using 50 views","note":"和 NAF 正文对照","color":"amber","tags":["几何"]}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("创建应 201，实际 %d %v", res.StatusCode, created)
	}
	id, _ := created["id"].(string)
	if id == "" || created["kind"] != "highlight" {
		t.Fatalf("返回体异常: %v", created)
	}

	list := decode(t, get(t, bundle.frontend, "/v1/annotations/2209.14540", bundle.token))
	items := list["annotations"].([]any)
	if len(items) != 1 {
		t.Fatalf("列表应有 1 条，实际 %v", list)
	}
	first := items[0].(map[string]any)
	if first["quote"] != "We train using 50 views" || first["note"] != "和 NAF 正文对照" {
		t.Fatalf("读回内容不一致: %v", first)
	}
	if tags, ok := first["tags"].([]any); !ok || len(tags) != 1 || tags[0] != "几何" {
		t.Fatalf("标签未持久化: %v", first["tags"])
	}

	patched, patchedBody := post(t, bundle, http.MethodPatch, "/v1/annotation/"+id, `{"note":"改过的批注","color":"sky"}`)
	if patched.StatusCode != http.StatusOK {
		t.Fatalf("更新应 200，实际 %d %v", patched.StatusCode, patchedBody)
	}
	list = decode(t, get(t, bundle.frontend, "/v1/annotations/2209.14540", bundle.token))
	updated := list["annotations"].([]any)[0].(map[string]any)
	if updated["note"] != "改过的批注" || updated["color"] != "sky" {
		t.Fatalf("更新未生效: %v", updated)
	}

	req, _ := http.NewRequest(http.MethodDelete, bundle.frontend.URL+"/v1/annotation/"+id, nil)
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	del, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	del.Body.Close()
	if del.StatusCode != http.StatusOK {
		t.Fatalf("删除应 200，实际 %d", del.StatusCode)
	}
	list = decode(t, get(t, bundle.frontend, "/v1/annotations/2209.14540", bundle.token))
	if len(list["annotations"].([]any)) != 0 {
		t.Fatalf("删除后列表应为空: %v", list)
	}
	if res := get(t, bundle.frontend, "/v1/annotation/does-not-exist", bundle.token); res.StatusCode != http.StatusNotFound {
		t.Fatalf("删除不存在的批注应 404，实际 %d", res.StatusCode)
	}
}

func TestAnnotationGuards(t *testing.T) {
	bundle := newAnnotationServer(t)

	cases := []struct {
		name   string
		body   string
		status int
	}{
		{"空摘录", `{"page":1,"quote":"  "}`, http.StatusBadRequest},
		{"未知类型", `{"page":1,"quote":"abc","kind":"circle"}`, http.StatusBadRequest},
		{"未知颜色", `{"page":1,"quote":"abc","color":"chartreuse"}`, http.StatusBadRequest},
		{"页码为 0", `{"page":0,"quote":"abc"}`, http.StatusBadRequest},
		{"负页码", `{"page":-3,"quote":"abc"}`, http.StatusBadRequest},
		{"标签过长", `{"page":1,"quote":"abc","tags":["` + strings.Repeat("标", 30) + `"]}`, http.StatusBadRequest},
		{"标签含换行", "{\"page\":1,\"quote\":\"abc\",\"tags\":[\"a\\nb\"]}", http.StatusBadRequest},
		{"摘录超长", `{"page":1,"quote":"` + strings.Repeat("字", maxAnnotationQuote+10) + `"}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, payload := post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540", c.body)
			if res.StatusCode != c.status {
				t.Fatalf("应 %d，实际 %d %v", c.status, res.StatusCode, payload)
			}
		})
	}

	if res, _ := post(t, bundle, http.MethodPost, "/v1/annotations/nope", `{"page":1,"quote":"abc"}`); res.StatusCode != http.StatusNotFound {
		t.Fatalf("未知文档应 404，实际 %d", res.StatusCode)
	}
	if res := get(t, bundle.frontend, "/v1/annotations/..%2F..%2Fetc", bundle.token); res.StatusCode == http.StatusOK {
		t.Fatal("非法键不得返回 200")
	}
}

func TestAnnotationDefaultsAndDedupTags(t *testing.T) {
	bundle := newAnnotationServer(t)
	_, created := post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540",
		`{"page":2,"quote":"NAF achieves 33.05 dB","tags":[" 重复 ","重复","","重复"]}`)
	if created["kind"] != "highlight" || created["color"] != "amber" {
		t.Fatalf("缺省值应为 highlight/amber: %v", created)
	}
	tags := created["tags"].([]any)
	if len(tags) != 1 || tags[0] != "重复" {
		t.Fatalf("标签应去空白并去重: %v", created["tags"])
	}
}

func TestAnnotationExportMarkdown(t *testing.T) {
	bundle := newAnnotationServer(t)
	post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540",
		`{"page":1,"kind":"highlight","quote":"We train using 50 views","note":"视图数","color":"amber","tags":["几何"]}`)
	post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540",
		`{"page":2,"kind":"question","quote":"NAF achieves 33.05 dB","note":"和 FDK 的对比条件一致吗？","color":"rose"}`)
	// 未标页码的批注也要导出，不能静默丢失。
	post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540", `{"quote":"跨页的想法","note":"待归页"}`)

	req, _ := http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/annotations/2209.14540/export", nil)
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	res, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	text := string(body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("导出应 200，实际 %d", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/markdown") {
		t.Fatalf("Content-Type 应为 markdown，实际 %q", ct)
	}
	if cd := res.Header.Get("Content-Disposition"); !strings.Contains(cd, "2209.14540-annotations.md") {
		t.Fatalf("文件名异常: %q", cd)
	}
	for _, want := range []string{"# 批注 · NAF", "## Page 1", "## Page 2", "## 未标页码", "> We train using 50 views", "**问题**", "`几何`", "和 FDK 的对比条件一致吗"} {
		if !strings.Contains(text, want) {
			t.Fatalf("导出缺少 %q:\n%s", want, text)
		}
	}
	// 顺序：页 1 在页 2 之前，未标页码在最后。
	if strings.Index(text, "## Page 1") > strings.Index(text, "## Page 2") {
		t.Fatal("导出应按页码排序")
	}
	if strings.Index(text, "## 未标页码") < strings.Index(text, "## Page 2") {
		t.Fatal("未标页码的批注应排在最后")
	}
}

func TestAnnotationsCascadeWithDocument(t *testing.T) {
	bundle := newAnnotationServer(t)
	post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540", `{"page":1,"quote":"We train using 50 views"}`)
	if _, err := bundle.handle.Exec(`DELETE FROM documents WHERE id='2209.14540'`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM annotations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("删文档应级联清掉批注，实际残留 %d 条", count)
	}
}

func TestExportFilenameIsSanitised(t *testing.T) {
	// 导出文件名只可能由 safekey 通过的键生成，这里再确认一次：
	// 不出现路径分隔符、不以点开头，且带 .md 后缀。
	bundle := newAnnotationServer(t)
	post(t, bundle, http.MethodPost, "/v1/annotations/2209.14540", `{"page":1,"quote":"We train using 50 views"}`)
	req, _ := http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/annotations/2209.14540/export", nil)
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	res, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	filename := res.Header.Get("Content-Disposition")
	if strings.ContainsAny(filename, "/\\") || strings.Contains(filename, "..") {
		t.Fatalf("文件名含路径成分: %q", filename)
	}
	if !strings.HasSuffix(filename, ".md\"") {
		t.Fatalf("文件名应以 .md 结尾: %q", filename)
	}
}
