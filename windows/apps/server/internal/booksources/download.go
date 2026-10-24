package booksources

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"cbctv2/server/internal/publication"
)

const MaxFileBytes int64 = 64 << 20

var bookPath = regexp.MustCompile(`^/ebooks/[1-9][0-9]*\.(epub3\.images|epub\.images|epub\.noimages|txt\.utf-8)$`)
var detailPath = regexp.MustCompile(`^/ebooks/[1-9][0-9]*\.opds$`)
var cachePath = regexp.MustCompile(`^/cache/epub/[1-9][0-9]*/(pg[1-9][0-9]*(-images(-3)?)?\.epub|pg[1-9][0-9]*\.txt)$`)
var filesPath = regexp.MustCompile(`^/files/[1-9][0-9]*/[1-9][0-9]*(-0)?\.txt$`)

func safeURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" || (u.Port() != "" && u.Port() != "443") {
		return nil, Fail("SOURCE_NOT_SUPPORTED", "书源地址未获准", 400)
	}
	switch u.Hostname() {
	case "gutendex.com":
		if u.Path != "/books/" && !regexp.MustCompile(`^/books/[1-9][0-9]*/?$`).MatchString(u.Path) {
			return nil, Fail("SOURCE_NOT_SUPPORTED", "书目路径未获准", 400)
		}
	case "gutenberg.org", "www.gutenberg.org":
		if u.Path == "/ebooks/search.opds/" || detailPath.MatchString(u.Path) {
			break
		}
		if u.RawQuery != "" || !(bookPath.MatchString(u.Path) || cachePath.MatchString(u.Path) || filesPath.MatchString(u.Path)) {
			return nil, Fail("SOURCE_NOT_SUPPORTED", "文件路径未获准", 400)
		}
	default:
		return nil, Fail("SOURCE_NOT_SUPPORTED", "书源主机未获准", 400)
	}
	return u, nil
}

var reservedNetworks = []netip.Prefix{
	netip.MustParsePrefix("100.64.0.0/10"), netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("64:ff9b::/96"),
}

func publicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	for _, prefix := range reservedNetworks {
		if prefix.Contains(addr) {
			return false
		}
	}
	return true
}

// PublicIP 报告 ip 是否允许作为出网目标（全局单播，且不在私网/回环/链路本地/
// reservedNetworks 保留网段内）。导出供其它包共享同一张判定表——此前
// httpapi 的 slack_books / publications 各自实现且各有缺口。
func PublicIP(ip net.IP) bool { return publicIP(ip) }

// DialPublicGuard 返回可直接挂到 http.Transport.DialContext 的拨号函数：
// 解析主机 → 要求全部解析结果通过 PublicIP（DNS rebinding 防御）→ 按 IP
// 直接拨号（pin），杜绝解析与拨号之间的 TOCTOU。
//
// proxy 非 nil 时沿用 newClient 的既有例外：代理自身地址直接放行（目标主机
// 的 URL 策略仍由调用方在 handler / CheckRedirect 层负责）。
//
// 使用方：booksources 各书源（经 newClient）、httpapi 的 slack_books 与
// publications——四处共享同一份出网防护。
func DialPublicGuard(dialTimeout time.Duration, proxy func(*http.Request) (*url.URL, error)) func(ctx context.Context, network, address string) (net.Conn, error) {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if proxy != nil {
			for _, scheme := range []string{"https", "http"} {
				p, _ := proxy(&http.Request{URL: &url.URL{Scheme: scheme, Host: "www.gutenberg.org"}})
				if p != nil && p.Hostname() == host {
					return (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, network, address)
				}
			}
		}
		if ip := net.ParseIP(host); ip != nil {
			if !publicIP(ip) {
				return nil, fmt.Errorf("拒绝访问本机或内网地址 %s", host)
			}
			return (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, network, address)
		}
		ips, err := resolvePublic(ctx, host)
		if err != nil {
			return nil, err
		}
		var last error
		for _, ip := range ips {
			conn, e := (&net.Dialer{Timeout: dialTimeout}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return conn, nil
			}
			last = e
		}
		return nil, last
	}
}

func resolvePublic(ctx context.Context, host string) ([]net.IPAddr, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, Fail("DOWNLOAD_FAILED", "无法解析书源地址", 502)
	}
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, Fail("SOURCE_NOT_SUPPORTED", "拒绝访问本机或内网地址", 400)
		}
	}
	return ips, nil
}

type guardedTransport struct{ base http.RoundTripper }

