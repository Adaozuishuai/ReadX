package httpapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// Exercise the sync HTTP API against real migrations on two independent
// databases: existing document IDs must survive an upsert by the partial key
// index, while new books, JSON locators, positions, text and files round-trip.
func TestSyncLibraryRoundTripWithExistingDocument(t *testing.T) {
	newDevice := func() *httptestServerBundle {
		frontend, handle, cfg := newTestServer(t, nil)
		return &httptestServerBundle{frontend: frontend, handle: handle, cfg: cfg, token: cfg.Token}
	}
	first, second := newDevice(), newDevice()
	shared := t.TempDir()
	exec := func(handle *sql.DB, query string, args ...any) {
		t.Helper()
		if _, err := handle.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	readString := func(handle *sql.DB, query string, args ...any) string {
		t.Helper()
		var value string
		if err := handle.QueryRow(query, args...).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	syncDevice := func(device *httptestServerBundle) {
		t.Helper()
		response, payload := post(t, device, http.MethodPost, "/v1/sync", `{}`)
		if response.StatusCode != http.StatusOK || payload["synced"] != true {
			t.Fatalf("sync returned %d: %v", response.StatusCode, payload)
		}
	}
	for _, device := range []*httptestServerBundle{first, second} {
		body, err := json.Marshal(map[string]string{"provider": "folder", "folderPath": shared})
		if err != nil {
			t.Fatal(err)
		}
		response, payload := post(t, device, http.MethodPut, "/v1/sync/settings", string(body))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("save sync settings returned %d: %v", response.StatusCode, payload)
		}
	}

	pdf := []byte("%PDF-1.7\nsync regression fixture\n%%EOF\n")
	pdfPath := filepath.Join(first.cfg.DataRoot, "original.pdf")
	if err := os.WriteFile(pdfPath, pdf, 0o600); err != nil {
		t.Fatal(err)
	}
	exec(first.handle, `INSERT INTO documents(id,key,title,status,format,pdf_path) VALUES('first-local-id','sync-paper','Original title','reading','pdf',?)`, pdfPath)
	exec(first.handle, `INSERT INTO documents(id,key,title,format) VALUES('first-epub-id','sync-book','An EPUB','epub')`)
	exec(first.handle, `INSERT INTO document_pages(document_id,page,text) VALUES('first-local-id',1,'Page text')`)
	exec(first.handle, `INSERT INTO document_sections(document_id,ordinal,href,title,blocks_json,text) VALUES('first-epub-id',1,'chapter.xhtml','Chapter','[]','Chapter text')`)
	locator := `{"kind":"pdf","page":1,"rects":[{"x":0.1,"y":0.2,"width":0.3,"height":0.04}]}`
	position := `{"kind":"pdf","page":3}`
	exec(first.handle, `INSERT INTO annotations(id,document_id,page,kind,note,locator_json) VALUES('sync-note','first-local-id',1,'highlight','Original note',?)`, locator)
	exec(first.handle, `INSERT INTO reading_locations(document_id,location_json,updated_at) VALUES('first-local-id',?,'2026-10-27T10:00:00Z')`, position)
	// The receiving device already has this key with a different local ID.
	exec(second.handle, `INSERT INTO documents(id,key,title,status) VALUES('second-local-id','sync-paper','Original title','reading')`)
	// Empty keys are deliberately outside the unique index and outside sync.
	exec(second.handle, `INSERT INTO documents(id,key,title) VALUES('unkeyed-a','','Local A'),('unkeyed-b','','Local B')`)

	syncDevice(first)
	syncDevice(second)
	if got := readString(second.handle, `SELECT id FROM documents WHERE key='sync-paper'`); got != "second-local-id" {
		t.Fatalf("existing document ID changed: %q", got)
	}
	for query, want := range map[string]string{
		`SELECT title FROM documents WHERE key='sync-paper'`:                              "Original title",
		`SELECT note FROM annotations WHERE id='sync-note'`:                               "Original note",
		`SELECT locator_json FROM annotations WHERE id='sync-note'`:                       locator,
		`SELECT location_json FROM reading_locations WHERE document_id='second-local-id'`: position,
		`SELECT text FROM document_pages WHERE document_id='second-local-id' AND page=1`:  "Page text",
		`SELECT text FROM document_sections WHERE document_id='sync-book' AND ordinal=1`:  "Chapter text",
	} {
		if got := readString(second.handle, query); got != want {
			t.Fatalf("%s: got %q, want %q", query, got, want)
		}
	}
	receivedPath := readString(second.handle, `SELECT pdf_path FROM documents WHERE key='sync-paper'`)
	receivedPDF, err := os.ReadFile(receivedPath)
	if err != nil || string(receivedPDF) != string(pdf) {
		t.Fatalf("synchronized PDF differs: %v", err)
	}

	// Send edits back, then repeat sync to check that upserts remain idempotent.
	exec(second.handle, `UPDATE documents SET title='Edited title' WHERE key='sync-paper'`)
	exec(second.handle, `UPDATE annotations SET note='Edited note' WHERE id='sync-note'`)
	exec(second.handle, `UPDATE reading_locations SET location_json='{"kind":"pdf","page":5}',updated_at='2026-10-27T11:00:00Z' WHERE document_id='second-local-id'`)
	syncDevice(second)
	syncDevice(first)
	syncDevice(first)
	if got := readString(first.handle, `SELECT title FROM documents WHERE key='sync-paper'`); got != "Edited title" {
		t.Fatalf("document edit did not return: %q", got)
	}
	if got := readString(first.handle, `SELECT note FROM annotations WHERE id='sync-note'`); got != "Edited note" {
		t.Fatalf("note edit did not return: %q", got)
	}
	if got := readString(first.handle, `SELECT location_json FROM reading_locations WHERE document_id='first-local-id'`); got != `{"kind":"pdf","page":5}` {
		t.Fatalf("reading position edit did not return: %q", got)
	}
	var count int
	if err := second.handle.QueryRow(`SELECT count(*) FROM documents WHERE key<>''`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("repeated sync duplicated documents: count=%d, err=%v", count, err)
	}
}
