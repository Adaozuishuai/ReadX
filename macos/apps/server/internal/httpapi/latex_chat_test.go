package httpapi

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLatexChatProjectEditCanBeSavedAndRolledBack(t *testing.T) {
	bundle := newLatexBundle(t)
	id := createLatexProject(t, bundle)
	const target = "sec/0_abstract.tex"
	const original = "\\begin{abstract}\nAccuracy is 95 percent on 3 datasets.\n\\end{abstract}"
	const modified = "\\begin{abstract}\nAccuracy is measured on datasets.\n\\end{abstract}"
	res, payload := post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/file-ops", `{"op":"new-file","to":"`+target+`"}`)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("create abstract: %d %v", res.StatusCode, payload)
	}
	sourceBody, _ := json.Marshal(map[string]string{"content": original, "revision": ""})
	res, payload = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path="+target, string(sourceBody))
	if res.StatusCode != http.StatusOK {
		t.Fatalf("write abstract: %d %v", res.StatusCode, payload)
	}
	revision := payload["revision"].(string)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var input struct{ Messages []struct{ Content string } }
		_ = json.Unmarshal(body, &input)
		if len(input.Messages) < 2 || !strings.Contains(input.Messages[0].Content, original) {
			t.Error("chat did not receive the referenced project source")
		}
		content, _ := json.Marshal(map[string]string{
			"reply": "已生成摘要修改", "summary": "删除摘要中的数字",
			"filePath": target, "original": "model must not control the baseline", "content": modified,
		})
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]string{"content": string(content)}}},
		})
	}))
	defer upstream.Close()
	writeAIConfig(t, bundle, upstream.URL)

	body, _ := json.Marshal(map[string]any{
		"projectId": id, "filePath": "main.tex", "source": readProjectFile(t, bundle, id, "main.tex"),
		"question": "将 abstract 里的数字删掉",
		"history":  []map[string]string{{"role": "ai", "text": "我无法修改磁盘文件"}},
	})
	req, _ := http.NewRequest(http.MethodPost, bundle.frontend.URL+"/v1/ai/latex-chat", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := bundle.frontend.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var completion struct {
		Done  bool                 `json:"done"`
		Error string               `json:"error"`
		Edit  *latexAIEditResponse `json:"edit"`
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	for scanner.Scan() {
		if strings.HasPrefix(scanner.Text(), "data: ") {
			var event struct {
				Done  bool                 `json:"done"`
				Error string               `json:"error"`
				Edit  *latexAIEditResponse `json:"edit"`
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &event); err != nil {
				t.Fatal(err)
			}
			if event.Done || event.Error != "" {
				completion = event
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !completion.Done || completion.Error != "" || completion.Edit == nil {
		t.Fatalf("normal chat has no executable edit: %+v", completion)
	}
	if completion.Edit.FilePath != target || completion.Edit.Original != original || completion.Edit.Content != modified {
		t.Fatalf("wrong target or untrusted baseline: %+v", completion.Edit)
	}
	if readProjectFile(t, bundle, id, target) != original {
		t.Fatal("proposal generation must not write before the client applies it")
	}
	res, snapshot := post(t, bundle, http.MethodPost, "/v1/latex/projects/"+id+"/snapshots", `{"note":"AI 修改前"}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("snapshot: %d %v", res.StatusCode, snapshot)
	}
	saveBody, _ := json.Marshal(map[string]string{"content": completion.Edit.Content, "revision": revision})
	res, payload = post(t, bundle, http.MethodPut, "/v1/latex/projects/"+id+"/file?path="+target, string(saveBody))
	if res.StatusCode != http.StatusOK || readProjectFile(t, bundle, id, target) != modified {
		t.Fatalf("edit not saved to disk: %d %v", res.StatusCode, payload)
	}
	res, payload = post(t, bundle, http.MethodPost, "/v1/latex/snapshots/"+snapshot["id"].(string), "")
	if res.StatusCode != http.StatusOK || readProjectFile(t, bundle, id, target) != original {
		t.Fatalf("rollback did not restore original: %d %v", res.StatusCode, payload)
	}
}

func TestLatexChatResultDistinguishesAnswersFromEdits(t *testing.T) {
	sources := map[string]string{"sec/0_abstract.tex": "original"}
	reply, edit, err := parseLatexChatResult(`{"reply":"这是摘要内容的解释","filePath":"","content":""}`, sources)
	if err != nil || edit != nil || reply == "" {
		t.Fatalf("answer: %q %+v %v", reply, edit, err)
	}
	for _, invalid := range []string{
		`{"reply":"已改","filePath":"../outside.tex","content":"changed"}`,
		`{"reply":"已改","filePath":"missing.tex","content":"changed"}`,
		`{"reply":"已改","filePath":"sec/0_abstract.tex","content":""}`,
		"not JSON",
	} {
		if _, _, err := parseLatexChatResult(invalid, sources); err == nil {
			t.Fatalf("accepted invalid edit: %s", invalid)
		}
	}
}
