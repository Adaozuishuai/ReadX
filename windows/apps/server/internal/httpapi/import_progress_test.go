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
	file.Write(testPDF(t))
	segments := []string{}
	pages := []publicationPageHint{}
	for i := 0; i < count; i++ {
		segment := fmt.Sprintf("Original source paragraph number %d.", i)
		segments = append(segments, segment)
		pages = append(pages, publicationPageHint{Page: i + 1, Text: segment, Segments: []string{segment}, Width: 595, Height: 842})
	}
	hints, _ := json.Marshal([]publicationMetadataHint{{FirstPage: "Real paper title and authors", Pages: pages}})
	form.WriteField("metadata", string(hints))
	form.Close()
	ensureTestOCRPages(t, bundle, count)
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

func TestImportProgressStreamsDuringLeeProcessing(t *testing.T) {
	front, handle, cfg := newTestServer(t, nil)
	bundle := &httptestServerBundle{front, cfg.Token, cfg, handle}
	release := make(chan struct{})
	var once sync.Once
	var modelWait sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	upstream := fakeUpstream(t, func(sources []string) (string, int) {
		modelWait.Do(func() { <-release })
		items := []map[string]any{}
		for i := range sources {
			items = append(items, map[string]any{"i": i, "t": fmt.Sprintf("译文%d", i)})
		}
		body, _ := json.Marshal(map[string]any{"items": items})
		return string(body), 200
	})
	t.Cleanup(unblock)
	writeAIConfig(t, bundle, upstream.URL)
	res, err := front.Client().Do(progressUploadRequest(t, bundle, 1))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(res.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatal(res.StatusCode, res.Header)
	}
	scanner := bufio.NewScanner(res.Body)
	heartbeat, saved, completed := false, false, false
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
			if p.Stage == "saving" {
				saved = true
			}
		}
		if event.Heartbeat {
			if event.Progress != nil {
				t.Fatal("heartbeat advanced import progress")
			}
			heartbeat = true
			var count int
			if err := handle.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("paper saved before translation: %d %v", count, err)
			}
			unblock()
		}
		if event.Results != nil {
			if len(event.Results) != 1 || event.Results[0].Error != "" || event.Results[0].Document == nil {
				t.Fatalf("invalid terminal result: %+v", event.Results)
			}
			completed = true
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !heartbeat || !saved || !completed {
		t.Fatalf("missing Lee import progress: heartbeat=%v saving=%v result=%v", heartbeat, saved, completed)
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
