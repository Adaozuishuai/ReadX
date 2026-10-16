package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestPublicationMigrationPreservesVersionTwoLibrary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-v2.db")
	old, err := sql.Open(driverName, "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	_, err = old.Exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)`)
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"0001_init.sql", "0002_annotations.sql"} {
		raw, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(string(raw)); err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(`INSERT INTO schema_migrations VALUES(?,?,?)`, i+1, name, "fixture"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = old.Exec(`INSERT INTO documents(id,key,title) VALUES('old','old','Legacy paper'); INSERT INTO annotations(id,document_id,quote,note) VALUES('note','old','Original quote','User research note')`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	handle, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	var format, note, locator string
	if err = handle.QueryRow(`SELECT d.format,a.note,a.locator_json FROM documents d JOIN annotations a ON a.document_id=d.id WHERE d.id='old'`).Scan(&format, &note, &locator); err != nil {
		t.Fatal(err)
	}
	if format != "pdf" || note != "User research note" || locator != "{}" {
		t.Fatalf("migration changed legacy data: %s %s %s", format, note, locator)
	}
}
