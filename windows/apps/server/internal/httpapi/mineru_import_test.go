package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"cbctv2/server/internal/ocr"
)

func TestMinerUImportAndReaderUseNativeLayout(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	pdf := testPDF(t)
	var archive bytes.Buffer
	zw := zip.NewWriter(&archive)
	file, err := zw.Create("results/paper_middle.json")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(file, `{"pdf_info":[{"page_idx":0,"page_size":[600,800],"para_blocks":[{"type":"text","bbox":[40,100,560,180],"lines":[{"bbox":[40,100,560,120],"spans":[{"type":"text","content":"MinerU recognized paragraph.","bbox":[40,100,560,120]}]}]},{"type":"interline_equation","bbox":[40,220,560,260],"lines":[{"bbox":[40,220,560,260],"spans":[{"type":"interline_equation","content":"E=mc^2","bbox":[40,220,560,260]}]}]}]}]}`)
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	var submissions atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v4/file-urls/batch":
			submissions.Add(1)
			if r.Header.Get("Authorization") != "Bearer mineru-private" {
				t.Error("wrong MinerU authorization")
			}
			var payload struct {
				Model string `json:"model_version"`
				Files []struct {
					Name string `json:"name"`
				} `json:"files"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Model != "vlm" || len(payload.Files) != 1 {
				t.Errorf("invalid MinerU request: %+v %v", payload, err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"batch_id": "batch", "file_urls": []string{"http://" + r.Host + "/upload"}}})
		case "/upload":
			if r.Method != http.MethodPut || r.Header.Get("Authorization") != "" {
				t.Error("signed upload must be PUT without API authorization")
			}
			data, _ := io.ReadAll(r.Body)
			if !bytes.Equal(data, pdf) {
				t.Error("uploaded PDF changed")
			}
		case "/api/v4/extract-results/batch/batch":
			if r.Header.Get("Authorization") != "Bearer mineru-private" {
				t.Error("poll lacks API authorization")
			}
			fmt.Fprintf(w, `{"code":0,"data":{"extract_result":[{"file_name":"paper.pdf","state":"done","full_zip_url":"http://%s/result.zip"}]}}`, r.Host)
		case "/result.zip":
			if r.Header.Get("Authorization") != "" {
				t.Error("API token leaked to result URL")
			}
			_, _ = w.Write(archive.Bytes())
		default:
			t.Errorf("unexpected endpoint: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	writeAIConfigFile(t, cfg.DataRoot, `{"provider":"openai","baseURL":"http://127.0.0.1:1/v1","model":"unused","apiKey":"unused"}`)
	if err := s.saveOCRConfig(ocrConfig{Provider: "mineru", BaseURL: upstream.URL, Model: "vlm", Token: "mineru-private"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	s.beginImportJob("mineru-test", "paper.pdf", 1, cancel)
	metadata := recognizedPaperMetadata{}
	if _, err := s.runLeePDFImport(ctx, "mineru-test", "paper.pdf", pdf, &metadata, leeImportOptions{SkipMetadataCompletion: true}); err != nil {
		t.Fatal(err)
	}
	if len(metadata.OCRPages) != 1 || len(metadata.OCRPages[0].Blocks) != 2 || metadata.OCRPages[0].Blocks[0].Text != "MinerU recognized paragraph." {
		t.Fatalf("native MinerU output was not projected: %+v", metadata.OCRPages)
	}
	root := filepath.Join(cfg.DataRoot, "app", "data", "retain", "jobs", "mineru-test")
	spec, err := os.ReadFile(filepath.Join(root, "provider.stage.json"))
	if err != nil || !bytes.Contains(spec, []byte(`"provider":"mineru"`)) || bytes.Contains(spec, []byte("mineru-private")) {
		t.Fatalf("incorrect or secret-bearing OCR spec: %s, %v", spec, err)
	}
	// An existing Paddle result for the same PDF must never mask the MinerU request.
	sum := sha256.Sum256(pdf)
	if err := os.MkdirAll(s.translationCacheDir(), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.translationCacheDir(), "ocr-"+hex.EncodeToString(sum[:16])+".json"), []byte(`[{"paddle":"cached"}]`), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := s.ocrClient()
	if err != nil {
		t.Fatal(err)
	}
	client.PollInterval = time.Millisecond
	for i := 0; i < 2; i++ {
		raw, err := s.cachedOCRLayouts(ctx, "paper", pdf, client)
		if err != nil {
			t.Fatal(err)
		}
		pages, err := client.MapLayouts(ctx, raw, []ocr.Size{{Width: 300, Height: 400}})
		if err != nil || len(pages) != 1 {
			t.Fatalf("reader cannot use MinerU cache: %+v %v", pages, err)
		}
		if pages[0].Blocks[0].Box[0] != 20 || pages[0].Width != 300 || !pages[0].Blocks[0].Translatable || pages[0].Blocks[1].Translatable {
			t.Fatalf("wrong MinerU coordinates or formula policy: %+v", pages[0])
		}
	}
	if submissions.Load() != 2 {
		t.Fatalf("expected one native and one cached reader request, got %d", submissions.Load())
	}
	if strings.Contains(string(spec), "paddle_api_url") {
		t.Fatal("MinerU stage still contains Paddle options")
	}
}
