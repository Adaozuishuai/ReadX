package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"cbctv2/server/internal/db"
)

// 「AI 直接写盘」的第一道闸：默认关闭时接口必须拒绝，且磁盘不能变。
func TestLatexAutoFixIsGatedByProjectSwitch(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	// 新建项目默认不开（默认关闭是这条功能的成败关键）。
	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id, "")
	if res.StatusCode != http.StatusOK || payload["aiAutoFix"] != false {
		t.Fatalf("新项目默认不该开启 AI 直接写盘: %d %v", res.StatusCode, payload)
	}

	before := readProjectFile(t, bundle, id, "main.tex")
	res, payload = post(t, bundle, http.MethodPost, "/v1/ai/latex-autofix",
		`{"projectId":"`+id+`","projectTitle":"t","filePath":"main.tex","question":""}`)
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("未开启时应当 403，实际 %d %v", res.StatusCode, payload)
	}
	if after := readProjectFile(t, bundle, id, "main.tex"); after != before {
		t.Fatal("被拒绝的请求不能改动源码")
	}

	// 开启开关后：不再是 403（本机没有 AI 凭据时应当是 503，说明闸门确实放行了）。
	res, payload = post(t, bundle, http.MethodPatch, "/v1/latex/projects/"+id, `{"aiAutoFix":true}`)
	if res.StatusCode != http.StatusOK || payload["aiAutoFix"] != true {
		t.Fatalf("开关没能保存: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodPost, "/v1/ai/latex-autofix",
		`{"projectId":"`+id+`","projectTitle":"t","filePath":"main.tex","question":""}`)
	if res.StatusCode == http.StatusForbidden {
		t.Fatalf("开启后不该再被闸门拒绝: %v", payload)
	}
	if res.StatusCode != http.StatusServiceUnavailable && res.StatusCode != http.StatusOK {
		t.Fatalf("开启后应当进入 AI 调用（无凭据时 503），实际 %d %v", res.StatusCode, payload)
	}
	// 非 .tex 依旧拒绝（即使开关打开）。
	body, _ := json.Marshal(map[string]any{"projectId": id, "filePath": "references.bib", "question": ""})
	res, _ = post(t, bundle, http.MethodPost, "/v1/ai/latex-autofix", string(body))
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("非 .tex 必须 400，实际 %d", res.StatusCode)
	}
}

func TestLatexSnapshotsOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	original := readProjectFile(t, bundle, id, "main.tex")

	res, payload := post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/snapshots", `{"note":"手动快照"}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("打快照失败: %d %v", res.StatusCode, payload)
	}
	snapshotID, _ := payload["id"].(string)
	if snapshotID == "" || payload["fileCount"] == float64(0) {
		t.Fatalf("快照元数据不完整: %v", payload)
	}

	// 改内容 + 加新文件，然后回滚。
	updated, _ := json.Marshal(map[string]any{"content": "改坏了", "revision": ""})
	if res, _ = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path=main.tex", string(updated)); res.StatusCode != http.StatusOK {
		t.Fatalf("写入失败: %d", res.StatusCode)
	}
	if res, _ = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops", `{"op":"new-file","to":"later.tex"}`); res.StatusCode != http.StatusOK {
		t.Fatalf("新建失败: %d", res.StatusCode)
	}

	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/snapshots", "")
	if res.StatusCode != http.StatusOK || payload["total"] != float64(1) {
		t.Fatalf("快照列表不对: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/snapshots/"+snapshotID, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("回滚失败: %d %v", res.StatusCode, payload)
	}
	if readProjectFile(t, bundle, id, "main.tex") != original {
		t.Fatal("回滚后内容应当与快照一致")
	}
	removed, _ := payload["removedFiles"].([]any)
	if len(removed) == 0 {
		t.Fatalf("回滚移除了文件就必须如实报告: %v", payload)
	}
	// 快照之后新增的文件应当已不存在。
	res, _ = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/file?path=later.tex", "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("回滚应当移除快照之后新增的文件，实际 %d", res.StatusCode)
	}

	res, _ = post(t, bundle, http.MethodDelete, "/v1/latex/snapshots/"+snapshotID, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删除快照失败: %d", res.StatusCode)
	}
	// 非法编号一律拒绝。
	res, _ = post(t, bundle, http.MethodGet, "/v1/latex/snapshots/..%2Fescape", "")
	if res.StatusCode != http.StatusBadRequest && res.StatusCode != http.StatusNotFound {
		t.Fatalf("非法快照编号应当被拒绝，实际 %d", res.StatusCode)
	}
}

