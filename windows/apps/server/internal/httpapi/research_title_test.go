package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type researchTitleTransport func(*http.Request) (*http.Response, error)

func (f researchTitleTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestResearchTitleTranslationEscapesTitleAndJoinsSegments(t *testing.T) {
	title := "Intuition & Evidence: C++ / 多模态?"
	client := &http.Client{Transport: researchTitleTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "translate.googleapis.com" || r.URL.Scheme != "https" || r.URL.Query().Get("q") != title || r.URL.Query().Get("tl") != "zh-CN" {
			t.Fatalf("incorrect translation request: %s", r.URL)
		}
		if r.Header.Get("User-Agent") != sourceBrowserUA || r.Header.Get("Accept") != "application/json" {
			t.Fatal("translation request is missing browser-compatible headers")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`[[["直觉与证据：","Intuition & Evidence:",null],["多模态智能体","Multimodal Agents",null]],null,"en"]`))}, nil
	})}
	translation, err := translateResearchTitle(context.Background(), title, client)
	if err != nil || translation != "直觉与证据：多模态智能体" {
		t.Fatalf("translation=%q err=%v", translation, err)
	}
}

func TestResearchTitleClientUsesConfiguredProxy(t *testing.T) {
	connect := make(chan string, 1)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connect <- r.Method + " " + r.Host
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer proxy.Close()
	proxyURL, _ := url.Parse(proxy.URL)
	client := newResearchTitleClient(func(*http.Request) (*url.URL, error) { return proxyURL, nil })
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := translateResearchTitle(ctx, "Example paper", client)
	if err == nil {
		t.Fatal("expected proxy's 502 response to fail")
	}
	select {
	case request := <-connect:
		if request != "CONNECT translate.googleapis.com:443" {
			t.Fatalf("unexpected proxy destination: %s", request)
		}
	default:
		t.Fatal("translation bypassed the configured proxy")
	}
}

func TestResearchTitleTranslationRejectsInvalidResults(t *testing.T) {
	for _, body := range []string{`[]`, `[null]`, `[[[""]]]`, `[[[42]]]`, `<html>blocked</html>`, strings.Repeat("x", (128<<10)+1)} {
		client := &http.Client{Transport: researchTitleTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
		})}
		if result, err := translateResearchTitle(context.Background(), "Example", client); err == nil || result != "" {
			t.Fatal("invalid upstream response accepted")
		}
	}
}

func TestResearchTitleTranslationPreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := &http.Client{Transport: researchTitleTransport(func(r *http.Request) (*http.Response, error) { return nil, r.Context().Err() })}
	_, err := translateResearchTitle(ctx, "Example", client)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestResearchTitleClientRejectsOtherRedirectDestinations(t *testing.T) {
	client := newResearchTitleClient(nil)
	defer client.CloseIdleConnections()
	for _, target := range []string{"http://translate.googleapis.com/", "https://example.com/", "https://translate.googleapis.com:444/", "https://user@translate.googleapis.com/"} {
		request, _ := http.NewRequest(http.MethodGet, target, nil)
		if client.CheckRedirect(request, nil) == nil {
			t.Fatalf("unexpected redirect allowed: %s", target)
		}
	}
}
