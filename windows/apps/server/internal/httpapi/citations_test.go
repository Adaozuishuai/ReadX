package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestCitationsExportSingleDocument(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,authors,year,venue,doi,url) VALUES(?,?,?,?,?,?,?,?)`,
		"2209.14540", "2209.14540", "NAF: Neural Attenuation Fields",
		`["Ruyi Zha","Yanhao Zhang"]`, 2022, "ECCV 2022", "10.1000/naf", "https://arxiv.org/abs/2209.14540"); err != nil {
		t.Fatal(err)
	}
	if _, err := handle.Exec(
		`INSERT INTO app_state(key,value_json) VALUES('documents.meta',?)`,
		`{"2209.14540":{"tags":["CBCT","sparse view"],"categories":["CBCT 重建"]}}`); err != nil {
		t.Fatal(err)
	}

	response := do(t, frontend, http.MethodGet, "/v1/citations?format=bibtex&keys=2209.14540", cfg.Token)
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("导出返回 %d：%s", response.StatusCode, body)
	}
	text := string(body)
	for _, want := range []string{
		"@inproceedings{zha2022naf,",
		"author = {Ruyi Zha and Yanhao Zhang}",
		"booktitle = {ECCV 2022}",
		"eprint = {2209.14540}",
		"keywords = {CBCT, CBCT 重建, sparse view}",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("导出内容缺少 %q\n---\n%s", want, text)
		}
	}
	if got := response.Header.Get("X-ReadX-Exported"); got != "1" {
		t.Fatalf("X-ReadX-Exported = %q, want 1", got)
	}
	if got := response.Header.Get("X-ReadX-Skipped"); got != "0" {
		t.Fatalf("X-ReadX-Skipped = %q, want 0", got)
	}
	if got := response.Header.Get("Content-Disposition"); !strings.Contains(got, "2209.14540.bib") {
		t.Fatalf("单篇导出的文件名应取自论文键，得到 %q", got)
	}
}

func TestCitationsReportSkippedKeys(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('a','a','Paper A')`); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/citations?keys="+url.QueryEscape("a,missing-key"), cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("导出返回 %d：%s", response.StatusCode, body)
	}
	if got := response.Header.Get("X-ReadX-Exported"); got != "1" {
		t.Fatalf("X-ReadX-Exported = %q, want 1", got)
	}
	// 找不到的论文不能静默少导出：跳过的数量必须如实回报。
	if got := response.Header.Get("X-ReadX-Skipped"); got != "1" {
		t.Fatalf("X-ReadX-Skipped = %q, want 1", got)
	}
	if strings.Contains(string(body), "missing-key") {
		t.Fatal("不存在的论文不应出现在导出内容里")
	}
}

func TestCitationsCategoryScopeExcludesTrash(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	for _, key := range []string{"shelf-1", "shelf-2", "other-1", "trashed-1"} {
		if _, err := handle.Exec(`INSERT INTO documents(id,key,title,year) VALUES(?,?,?,2021)`, key, key, "Title "+key); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := handle.Exec(`INSERT INTO app_state(key,value_json) VALUES('documents.meta',?)`,
		`{"shelf-1":{"categories":["CBCT"]},"shelf-2":{"categories":["CBCT"]},"other-1":{"categories":["MRI"]},"trashed-1":{"categories":["CBCT"],"deleted":true}}`); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/citations?category="+url.QueryEscape("CBCT"), cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("按书架导出返回 %d：%s", response.StatusCode, body)
	}
	text := string(body)
	if got := response.Header.Get("X-ReadX-Exported"); got != "2" {
		t.Fatalf("书架内有 2 篇未删除论文，X-ReadX-Exported = %q", got)
	}
	if strings.Contains(text, "other-1") || strings.Contains(text, "trashed-1") {
		t.Fatalf("书架范围没被正确收窄：\n%s", text)
	}
}

func TestCitationsRIS(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,authors,year,venue) VALUES('j','j','A Study','["Ada Lovelace"]',2019,'IEEE Transactions on Medical Imaging')`); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/citations?format=ris&keys=j", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("RIS 导出返回 %d：%s", response.StatusCode, body)
	}
	text := string(body)
	for _, want := range []string{"TY  - JOUR", "AU  - Ada Lovelace", "JO  - IEEE Transactions on Medical Imaging", "ER  - "} {
		if !strings.Contains(text, want) {
			t.Fatalf("RIS 缺少 %q\n---\n%s", want, text)
		}
	}
	if got := response.Header.Get("Content-Type"); !strings.Contains(got, "research-info-systems") {
		t.Fatalf("RIS 的 Content-Type = %q", got)
	}
}

func TestCitationsRejectsUnknownFormatAndScopeConflict(t *testing.T) {
	frontend, _, cfg := newTestServer(t, nil)
	for _, path := range []string{
		"/v1/citations?format=endnote",
		"/v1/citations?keys=a&category=CBCT",
	} {
		response := do(t, frontend, http.MethodGet, path, cfg.Token)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s 返回 %d，期望 400", path, response.StatusCode)
		}
	}
}

func TestCitationPreviewDisclosesInferredTypes(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	if _, err := handle.Exec(
		`INSERT INTO documents(id,key,title,year,venue) VALUES('conf','conf','Conference paper',2022,'ECCV 2022')`); err != nil {
		t.Fatal(err)
	}
	// 没有会场信息的一篇：条目类型判不出来，必须出现在 warnings 里。
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('plain','plain','No venue paper')`); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/citations/preview", cfg.Token)
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("preview 返回 %d：%s", response.StatusCode, body)
	}
	var payload struct {
		Count    int `json:"count"`
		Items    []struct {
			Key   string `json:"key"`
			Kind  string `json:"kind"`
			Basis string `json:"basis"`
		} `json:"items"`
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Count != 2 || len(payload.Items) != 2 {
		t.Fatalf("preview 应覆盖 2 篇：%s", body)
	}
	kinds := map[string]string{}
	for _, item := range payload.Items {
		kinds[item.Key] = item.Kind
		if strings.TrimSpace(item.Basis) == "" {
			t.Fatalf("%s 缺少判定依据", item.Key)
		}
	}
	if kinds["conf"] != "inproceedings" || kinds["plain"] != "misc" {
		t.Fatalf("条目类型判定不符：%v", kinds)
	}
	joined := strings.Join(payload.Warnings, " / ")
	if !strings.Contains(joined, "会场") {
		t.Fatalf("缺少会场信息必须出现在 warnings 里，得到 %q", joined)
	}
}