func readProjectFile(t *testing.T, bundle *httptestServerBundle, projectID, path string) string {
	t.Helper()
	res, payload := post(t, bundle, http.MethodGet,
		"/v1/latex/projects/"+projectID+"/file?path="+url.QueryEscape(path), "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("读 %s 失败: %d %v", path, res.StatusCode, payload)
	}
	content, _ := payload["content"].(string)
	return content
}

func newLatexBundle(t *testing.T) *httptestServerBundle {
	t.Helper()
	cfg := defaultTestConfig(t.TempDir())
	handle, err := db.Open(context.Background(), cfg.DBPath())
	if err != nil {
		t.Fatalf("打开测试库失败: %v", err)
	}
	return serve(t, cfg, handle)
}

func createLatexProject(t *testing.T, bundle *httptestServerBundle) string {
	t.Helper()
	res, payload := post(t, bundle, http.MethodPost, "/v1/latex/projects",
		`{"title":"测试项目","engine":"xelatex","mainFile":"main.tex"}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("新建项目失败: %d %v", res.StatusCode, payload)
	}
	id, _ := payload["id"].(string)
	if id == "" {
		t.Fatalf("新建项目没有返回编号: %v", payload)
	}
	if payload["engine"] != "xelatex" {
		t.Fatalf("引擎没保存: %v", payload)
	}
	return id
}

func TestLatexToolchainAndBuildRoutesOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)

	// 工具链如实报告：三个引擎都在清单里，不可用的必须带原因。
	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/toolchains", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("工具链接口失败: %d %v", res.StatusCode, payload)
	}
	engines, _ := payload["engines"].([]any)
	if len(engines) != 3 {
		t.Fatalf("应当报告三个引擎: %v", payload)
	}
	for _, raw := range engines {
		tool, _ := raw.(map[string]any)
		if tool["usable"] == false && (tool["reason"] == nil || tool["reason"] == "") {
			t.Fatalf("不可用的引擎必须说明原因: %v", tool)
		}
	}
	if payload["strategy"] == "unavailable" {
		t.Skip("本机没有 TeX 引擎，跳过编译接口验证")
	}

	// 发起编译：接受 202（异步），随后轮询到结束。
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/builds", "")
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("发起编译应当返回 202，实际 %d %v", res.StatusCode, payload)
	}
	buildID, _ := payload["id"].(string)
	if buildID == "" {
		t.Fatalf("没有返回编译编号: %v", payload)
	}
	deadline := time.Now().Add(3 * time.Minute)
	var final map[string]any
	for time.Now().Before(deadline) {
		res, final = post(t, bundle, http.MethodGet, "/v1/latex/builds/"+buildID, "")
		if res.StatusCode != http.StatusOK {
			t.Fatalf("查询编译状态失败: %d %v", res.StatusCode, final)
		}
		status, _ := final["status"].(string)
		if status != "queued" && status != "running" {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if final["status"] != "succeeded" {
		t.Fatalf("模板项目应当编译成功，实际 %v（%v）", final["status"], final["message"])
	}
	if final["hasPdf"] != true || final["pages"] == float64(0) {
		t.Fatalf("应当产出带页数的 PDF: %v", final)
	}

	// 项目历史里能看到它，且最后一次编译指针已更新。
	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/builds", "")
	if res.StatusCode != http.StatusOK || payload["total"] != float64(1) {
		t.Fatalf("编译历史不对: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/builds/"+buildID+"/log", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("读日志失败: %d %v", res.StatusCode, payload)
	}
	if log, _ := payload["log"].(string); !strings.Contains(log, "pdfTeX") && !strings.Contains(log, "This is") {
		t.Fatalf("日志内容不像 TeX 输出: %q", truncateForTest(log, 120))
	}

	// PDF 下载：必须是真 PDF。
	request, _ := http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/latex/builds/"+buildID+"/pdf", nil)
	request.Header.Set("Authorization", "Bearer "+bundle.token)
	response, err := bundle.frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.HasPrefix(body, []byte("%PDF-")) {
		t.Fatalf("PDF 响应不对: %d %q", response.StatusCode, truncateForTest(string(body), 20))
	}
	if response.Header.Get("Content-Type") != "application/pdf" {
		t.Fatalf("PDF 的 Content-Type 不对: %q", response.Header.Get("Content-Type"))
	}
}

func truncateForTest(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…"
}

func TestLatexEngineInjectionOverHTTPFallsBack(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/toolchains", "")
	if res.StatusCode != http.StatusOK || payload["strategy"] == "unavailable" {
		t.Skip("本机没有 TeX 引擎，跳过引擎回落验证")
	}
	// 请求里塞一个命令：绝不能被执行，只能回落到白名单里的引擎。
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/builds",
		`{"engine":"pdflatex; rm -rf /"}`)
	if res.StatusCode == http.StatusAccepted {
		engine, _ := payload["engine"].(string)
		if engine != "pdflatex" && engine != "latexmk" {
			t.Fatalf("非法引擎必须回落到白名单，实际 %q", engine)
		}
		_, _ = post(t, bundle, http.MethodPost, "/v1/latex/builds/"+payload["id"].(string)+"/cancel", "")
	}
}

func TestLatexRoutesRequireAuth(t *testing.T) {
	bundle := newLatexBundle(t)
	// 未鉴权时不能读到项目数据。（未知路径由 mux 直接 404，属于既有行为，不在这里断言。）
	for _, path := range []string{
		"/v1/latex/projects",
	} {
		response := do(t, bundle.frontend, http.MethodGet, path, "")
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s 未带 token 时应当 401，实际 %d", path, response.StatusCode)
		}
	}
}

func TestLatexProjectLifecycleOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)

	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/projects", "")
	if res.StatusCode != http.StatusOK || payload["total"] != float64(1) {
		t.Fatalf("项目列表不对: %d %v", res.StatusCode, payload)
	}

	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/tree", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("文件树请求失败: %d %v", res.StatusCode, payload)
	}
	nodes, _ := payload["nodes"].([]any)
	found := false
	for _, raw := range nodes {
		node, _ := raw.(map[string]any)
		if node["path"] == "main.tex" && node["kind"] == "tex" {
			found = true
		}
	}
	if !found {
		t.Fatalf("文件树里应当有 main.tex: %v", payload)
	}

	res, payload = post(t, bundle, http.MethodPatch, "/v1/latex/projects/"+id, `{"title":"改名","autoCompile":true}`)
	if res.StatusCode != http.StatusOK || payload["title"] != "改名" || payload["autoCompile"] != true {
		t.Fatalf("局部更新失败: %d %v", res.StatusCode, payload)
	}

	res, _ = post(t, bundle, http.MethodDelete, "/v1/latex/projects/"+id, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("删除项目失败: %d", res.StatusCode)
	}
	res, _ = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id, "")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("删除后应当 404: %d", res.StatusCode)
	}
}

func TestLatexFileReadWriteAndConflict(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)

	res, payload := post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/file?path=main.tex", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("读文件失败: %d %v", res.StatusCode, payload)
	}
	content, _ := payload["content"].(string)
	revision, _ := payload["revision"].(string)
	if !strings.Contains(content, `\documentclass`) || revision == "" {
		t.Fatalf("读到的文件内容/revision 不对: %v", payload)
	}

	// 正确的 revision：保存成功，revision 变化。
	body, _ := json.Marshal(map[string]any{"content": content + "\n% 追加\n", "revision": revision})
	res, payload = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path=main.tex", string(body))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("保存失败: %d %v", res.StatusCode, payload)
	}
	if payload["revision"] == revision {
		t.Fatal("保存后 revision 必须变化")
	}

	// 过期的 revision：409，前端据此提示重新加载。
	stale, _ := json.Marshal(map[string]any{"content": "覆盖", "revision": revision})
	res, _ = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path=main.tex", string(stale))
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("过期 revision 应当 409，实际 %d", res.StatusCode)
	}

	// 图片不能当文本读写：415。
	res, _ = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/file?path=figures/plot.png", "")
	if res.StatusCode != http.StatusUnsupportedMediaType && res.StatusCode != http.StatusNotFound {
		t.Fatalf("二进制读取应当被拒绝（415/404），实际 %d", res.StatusCode)
	}
}

func TestLatexPathsRejectTraversalOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	escape := []string{
		"..%2F..%2Fapp%2Fconfig.json",
		"..%2Fsecret.tex",
		"%2Fetc%2Fpasswd",
		"C%3A%2FWindows%2Fwin.ini",
	}
	for _, path := range escape {
		res, payload := post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/file?path="+path, "")
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("逃逸路径 %s 应当 400，实际 %d %v", path, res.StatusCode, payload)
		}
		body, _ := json.Marshal(map[string]any{"content": "pwned", "revision": ""})
		res, payload = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path="+path, string(body))
		if res.StatusCode != http.StatusBadRequest {
			t.Fatalf("逃逸路径写入 %s 应当 400，实际 %d %v", path, res.StatusCode, payload)
		}
	}
	// 绝对路径与 .. 不能出现在 URL 里而不被解码：这里再确认一次「正常路径仍然可用」。
	res, _ := post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id+"/file?path=sections/method.tex", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("正常相对路径应当可用，实际 %d", res.StatusCode)
	}
}

func TestLatexFileOpsOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)

	res, payload := post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops",
		`{"op":"new-dir","to":"appendix"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("新建目录失败: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops",
		`{"op":"new-file","to":"appendix/extra.tex"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("新建文件失败: %d %v", res.StatusCode, payload)
	}
	// 重命名根文档：设置必须跟着改，否则项目指向不存在的入口。
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops",
		`{"op":"rename","from":"main.tex","to":"paper.tex"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("重命名根文档失败: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodGet, "/v1/latex/projects/"+id, "")
	if payload["mainFile"] != "paper.tex" {
		t.Fatalf("重命名后根文档设置没跟着改: %v", payload)
	}
	// 逃逸的文件操作同样被拒。
	res, _ = post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops",
		`{"op":"copy","from":"paper.tex","to":"../escaped.tex"}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("逃逸的复制应当 400，实际 %d", res.StatusCode)
	}
}

func TestLatexImportAndExportZipOverHTTP(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)

	archive := realProjectZip(t)
	request, err := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/latex/projects/"+id+"/import-zip", bytes.NewReader(archive))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+bundle.token)
	request.Header.Set("Content-Type", "application/zip")
	response, err := bundle.frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("导入 ZIP 失败: %d %s", response.StatusCode, body)
	}
	var report map[string]any
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatal(err)
	}
	if report["files"] != float64(2) || report["mainFile"] != "main.tex" {
		t.Fatalf("导入报告不对: %v", report)
	}

	// 导出：拿到真正的 ZIP（PK 魔数），且不含副产物。
	request, _ = http.NewRequest(http.MethodGet, bundle.frontend.URL+"/v1/latex/projects/"+id+"/export-zip", nil)
	request.Header.Set("Authorization", "Bearer "+bundle.token)
	response, err = bundle.frontend.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	exported, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.HasPrefix(exported, []byte("PK")) {
		t.Fatalf("导出不是 ZIP: %d %q", response.StatusCode, string(exported[:min(16, len(exported))]))
	}
	if disposition := response.Header.Get("Content-Disposition"); !strings.Contains(disposition, ".zip") {
		t.Fatalf("导出缺少下载文件名: %q", disposition)
	}
	reader, err := zip.NewReader(bytes.NewReader(exported), int64(len(exported)))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	if !names["main.tex"] || names["main.aux"] {
		t.Fatalf("导出内容不对: %+v", names)
	}
}

// realProjectZip 造一个「真实项目」压缩包：带公共顶层目录与一个编译副产物。
func realProjectZip(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	for name, content := range map[string]string{
		"paper/main.tex":           "\\documentclass{article}\n\\begin{document}Hi\\end{document}",
		"paper/main.aux":           "\\relax",
		"paper/sections/intro.tex": "\\section{Intro}",
	} {
		file, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
