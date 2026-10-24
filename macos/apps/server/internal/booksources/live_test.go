package booksources

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

// Opt in to external requests; the normal test suite uses deterministic fixtures.
func TestLiveBookSources(t *testing.T) {
	if os.Getenv("READX_BOOK_SOURCE_LIVE") != "1" {
		t.Skip("set READX_BOOK_SOURCE_LIVE=1 for official catalog E2E")
	}
	for _, p := range DefaultProviders(http.ProxyFromEnvironment)[:2] {
		t.Run(p.Info().ProviderID, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			result, err := p.Search(ctx, "alice", "")
			if err != nil || len(result.Books) == 0 {
				t.Fatalf("search: %v", err)
			}
			book, err := p.Detail(ctx, "11")
			if err != nil || !book.Rights.AllowsDownload() {
				t.Fatalf("detail: %+v %v", book, err)
			}
			formats := []string{"epub"}
			if p.Info().ProviderID == "gutenberg" {
				formats = append(formats, "txt")
			}
			for _, format := range formats {
				artifact, err := p.Download(ctx, "11", format, nil)
				if err != nil {
					t.Fatalf("%s: %v", format, err)
				}
				if len(artifact.Data) == 0 || len(artifact.SHA256) != 64 {
					t.Fatal("empty or unchecked download")
				}
				t.Logf("%s: %d bytes, sha256 %s", format, len(artifact.Data), artifact.SHA256)
			}
		})
	}
}

func TestLiveZLibraryProbe(t *testing.T) {
	if os.Getenv("READX_BOOK_SOURCE_LIVE") != "1" {
		t.Skip("set READX_BOOK_SOURCE_LIVE=1 for the anonymous EAPI probe")
	}
	z := NewZLibrary("", http.ProxyFromEnvironment)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	status, err := z.Probe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Connected {
		t.Fatal("anonymous probe must not fabricate a login")
	}
	t.Log("anonymous EAPI JSON verified; authenticated search/download require the user's account")
}
