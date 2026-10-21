package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestTrashEmptyRemovesLibraryCopyAndPreservesOriginalAndActiveFiles(t *testing.T) {
	bundle, paths := newImportServer(t)
	post(t, bundle, http.MethodPost, "/v1/import", "")
	original := filepath.Join(t.TempDir(), "original-paper.pdf")
	data := []byte("%PDF-1.4\noriginal paper content\n")
	if err := os.WriteFile(original, data, 0600); err != nil {
		t.Fatal(err)
	}
	result, err := New(bundle.cfg, bundle.handle).importPublication(context.Background(), "original-paper.pdf", original, data)
	if err != nil {
		t.Fatal(err)
	}
	importedKey := result.Document.Key
	copyPath := filepath.Join(paths.LibraryDir(), importedKey+".pdf")
	files := map[string]string{}
	activeCopy := filepath.Join(paths.LibraryDir(), "2209.14540.pdf")
	for _, name := range []string{original, activeCopy, paths.TextCacheFile("2209.14540"), paths.ReadingFile("2209.14540")} {
		body, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = string(body)
	}
	for _, key := range []string{"2209.14540", importedKey} {
		if res, _ := patch(t, bundle, "/v1/documents/"+key+"/meta", `{"deleted":true,"favorite":true,"tags":["trash"]}`); res.StatusCode != 200 {
			t.Fatal(res.StatusCode)
		}
		queries := []string{
			`INSERT OR REPLACE INTO document_pages(document_id,page,text) VALUES(?,1,'source')`,
			`INSERT OR REPLACE INTO readings(document_id,value_json) VALUES(?,'{}')`,
			`INSERT INTO annotations(id,document_id) VALUES('ann-' || ?,?)`,
			`INSERT INTO translations(document_id,para_hash,source,target) VALUES(?,'hash','source','target')`,
			`INSERT INTO document_sections(document_id,ordinal,href,title,blocks_json,text) VALUES(?,1,'section','title','[]','source')`,
			`INSERT INTO reading_locations(document_id,location_json,updated_at) VALUES(?,'{}','')`,
		}
		for index, query := range queries {
			args := []any{key}
			if index == 2 {
				args = append(args, key)
			}
			if _, err := bundle.handle.Exec(query, args...); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := bundle.handle.Exec(`INSERT INTO app_state(key,value_json) VALUES(?,'{}')`, "reproduction:"+key); err != nil {
			t.Fatal(err)
		}
	}
	patch(t, bundle, "/v1/documents/intratomo-2021/meta", `{"favorite":true}`)
	if _, err := bundle.handle.Exec(`INSERT INTO app_state(key,value_json) VALUES('documents.status',?)`, `{"2209.14540":"reading","`+importedKey+`":"done","intratomo-2021":"queue"}`); err != nil {
		t.Fatal(err)
	}
	requestBody, _ := json.Marshal(map[string]any{"keys": []string{"2209.14540", importedKey, importedKey}})
	res, response := post(t, bundle, http.MethodPost, "/v1/trash/empty", string(requestBody))
	if res.StatusCode != 200 || response["originalFilesPreserved"] != true || response["libraryCopiesRemoved"] != float64(1) || len(response["deletedKeys"].([]any)) != 2 {
		t.Fatalf("clear failed: %d %v", res.StatusCode, response)
	}
	if _, err := os.Stat(copyPath); !os.IsNotExist(err) {
		t.Fatalf("imported library copy should be removed: %v", err)
	}
	for _, table := range []string{"document_pages", "readings", "annotations", "translations", "document_sections", "reading_locations"} {
		var count int
		if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s not cleared: %d %v", table, count, err)
		}
	}
	var remaining string
	if err := bundle.handle.QueryRow(`SELECT key FROM documents`).Scan(&remaining); err != nil || remaining != "intratomo-2021" {
		t.Fatalf("active paper lost: %s %v", remaining, err)
	}
	for _, state := range []string{"documents.meta", "documents.status"} {
		var raw string
		if err := bundle.handle.QueryRow(`SELECT value_json FROM app_state WHERE key=?`, state).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var value map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &value); err != nil || len(value) != 1 || value["intratomo-2021"] == nil {
			t.Fatalf("bad remaining %s: %s", state, raw)
		}
	}
	var count int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM app_state WHERE key LIKE 'reproduction:%'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("reproduction records remain: %d %v", count, err)
	}
	for name, expected := range files {
		actual, err := os.ReadFile(name)
		if err != nil || string(actual) != expected {
			t.Fatalf("paper or legacy source changed: %s: %v", name, err)
		}
	}
}

func TestTrashEmptyRejectsActiveOrRestoredDocuments(t *testing.T) {
	bundle := newS6Server(t)
	if res := do(t, bundle.frontend, http.MethodPost, "/v1/trash/empty", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatal(res.StatusCode)
	}
	patch(t, bundle, "/v1/documents/2209.14540/meta", `{"deleted":true}`)
	patch(t, bundle, "/v1/documents/2209.14540/meta", `{"deleted":false}`)
	for _, body := range []string{`{"keys":["2209.14540"]}`, `{"keys":["intratomo-2021"]}`, `{"keys":["unknown"]}`} {
		if res, _ := post(t, bundle, http.MethodPost, "/v1/trash/empty", body); res.StatusCode != http.StatusConflict {
			t.Fatalf("expected conflict, got %d", res.StatusCode)
		}
	}
	if res, _ := post(t, bundle, http.MethodPost, "/v1/trash/empty", `{"keys":["../outside"]}`); res.StatusCode != http.StatusBadRequest {
		t.Fatal(res.StatusCode)
	}
	var count int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("papers changed: %d %v", count, err)
	}
}

func TestTrashEmptyUsesConfirmedSnapshotAndRollsBack(t *testing.T) {
	bundle := newS6Server(t)
	for _, key := range []string{"2209.14540", "intratomo-2021"} {
		patch(t, bundle, "/v1/documents/"+key+"/meta", `{"deleted":true}`)
	}
	if _, err := bundle.handle.Exec(`CREATE TRIGGER block_delete BEFORE DELETE ON documents WHEN OLD.key = 'intratomo-2021' BEGIN SELECT RAISE(ABORT,'test failure'); END`); err != nil {
		t.Fatal(err)
	}
	if res, _ := post(t, bundle, http.MethodPost, "/v1/trash/empty", `{"keys":["2209.14540","intratomo-2021"]}`); res.StatusCode != 500 {
		t.Fatal(res.StatusCode)
	}
	var count int
	if err := bundle.handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("partial deletion: %d %v", count, err)
	}
	if _, err := bundle.handle.Exec(`DROP TRIGGER block_delete`); err != nil {
		t.Fatal(err)
	}
	if res, _ := post(t, bundle, http.MethodPost, "/v1/trash/empty", `{"keys":["2209.14540"]}`); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	var remaining string
	if err := bundle.handle.QueryRow(`SELECT key FROM documents`).Scan(&remaining); err != nil || remaining != "intratomo-2021" {
		t.Fatalf("unconfirmed paper removed: %s %v", remaining, err)
	}
}
