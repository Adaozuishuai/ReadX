package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var translationSourcePattern = regexp.MustCompile(`(?m)^\[\d+\] (.+)$`)

func translationReplyForUser(t *testing.T, user string) string {
	t.Helper()
	matches := translationSourcePattern.FindAllStringSubmatch(user, -1)
	items := make([]map[string]any, len(matches))
	for index, match := range matches {
		items[index] = map[string]any{"i": index, "t": "译:" + match[1]}
	}
	encoded, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func translationTestClient(t *testing.T, handler func(http.ResponseWriter, string)) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []Message `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		user := body.Messages[len(body.Messages)-1].Content
		content := translationReplyForUser(t, user)
		handler(w, content)
	}))
	t.Cleanup(server.Close)
	return NewClient(Config{BaseURL: server.URL, APIKey: "test", Model: "test-model"})
}

func writeTranslationContent(w http.ResponseWriter, content string) {
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": content}}}})
	_, _ = w.Write(body)
}

func TestTranslateParagraphsUsesBoundedConcurrencyAndPreservesOrder(t *testing.T) {
	var active, maxActive atomic.Int32
	client := translationTestClient(t, func(w http.ResponseWriter, content string) {
		current := active.Add(1)
		for old := maxActive.Load(); current > old && !maxActive.CompareAndSwap(old, current); old = maxActive.Load() {
		}
		time.Sleep(40 * time.Millisecond)
		writeTranslationContent(w, content)
		active.Add(-1)
	})
	sources := make([]string, 48)
	for i := range sources {
		sources[i] = fmt.Sprintf("paragraph-%02d", i)
	}
	targets, err := TranslateParagraphs(context.Background(), client, sources)
	if err != nil {
		t.Fatal(err)
	}
	if maxActive.Load() < 2 || maxActive.Load() > translateConcurrency {
		t.Fatalf("期望有限并发（2–%d），实际 %d", translateConcurrency, maxActive.Load())
	}
	for index, source := range sources {
		if targets[index] != "译:"+source {
			t.Fatalf("第 %d 段错位：%q", index, targets[index])
		}
	}
}

func TestTranslateParagraphsBestEffortIsolatesMalformedParagraph(t *testing.T) {
	client := translationTestClient(t, func(w http.ResponseWriter, content string) {
		if strings.Contains(content, "bad-paragraph") {
			writeTranslationContent(w, `not valid json`)
			return
		}
		writeTranslationContent(w, content)
	})
	sources := []string{"good-a", "bad-paragraph", "good-b"}
	targets, failed, err := TranslateParagraphsBestEffort(context.Background(), client, sources)
	if err != nil {
		t.Fatal(err)
	}
	if len(failed) != 1 || failed[0] != 1 {
		t.Fatalf("未定位坏段：%v", failed)
	}
	if targets[0] != "译:good-a" || targets[1] != "" || targets[2] != "译:good-b" {
		t.Fatalf("部分译文顺序或回退错误：%v", targets)
	}
}
