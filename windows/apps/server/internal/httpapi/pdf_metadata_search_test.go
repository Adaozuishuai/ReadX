package httpapi

import (
	"context"
	"errors"
	"strings"
	"testing"

	"cbctv2/server/internal/ai"
)

func TestSearchCompletesPublicationFieldsFromSelectedRecord(t *testing.T) {
	upstream := fakeUpstream(t, func([]string) (string, int) { return `{"candidate":1}`, 200 })
	client := ai.NewClient(ai.Config{BaseURL: upstream.URL, Model: "test", APIKey: "test"})
	metadata := recognizedPaperMetadata{Title: "Sparse View Reconstruction", Authors: []string{"Original Author"}, DOI: "10.1000/paper"}
	lookedUp := ""
	lookup := func(_ context.Context, query string) ([]paperCandidate, error) {
		lookedUp = query
		return []paperCandidate{
			{Title: "Unrelated result", Venue: "Wrong venue", Year: 1999},
			{Title: metadata.Title, DOI: "https://doi.org/10.1000/paper", Authors: []string{"Other spelling"}, Venue: "IEEE Transactions on Medical Imaging", Year: 2024},
		}, nil
	}
	if err := completePaperMetadataFromSearch(context.Background(), client, &metadata, "paper first page", lookup); err != nil {
		t.Fatal(err)
	}
	if lookedUp != "10.1000/paper" || metadata.Year != 2024 || metadata.Venue != "IEEE Transactions on Medical Imaging" {
		t.Fatalf("search fields were not applied: query=%q metadata=%+v", lookedUp, metadata)
	}
	if metadata.DOI != "10.1000/paper" || metadata.Authors[0] != "Original Author" {
		t.Fatalf("known metadata was overwritten: %+v", metadata)
	}
}

func TestMetadataSearchRejectsUnverifiedOrWrongRecords(t *testing.T) {
	for _, test := range []struct{ name, response string }{
		{"no match", `{"candidate":-1}`},
		{"missing decision", `{}`},
		{"out of range", `{"candidate":20}`},
		{"different DOI", `{"candidate":0}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := fakeUpstream(t, func([]string) (string, int) { return test.response, 200 })
			client := ai.NewClient(ai.Config{BaseURL: upstream.URL, Model: "test", APIKey: "test"})
			metadata := recognizedPaperMetadata{Title: "Original Research Title", DOI: "10.1000/original"}
			lookup := func(context.Context, string) ([]paperCandidate, error) {
				return []paperCandidate{{Title: metadata.Title, DOI: "10.1000/other", Venue: "Incorrect Journal", Year: 2020}}, nil
			}
			if err := completePaperMetadataFromSearch(context.Background(), client, &metadata, "", lookup); err == nil {
				t.Fatal("unverified metadata should not be accepted")
			}
			if metadata.Venue != "" || metadata.Year != 0 {
				t.Fatalf("unverified fields were written: %+v", metadata)
			}
		})
	}
}

func TestMetadataSearchFallsBackToTitleAndPreservesKnownFields(t *testing.T) {
	upstream := fakeUpstream(t, func([]string) (string, int) { return `{"candidate":0}`, 200 })
	client := ai.NewClient(ai.Config{BaseURL: upstream.URL, Model: "test", APIKey: "test"})
	metadata := recognizedPaperMetadata{Title: "Original Research Title", DOI: "10.1000/original", Venue: "Known Conference", Year: 2023}
	queries := []string{}
	lookup := func(_ context.Context, query string) ([]paperCandidate, error) {
		queries = append(queries, query)
		if len(queries) == 1 {
			return nil, errors.New("DOI lookup unavailable")
		}
		return []paperCandidate{{Title: metadata.Title, DOI: metadata.DOI, Venue: "Alternative name", Year: 2024}}, nil
	}
	if err := completePaperMetadataFromSearch(context.Background(), client, &metadata, "", lookup); err != nil {
		t.Fatal(err)
	}
	if strings.Join(queries, "|") != "10.1000/original|Original Research Title" || metadata.Venue != "Known Conference" || metadata.Year != 2023 {
		t.Fatalf("fallback or preservation failed: queries=%v metadata=%+v", queries, metadata)
	}
}

func TestSaveEnrichedMetadataFillsZeroYearWithoutErasingKnownFields(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	_, err := handle.Exec(`INSERT INTO documents(id,key,title,authors,year,venue,doi) VALUES('enrich','enrich','Original Title','["Original Author"]',0,'','10.1000/original')`)
	if err != nil {
		t.Fatal(err)
	}
	server := New(cfg, handle)
	metadata := recognizedPaperMetadata{Title: "Replacement Title", Authors: []string{"Replacement Author"}, Venue: "Matched Journal", Year: 2024, DOI: "10.1000/replacement"}
	if err := server.saveRecognizedPDFMetadata(context.Background(), "enrich", "file title", metadata); err != nil {
		t.Fatal(err)
	}
	doc, err := server.loadDocument(context.Background(), "enrich")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Venue != "Matched Journal" || doc.Year == nil || *doc.Year != 2024 || doc.Title != "Original Title" || doc.Authors[0] != "Original Author" || doc.DOI != "10.1000/original" {
		t.Fatalf("incorrect persisted metadata: %+v", doc)
	}
}