func (t guardedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if _, err := safeURL(r.URL.String()); err != nil {
		return nil, err
	}
	if _, err := resolvePublic(r.Context(), r.URL.Hostname()); err != nil {
		return nil, err
	}
	return t.base.RoundTrip(r)
}
func newClient(proxy func(*http.Request) (*url.URL, error)) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = proxy
	tr.ResponseHeaderTimeout = 20 * time.Second
	// Resolve and pin each direct connection. A configured system proxy is trusted
	// to perform its own DNS lookup; target host and public IP checks still apply.
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		// Proxy endpoints are allowed only from the application's proxy configuration.
		if proxy != nil {
			for _, scheme := range []string{"https", "http"} {
				p, _ := proxy(&http.Request{URL: &url.URL{Scheme: scheme, Host: "www.gutenberg.org"}})
				if p != nil && p.Hostname() == host {
					return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
				}
			}
		}
		ips, err := resolvePublic(ctx, host)
		if err != nil {
			return nil, err
		}
		var last error
		for _, ip := range ips {
			c, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return c, nil
			}
			last = e
		}
		return nil, last
	}
	return &http.Client{Timeout: 2 * time.Minute, Transport: guardedTransport{tr}, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return Fail("DOWNLOAD_FAILED", "书源重定向次数过多", 502)
		}
		_, err := safeURL(r.URL.String())
		return err
	}}
}
func get(ctx context.Context, client *http.Client, raw string) (*http.Response, error) {
	if _, err := safeURL(raw); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ReadX/1.0 book-source client")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != 200 {
		res.Body.Close()
		if res.StatusCode == 429 {
			return nil, Fail("RATE_LIMITED", "书源请求过于频繁，请稍后重试", 429)
		}
		return nil, Fail("DOWNLOAD_FAILED", fmt.Sprintf("书源返回 HTTP %d", res.StatusCode), 502)
	}
	return res, nil
}
func readCatalog(ctx context.Context, client *http.Client, raw string) ([]byte, error) {
	res, err := get(ctx, client, raw)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, (4<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 4<<20 {
		return nil, Fail("FILE_TOO_LARGE", "书目响应超过 4 MiB", 413)
	}
	return data, nil
}
func validateFile(data []byte, format, contentType string) error {
	media, _, _ := mime.ParseMediaType(contentType)
	invalid := func() error {
		return Fail("INVALID_FORMAT", "下载内容不是可阅读的 "+strings.ToUpper(format)+" 文件", 400)
	}
	if len(data) == 0 {
		return invalid()
	}
	switch format {
	case "epub":
		if media != "application/epub+zip" && media != "application/zip" && media != "application/octet-stream" {
			return invalid()
		}
		if !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
			return invalid()
		}
		z, err := publication.Archive(data)
		if err != nil {
			return invalid()
		}
		mt, err := publication.ReadResource(z, "mimetype")
		if err != nil || string(mt) != "application/epub+zip" {
			return invalid()
		}
		for _, f := range z.File {
			if strings.EqualFold(f.Name, "META-INF/encryption.xml") {
				return Fail("INVALID_FORMAT", "暂不支持加密或 DRM EPUB", 400)
			}
		}
		if _, err := publication.ParseEPUB(data); err != nil {
			return invalid()
		}
	case "txt":
		if media != "text/plain" || !utf8.Valid(data) || bytes.Contains(data, []byte{0}) {
			return invalid()
		}
		start := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(string(data[:min(len(data), 1024)]), "\ufeff")))
		if strings.HasPrefix(start, "<!doctype html") || strings.HasPrefix(start, "<html") || strings.HasPrefix(start, "<?xml") {
			return invalid()
		}
	default:
		return Fail("INVALID_FORMAT", "摸鱼书架支持 EPUB/TXT；PDF 请从科研书库导入", 400)
	}
	return nil
}
func download(ctx context.Context, client *http.Client, raw, id, format string, progress Progress) (Artifact, error) {
	// Gutenberg's legacy TXT shortcut redirects to HTTP. Use the documented
	// cache file over HTTPS directly, rather than permitting a scheme downgrade.
	if format == "txt" && strings.HasSuffix(raw, "/ebooks/"+id+".txt.utf-8") {
		raw = "https://www.gutenberg.org/cache/epub/" + id + "/pg" + id + ".txt"
	}
	res, err := get(ctx, client, raw)
	if err != nil {
		return Artifact{}, err
	}
	defer res.Body.Close()
	return readArtifact(ctx, res, id, format, progress)
}

// readArtifact shares the exact content/size validation between providers;
// each provider remains responsible for its own origin and redirect policy.
func readArtifact(ctx context.Context, res *http.Response, id, format string, progress Progress) (Artifact, error) {
	if res.ContentLength > MaxFileBytes {
		return Artifact{}, Fail("FILE_TOO_LARGE", "书籍超过 64 MiB", 413)
	}
	var buf bytes.Buffer
	chunk := make([]byte, 32<<10)
	var received int64
	for {
		n, e := res.Body.Read(chunk)
		if n > 0 {
			received += int64(n)
			if received > MaxFileBytes {
				return Artifact{}, Fail("FILE_TOO_LARGE", "书籍超过 64 MiB", 413)
			}
			buf.Write(chunk[:n])
			if progress != nil {
				progress(received, res.ContentLength)
			}
		}
		if e == io.EOF {
			break
		}
		if e != nil {
			return Artifact{}, e
		}
		if err := ctx.Err(); err != nil {
			return Artifact{}, err
		}
	}
	data := buf.Bytes()
	if err := validateFile(data, format, res.Header.Get("Content-Type")); err != nil {
		return Artifact{}, err
	}
	hash := sha256.Sum256(data)
	contentType := "text/plain;charset=utf-8"
	if format == "epub" {
		contentType = "application/epub+zip"
	}
	return Artifact{FileName: "readx-" + id + "." + format, ContentType: contentType, Data: data, SHA256: hex.EncodeToString(hash[:])}, nil
}
