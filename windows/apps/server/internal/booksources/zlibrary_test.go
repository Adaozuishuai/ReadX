package booksources

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func fixtureZLibrary(t *testing.T) (*ZLibrary, *int) {
	t.Helper()
	z := NewZLibrary("", nil)
	files := 0
	z.transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		body := `{"success":1}`
		mime := "application/json"
		if r.URL.Path != "/eapi/info" && r.URL.Path != "/eapi/user/login" && r.URL.Path != "/dl/novel.txt" {
			if r.Header.Get("remix-userid") != "123" || r.Header.Get("remix-userkey") != "own-session-key" {
				t.Error("missing account-scoped authentication")
			}
		}
		switch r.URL.Path {
		case "/eapi/user/login":
			if e := r.ParseForm(); e != nil || r.Form.Get("email") != "user@example.org" || r.Form.Get("password") != "own-password" {
				t.Error("login fields")
			}
			body = `{"success":1,"user":{"id":123,"remix_userkey":"own-session-key"}}`
		case "/eapi/user/profile":
			body = `{"success":1,"user":{"name":"Reader","downloads_today":2,"downloads_limit":10}}`
		case "/eapi/book/search":
			if e := r.ParseForm(); e != nil || r.Form.Get("message") != "novel" || len(r.Form["extensions[]"]) != 2 {
				t.Error("search form")
			}
			body = `{"success":1,"books":[{"id":11,"hash":"abcd12","title":"A public-domain fixture","author":"Author","extension":"txt","description":"<p>Novel</p>"}],"pagination":{"current":1,"total_pages":2,"next":true}}`
		case "/eapi/book/11/abcd12":
			body = `{"success":1,"book":{"id":11,"hash":"abcd12","title":"A public-domain fixture","author":"Author","extension":"txt"}}`
		case "/eapi/book/11/abcd12/file":
			body = `{"success":1,"file":{"allowDownload":true,"extension":"txt","downloadLink":"https://z-lib.gd/dl/novel.txt"}}`
		case "/dl/novel.txt":
			files++
			body = "A public-domain novel fixture."
			mime = "text/plain; charset=utf-8"
		case "/eapi/info":
			body = `{"success":1,"books":123456,"articles":5000}`
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {mime}}, Body: io.NopCloser(strings.NewReader(body)), Request: r, ContentLength: int64(len(body))}, nil
	})
	return z, &files
}
func TestZLibraryProtocolLoginSearchAndAuthorizedDownload(t *testing.T) {
	ctx := context.Background()
	z, files := fixtureZLibrary(t)
	if _, err := z.Probe(ctx); err != nil {
		t.Fatal("info book count must not be decoded as search results", err)
	}
	if !z.Info().Enabled || !z.Info().Capabilities.RequiresAuth {
		t.Fatal(z.Info())
	}
	if _, err := z.Search(ctx, "novel", ""); PublicError(err).Code != "AUTH_REQUIRED" {
		t.Fatal(err)
	}
	status, err := z.Connect(ctx, ZLibraryLogin{Email: "user@example.org", Password: "own-password"})
	if err != nil {
		t.Fatal(err)
	}
	defer z.Disconnect()
	if !status.Connected || status.AccountName != "Reader" || status.DailyLimit == nil || *status.DailyLimit != 10 {
		t.Fatal(status)
	}
	data, _ := json.Marshal(status)
	for _, secret := range []string{"own-password", "own-session-key", "user@example.org"} {
		if strings.Contains(string(data), secret) {
			t.Fatal("credential leaked through status")
		}
	}
	result, err := z.Search(ctx, "novel", "")
	if err != nil || len(result.Books) != 1 || result.NextCursor != "2" {
		t.Fatal(result, err)
	}
	book := result.Books[0]
	if book.ID != "11:abcd12" || book.Rights.AllowsDownload() || !book.RequiresRightsConfirmation {
		t.Fatal(book)
	}
	if _, err := z.Download(ctx, book.ID, "txt", nil); PublicError(err).Code != "NO_PERMISSION" {
		t.Fatal("provider bypass", err)
	}
	r := New(t.TempDir(), z)
	if _, err := r.Start(ctx, "zlibrary", book.ID, "txt"); PublicError(err).Code != "NO_PERMISSION" {
		t.Fatal("registry bypass", err)
	}
	task, err := r.StartAuthorized(ctx, "zlibrary", book.ID, "txt", true)
	if err != nil {
		t.Fatal(err)
	}
	done := waitState(t, r, task.ID, "ready")
	if len(done.SHA256) != 64 || done.ContentType != "text/plain;charset=utf-8" {
		t.Fatal(done)
	}
	_, f, err := r.File(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(f)
	f.Close()
	if string(body) != "A public-domain novel fixture." || *files != 1 {
		t.Fatal("file import contract")
	}
	z.Disconnect()
	if z.Status().Connected {
		t.Fatal("logout")
	}
	if _, err := z.Detail(ctx, book.ID); PublicError(err).Code != "AUTH_REQUIRED" {
		t.Fatal(err)
	}
}
func TestZLibraryOwnSessionAndSettingsNeverPersistSecrets(t *testing.T) {
	z, _ := fixtureZLibrary(t)
	status, err := z.Connect(context.Background(), ZLibraryLogin{UserID: "123", UserKey: "own-session-key"})
	if err != nil || !status.Connected {
		t.Fatal(err)
	}
	z.configFile = filepath.Join(t.TempDir(), "zlibrary.json")
	// A literal public address keeps this settings test independent of DNS.
	_, err = z.Configure(context.Background(), ZLibraryConfig{Origin: "https://8.8.8.8", DownloadOrigins: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(z.configFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "key") || strings.Contains(string(data), "123") || z.Status().Connected {
		t.Fatal("settings leaked session or failed to clear it")
	}
	reloaded := NewZLibrary(z.configFile, nil)
	if reloaded.Status().Connected || reloaded.Status().Origin != "https://8.8.8.8" {
		t.Fatal("session must not survive restart")
	}
}
func TestZLibraryOriginsAndRedirectCredentials(t *testing.T) {
	for _, raw := range []string{"http://z-lib.gd", "https://user:password@z-lib.gd", "https://z-lib.gd:8443", "https://127.0.0.1", "https://[::1]", "https://z-lib.gd/eapi/", "https://z-lib.gd?q=x"} {
		if _, err := zOrigin(raw); err == nil {
			t.Fatal(raw)
		}
	}
	cfg := ZLibraryConfig{Origin: defaultZLibraryOrigin, DownloadOrigins: []string{"https://files.example.org"}}
	for _, raw := range []string{"https://evil.example.org/file", "http://z-lib.gd/dl/book", "https://z-lib.gd:443/dl/book"} {
		if _, err := zURL(raw, cfg, false); err == nil {
			t.Fatal(raw)
		}
	}
	if _, err := zURL("https://z-lib.gd/eapi/user/update", cfg, true); err == nil {
		t.Fatal("unrelated account mutation exposed")
	}
	z := NewZLibrary("", nil)
	u, _ := url.Parse("https://files.example.org/book.txt")
	req := &http.Request{URL: u, Header: http.Header{}}
	req.Header.Set("remix-userid", "123")
	req.Header.Set("remix-userkey", "own-session-key")
	req.Header.Set("Cookie", "remix_userkey=own-session-key")
	first, _ := http.NewRequest("GET", "https://z-lib.gd/dl/book", nil)
	if err := z.client(cfg, false).CheckRedirect(req, []*http.Request{first}); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("remix-userkey") != "" || req.Header.Get("Cookie") != "" {
		t.Fatal("cross-origin credentials leaked")
	}
	if err := z.client(cfg, true).CheckRedirect(req, []*http.Request{first}); err == nil {
		t.Fatal("API credentials could redirect")
	}
}
func TestZLibraryFailureMessagesDoNotEchoCredentials(t *testing.T) {
	z := NewZLibrary("", nil)
	z.transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 400, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":0,"error":"Authorization failed; secret own-password own-session-key"}`))}, nil
	})
	_, err := z.Connect(context.Background(), ZLibraryLogin{Email: "user@example.org", Password: "own-password"})
	if err == nil || strings.Contains(err.Error(), "own-") {
		t.Fatal("unsafe error")
	}
	if z.Status().Connected {
		t.Fatal("failed login installed a session")
	}
}
func TestZLibraryMissingFilePermissionFailsClosed(t *testing.T) {
	z, _ := fixtureZLibrary(t)
	_, err := z.Connect(context.Background(), ZLibraryLogin{UserID: "123", UserKey: "own-session-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer z.Disconnect()
	base := z.transport
	z.transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/file") {
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":1,"file":{"downloadLink":"https://z-lib.gd/dl/novel.txt"}}`))}, nil
		}
		return base.RoundTrip(r)
	})
	ctx := context.WithValue(context.Background(), zLibraryGrantKey{}, "11:abcd12")
	_, err = z.Download(ctx, "11:abcd12", "txt", nil)
	if PublicError(err).Code != "NO_PERMISSION" {
		t.Fatal(err)
	}
}
func TestZLibraryLogoutDiscardsInFlightLogin(t *testing.T) {
	z := NewZLibrary("", nil)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	z.transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		once.Do(func() { close(entered) })
		<-release
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":1,"user":{"name":"Reader"}}`))}, nil
	})
	done := make(chan error, 1)
	go func() {
		_, e := z.Connect(context.Background(), ZLibraryLogin{UserID: "123", UserKey: "own-session-key"})
		done <- e
	}()
	<-entered
	z.Disconnect()
	close(release)
	if err := <-done; PublicError(err).Code != "CANCELLED" {
		t.Fatal(err)
	}
	if z.Status().Connected {
		t.Fatal("late login restored a logged-out account")
	}
}

func TestZLibraryExpiredAccountIsCleared(t *testing.T) {
	z, _ := fixtureZLibrary(t)
	_, err := z.Connect(context.Background(), ZLibraryLogin{UserID: "123", UserKey: "own-session-key"})
	if err != nil {
		t.Fatal(err)
	}
	z.transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 401, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"success":0}`))}, nil
	})
	_, err = z.Search(context.Background(), "novel", "")
	if PublicError(err).Code != "AUTH_REQUIRED" || z.Status().Connected {
		t.Fatal("expired account was still reported connected")
	}
}
