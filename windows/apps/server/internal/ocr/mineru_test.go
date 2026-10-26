package ocr

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMinerUFailureAndCancellation(t *testing.T) {
	for _, scenario := range []string{"unauthorized", "api-error", "upload-error", "task-error", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v4/file-urls/batch":
					if scenario == "unauthorized" {
						w.WriteHeader(http.StatusUnauthorized)
						fmt.Fprint(w, `{"msg":"expired"}`)
						return
					}
					if scenario == "api-error" {
						fmt.Fprint(w, `{"code":"A0202","msg":"invalid token"}`)
						return
					}
					fmt.Fprintf(w, `{"code":0,"data":{"batch_id":"one","file_urls":["http://%s/upload"]}}`, r.Host)
				case "/upload":
					if scenario == "upload-error" {
						w.WriteHeader(http.StatusForbidden)
					}
				case "/api/v4/extract-results/batch/one":
					if scenario == "task-error" {
						fmt.Fprint(w, `{"code":0,"data":{"extract_result":[{"file_name":"paper.pdf","state":"failed","err_msg":"invalid PDF"}]}}`)
						return
					}
					fmt.Fprint(w, `{"code":0,"data":{"extract_result":[{"file_name":"paper.pdf","state":"pending"}]}}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			client := NewMinerU(upstream.URL, "private", "vlm")
			client.PollInterval = time.Millisecond
			client.OnState = func(state string) {
				if scenario == "cancel" && state == "pending" {
					cancel()
				}
			}
			_, err := client.Layouts(ctx, []byte("%PDF"), "paper.pdf")
			if scenario == "cancel" {
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation was not propagated: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "MinerU") {
				t.Fatalf("missing provider failure: %v", err)
			}
		})
	}
}
