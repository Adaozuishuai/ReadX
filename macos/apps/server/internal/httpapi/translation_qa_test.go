package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"cbctv2/server/internal/translate"
)

func TestTranslationQAStoredWithImportAndServedByDocument(t *testing.T) {
	frontend, handle, cfg := newTestServer(t, nil)
	const key = "doc-numeric-qa"
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES(?,?,?)`, key, key, "QA paper"); err != nil {
		t.Fatal(err)
	}
	report := translate.BuildNumericQA([]translate.Item{{ItemID: "p1-b1", PageIndex: 0, Source: "The method uses 4 views."}}, []string{"该方法使用3个视角。"})
	metadata := recognizedPaperMetadata{TranslationQA: &report}
	tx, err := handle.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := saveImportText(context.Background(), tx, key, nowStamp(), metadata); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	response := do(t, frontend, http.MethodGet, "/v1/documents/"+key+"/translation-qa", cfg.Token)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("translation QA endpoint returned %d", response.StatusCode)
	}
	var got translate.NumericQAReport
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Schema != report.Schema || got.ViolationCount != report.ViolationCount || got.ItemCount != 1 {
		t.Fatalf("translation QA report did not round-trip: %+v", got)
	}
}
