package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

func progressUploadRequest(t *testing.T, bundle *httptestServerBundle, count int) *http.Request {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("files", "paper.pdf")
	if err != nil {
		t.Fatal(err)
	}
	file.Write([]byte("%PDF-1.4\nprogress fixture"))
	segments := []string{}
	for i := 0; i < count; i++ {
		segments = append(segments, fmt.Sprintf("Original source paragraph number %d.", i))
	}
	hints, _ := json.Marshal([]publicationMetadataHint{{FirstPage: "Real paper title and authors", Pages: []publicationPageHint{{Page: 1, Text: strings.Join(segments, "\n"), Segments: segments}}}})
	form.WriteField("metadata", string(hints))
	form.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "POST", bundle.frontend.URL+"/v1/import/files", &body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+bundle.token)
	req.Header.Set("Accept", "text/event-stream")
	return req
}

func TestImportProgressStreamsDuringModelWaitAndCountsValidatedBatches(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			<-release
			return `{"title":"Real paper title","translatedTitle":"真实题名"}`, 200
		}
		items := []map[string]any{}
		for i := range sources {
			items = append(items, map[string]any{"i": i, "t": fmt.Sprintf("译文%d", i)})
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), 200
	})
	t.Cleanup(unblock)
	writeAIConfig(t, bundle, upstream.URL)
	res, err := front.Client().Do(progressUploadRequest(t, bundle, 35))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatal(res.StatusCode, res.Header)
	}
	scanner := bufio.NewScanner(res.Body)
	sawMetadata, heartbeat, saved := false, false, false
	completed := []int{}
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var event struct {
			Progress  *importProgress `json:"progress"`
			Heartbeat bool            `json:"heartbeat"`
			Results   []importResult  `json:"results"`
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event); err != nil {
			t.Fatal(err)
		}
		if event.Progress != nil {
			p := event.Progress
			if p.File != 1 || p.Files != 1 || p.Name != "paper.pdf" {
				t.Fatalf("missing file context: %+v", p)
			}
			if p.Stage == "metadata" {
				sawMetadata = true
			}
			if p.Stage == "translation" {
				if p.Total != 35 {
					t.Fatalf("wrong total: %+v", p)
				}
				completed = append(completed, p.Completed)
			}
			if p.Stage == "saving" {
				saved = true
			}
		}
		if event.Heartbeat {
			if event.Progress != nil || !sawMetadata {
				t.Fatal("heartbeat advanced work or arrived before model stage")
			}
			heartbeat = true
			var count int
			if err := handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("paper saved before translation: %d %v", count, err)
			}
			unblock()
		}
		if event.Results != nil && (len(event.Results) != 1 || event.Results[0].Error != "" || event.Results[0].Document == nil) {
			t.Fatalf("invalid terminal result: %+v", event.Results)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !heartbeat || !saved || len(completed) < 4 || completed[0] != 0 || completed[len(completed)-1] != 35 {
		t.Fatalf("missing real-time progress: heartbeat=%v saving=%v counters=%v", heartbeat, saved, completed)
	}
	sawPartial := false
	for i, value := range completed {
		if value == 24 {
			sawPartial = true
		}
		if i > 0 && value < completed[i-1] {
			t.Fatal("translation progress moved backwards")
		}
	}
	if !sawPartial {
		t.Fatal("missing intermediate batch completion")
	}
}

func TestImportProgressFailureDoesNotReportCompletedTranslations(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		if len(sources) == 0 {
			return `{"title":"Real paper title"}`, 200
		}
		return `{"items":[]}`, 200
	})
	writeAIConfig(t, bundle, upstream.URL)
	res, err := front.Client().Do(progressUploadRequest(t, bundle, 2))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	scanner := bufio.NewScanner(res.Body)
	failed := false
	for scanner.Scan() {
		if !strings.HasPrefix(scanner.Text(), "data:") {
			continue
		}
		var event struct {
			Progress *importProgress `json:"progress"`
			Results  []importResult  `json:"results"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data:")), &event); err != nil {
			t.Fatal(err)
		}
		if p := event.Progress; p != nil {
			if p.Stage == "translation" && p.Completed != 0 {
				t.Fatal("invalid translation was counted as completed")
			}
			if p.Stage == "saving" || p.Stage == "done" {
				t.Fatal("failed translation was saved")
			}
		}
		if len(event.Results) == 1 && event.Results[0].Error != "" {
			failed = true
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count != 0 || !failed {
		t.Fatalf("failure not surfaced atomically: %d %v", count, err)
	}
}
