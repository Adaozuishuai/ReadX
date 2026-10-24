package booksources

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type mockProvider struct {
	rights Rights
	calls  atomic.Int32
	block  bool
	fail   bool
}

func (p *mockProvider) Info() Source {
	return Source{ProviderID: "mock", Enabled: true, Capabilities: Capability{Search: true, Detail: true, Download: true}}
}
func (p *mockProvider) Search(context.Context, string, string) (SearchResult, error) {
	return SearchResult{Books: []Book{{ID: "1", Rights: p.rights}}}, nil
}
func (p *mockProvider) Detail(context.Context, string) (Book, error) {
	return Book{ID: "1", ProviderID: "mock", Formats: []string{"txt"}, Rights: p.rights}, nil
}
func (p *mockProvider) Download(ctx context.Context, id, format string, progress Progress) (Artifact, error) {
	p.calls.Add(1)
	if p.block {
		<-ctx.Done()
		return Artifact{}, ctx.Err()
	}
	if p.fail {
		return Artifact{}, Fail("DOWNLOAD_FAILED", "断开", 502)
	}
	progress(7, 7)
	return Artifact{FileName: "safe.txt", ContentType: "text/plain", Data: []byte("a novel"), SHA256: "hash"}, nil
}
func waitState(t *testing.T, r *Registry, id, state string) Task {
	t.Helper()
	deadline := time.Now().Add(time.Second * 3)
	for time.Now().Before(deadline) {
		task, e := r.Status(id)
		if e != nil {
			t.Fatal(e)
		}
		if task.State == state {
			return task
		}
		time.Sleep(time.Millisecond * 5)
	}
	t.Fatalf("task never reached %s", state)
	return Task{}
}
func TestRegistryRightsAndCapabilities(t *testing.T) {
	for _, rights := range []Rights{{Access: "unknown"}, {Access: "denied", CanDownload: true, CanCache: true, CanRead: true}, {Access: "allowed", CanDownload: true, CanRead: true}} {
		p := &mockProvider{rights: rights}
		r := New(t.TempDir(), p)
		_, err := r.Start(context.Background(), "mock", "1", "txt")
		if PublicError(err).Code != "NO_PERMISSION" || p.calls.Load() != 0 {
			t.Fatal("permission bypass", err)
		}
	}
	r := New(t.TempDir(), DefaultProviders(nil)...)
	sources := r.Sources()
	if len(sources) != 3 || !sources[2].Enabled || !sources[2].Capabilities.Search || !sources[2].Capabilities.RequiresAuth {
		t.Fatal(sources)
	}
	_, err := r.Search(context.Background(), "zlibrary", "test", "")
	if PublicError(err).Code != "AUTH_REQUIRED" {
		t.Fatal(err)
	}
}
func TestRegistryLifecycleDedupeCancelAndRetry(t *testing.T) {
	p := &mockProvider{rights: publicRights(true), block: true}
	r := New(t.TempDir(), p)
	first, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	second, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil || first.ID != second.ID {
		t.Fatal("duplicate job")
	}
	waitState(t, r, first.ID, "running")
	if _, _, err := r.File(first.ID); err == nil {
		t.Fatal("incomplete file served")
	}
	_, _ = r.Cancel(first.ID)
	time.Sleep(time.Millisecond * 10)
	task, _ := r.Status(first.ID)
	if task.State != "cancelled" {
		t.Fatal(task)
	}
	p2 := &mockProvider{rights: publicRights(true), fail: true}
	r2 := New(t.TempDir(), p2)
	a, _ := r2.Start(context.Background(), "mock", "1", "txt")
	waitState(t, r2, a.ID, "failed")
	b, _ := r2.Start(context.Background(), "mock", "1", "txt")
	if a.ID == b.ID {
		t.Fatal("failed task reused")
	}
	waitState(t, r2, b.ID, "failed")
}
func TestRegistryReadyAndExpiry(t *testing.T) {
	p := &mockProvider{rights: publicRights(true)}
	r := New(t.TempDir(), p)
	task, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	done := waitState(t, r, task.ID, "ready")
	if done.ReceivedBytes != 7 {
		t.Fatal(done)
	}
	_, f, err := r.File(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(f)
	f.Close()
	if string(data) != "a novel" {
		t.Fatal(string(data))
	}
	r.mu.Lock()
	file := r.tasks[task.ID].file
	r.tasks[task.ID].touched = time.Now().Add(-11 * time.Minute)
	r.mu.Unlock()
	if _, err := r.Status(task.ID); err == nil {
		t.Fatal("expired")
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("file not cleaned")
	}
}

func TestSharedDownloadSurvivesAnotherWindowsCleanup(t *testing.T) {
	r := New(t.TempDir(), &mockProvider{rights: publicRights(true)})
	first, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	waitState(t, r, first.ID, "ready")
	second, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || first.LeaseID == "" || first.LeaseID == second.LeaseID {
		t.Fatal("shared downloads need independent caller leases")
	}
	if _, err := r.Release(first.ID, ""); err == nil {
		t.Fatal("missing lease must not release a shared task")
	}
	for range 2 { // unmount and finally may both release the same caller.
		if _, err := r.Release(first.ID, first.LeaseID); err != nil {
			t.Fatal(err)
		}
	}
	_, file, err := r.File(second.ID)
	if err != nil {
		t.Fatal("another caller lost its download:", err)
	}
	file.Close()
	if _, err := r.Release(second.ID, second.LeaseID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := r.File(second.ID); err == nil {
		t.Fatal("last release must clean the download")
	}
}

func TestSharedRunningDownloadNeedsLastReleaseToCancel(t *testing.T) {
	r := New(t.TempDir(), &mockProvider{rights: publicRights(true), block: true})
	first, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Cancel(first.ID)
	waitState(t, r, first.ID, "running")
	second, err := r.Start(context.Background(), "mock", "1", "txt")
	if err != nil {
		t.Fatal(err)
	}
	task, err := r.Release(first.ID, first.LeaseID)
	if err != nil || task.State != "running" {
		t.Fatalf("first caller cancelled shared transfer: %+v %v", task, err)
	}
	task, err = r.Release(second.ID, second.LeaseID)
	if err != nil || task.State != "cancelled" {
		t.Fatalf("last caller did not cancel transfer: %+v %v", task, err)
	}
}

func TestRegistryOnlyTwoTransfersRun(t *testing.T) {
	p := &mockProvider{rights: publicRights(true), block: true}
	r := New(t.TempDir(), p)
	var tasks []Task
	for _, id := range []string{"1", "2", "3"} {
		task, err := r.Start(context.Background(), "mock", id, "txt")
		if err != nil {
			t.Fatal(err)
		}
		tasks = append(tasks, task)
	}
	defer func() {
		for _, task := range tasks {
			_, _ = r.Cancel(task.ID)
		}
	}()
	deadline := time.Now().Add(time.Second)
	for p.calls.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if p.calls.Load() != 2 {
		t.Fatal("transfers did not start")
	}
	time.Sleep(20 * time.Millisecond)
	if p.calls.Load() != 2 {
		t.Fatal("more than two transfers running")
	}
}

func TestRedirectToPrivateHostNeverRequestsIt(t *testing.T) {
	c := newClient(nil)
	var calls int
	c.Transport = roundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": {"https://127.0.0.1/private"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
	})
	_, err := download(context.Background(), c, "https://www.gutenberg.org/ebooks/1.epub3.images", "1", "epub", nil)
	if err == nil || calls != 1 {
		t.Fatalf("redirect escaped policy: calls=%d error=%v", calls, err)
	}
}
func TestURLAndIPPolicy(t *testing.T) {
	for _, raw := range []string{"http://www.gutenberg.org/ebooks/1.epub3.images", "https://127.0.0.1/ebooks/1.epub3.images", "https://www.gutenberg.org:444/ebooks/1.epub3.images", "https://x@www.gutenberg.org/ebooks/1.epub3.images", "https://www.gutenberg.org/ebooks/1.epub3.images?q=x", "https://gutendex.com/admin/", "https://www.gutenberg.org/ebooks/../secret", "https://169.254.169.254/"} {
		if _, err := safeURL(raw); err == nil {
			t.Fatal(raw)
		}
	}
	for _, ip := range []string{"127.0.0.1", "10.1.2.3", "192.168.1.2", "172.16.0.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "100.64.0.1", "198.18.0.1", "2001:db8::1"} {
		if publicIP(net.ParseIP(ip)) {
			t.Fatal(ip)
		}
	}
	c := newClient(nil)
	for _, raw := range []string{"https://127.0.0.1/a", "http://www.gutenberg.org/ebooks/1.epub3.images", "https://example.com/a"} {
		u, _ := url.Parse(raw)
		if c.CheckRedirect(&http.Request{URL: u}, []*http.Request{{}}) == nil {
			t.Fatal(raw)
		}
	}
}
func epubFixture(extra string, bomb bool) []byte {
	var buf bytes.Buffer
	z := zip.NewWriter(&buf)
	files := map[string]string{"mimetype": "application/epub+zip", "META-INF/container.xml": `<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>`, "book.opf": `<package><metadata><title>Novel</title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`, "c.xhtml": `<html><body><h1>Novel</h1><p>Text.</p></body></html>`}
	if extra != "" {
		files[extra] = "bad"
	}
	for name, data := range files {
		f, _ := z.Create(name)
		_, _ = io.WriteString(f, data)
	}
	if bomb {
		f, _ := z.CreateRaw(&zip.FileHeader{Name: "huge", Method: zip.Store, UncompressedSize64: 300 << 20})
		_, _ = f.Write(nil)
	}
	z.Close()
	return buf.Bytes()
}
func TestFileValidation(t *testing.T) {
	if err := validateFile(epubFixture("", false), "epub", "application/epub+zip"); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{[]byte("<html>wrong</html>"), epubFixture("../outside", false), epubFixture("META-INF/encryption.xml", false), epubFixture("", true)} {
		if validateFile(data, "epub", "application/epub+zip") == nil {
			t.Fatal("invalid epub accepted")
		}
	}
	for _, data := range [][]byte{[]byte("<html>denied</html>"), {0, 1, 2}, {0xff}} {
		if validateFile(data, "txt", "text/plain") == nil {
			t.Fatal("invalid text")
		}
	}
	if validateFile([]byte("a novel"), "txt", "text/html") == nil {
		t.Fatal("mime bypass")
	}
	if validateFile([]byte("a novel"), "txt", "text/plain; charset=utf-8") != nil {
		t.Fatal("text rejected")
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestDownloadUpstreamFailuresAndHTTPSPath(t *testing.T) {
	for _, status := range []int{404, 429, 500} {
		c := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader("error")), Header: http.Header{}}, nil
		})}
		_, err := download(context.Background(), c, "https://www.gutenberg.org/ebooks/1.txt.utf-8", "1", "txt", nil)
		if err == nil {
			t.Fatal(status)
		}
		if status == 429 && PublicError(err).Code != "RATE_LIMITED" {
			t.Fatal(err)
		}
	}
	c := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://www.gutenberg.org/cache/epub/1/pg1.txt" {
			t.Fatal(r.URL)
		}
		return &http.Response{StatusCode: 200, ContentLength: MaxFileBytes + 1, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{"Content-Type": {"text/plain"}}}, nil
	})}
	_, err := download(context.Background(), c, "https://www.gutenberg.org/ebooks/1.txt.utf-8", "1", "txt", nil)
	if PublicError(err).Code != "FILE_TOO_LARGE" {
		t.Fatal(err)
	}
}
func TestOPDSUnknownRightsAndXML(t *testing.T) {
	entry := atomEntry{ID: "https://www.gutenberg.org/ebooks/1.opds", Title: "Novel", Rights: "unknown", Links: []atomLink{{Rel: "http://opds-spec.org/acquisition/open-access", Type: "application/epub+zip", Href: "/ebooks/1.epub.noimages"}}}
	if entry.book().Rights.AllowsDownload() {
		t.Fatal("unknown rights accepted")
	}
	entry.Rights = "Public domain in the USA."
	entry.ID = "urn:gutenberg:1:2"
	if !entry.book().Rights.AllowsDownload() || len(entry.book().Formats) != 1 {
		t.Fatal(entry.book())
	}
	for _, raw := range []string{`<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///secret">]><feed xmlns="http://www.w3.org/2005/Atom"/>`, `<html/>`, `<feed>&secret;</feed>`} {
		if _, err := parseFeed([]byte(raw)); err == nil {
			t.Fatal(raw)
		}
	}
}
