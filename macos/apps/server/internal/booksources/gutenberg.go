package booksources

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type gutenberg struct{ client *http.Client }
type gutenbergRecord struct {
	ID      int    `json:"id"`
	Title   string `json:"title"`
	Authors []struct {
		Name string `json:"name"`
	} `json:"authors"`
	Summaries []string          `json:"summaries"`
	Languages []string          `json:"languages"`
	Copyright *bool             `json:"copyright"`
	Formats   map[string]string `json:"formats"`
}

func (p *gutenberg) Info() Source {
	return Source{"gutenberg", "Project Gutenberg", true, Capability{Search: true, Detail: true, Download: true}, "Gutendex 书目 · 美国公版状态，使用前请核对所在地规则"}
}
func validID(id string) bool {
	n, err := strconv.Atoi(id)
	return err == nil && n > 0 && n < 10000000 && strconv.Itoa(n) == id
}
func pageNumber(cursor string) (int, error) {
	if cursor == "" {
		return 1, nil
	}
	n, e := strconv.Atoi(cursor)
	if e != nil || n < 1 || n > 100000 {
		return 0, Fail("SOURCE_NOT_SUPPORTED", "分页游标无效", 400)
	}
	return n, nil
}
func publicRights(allowed bool) Rights {
	if allowed {
		return Rights{"allowed", "public_domain", true, true, true, "来源标注为美国公版；其他地区请核对当地规则"}
	}
	return Rights{Access: "unknown", Reason: "来源未明确标注可下载、缓存与阅读的权利"}
}
func (g gutenbergRecord) book() Book {
	b := Book{ID: strconv.Itoa(g.ID), ProviderID: "gutenberg", Title: g.Title, Authors: []string{}, Formats: []string{}, SourceURL: "https://www.gutenberg.org/ebooks/" + strconv.Itoa(g.ID), Rights: publicRights(g.Copyright != nil && !*g.Copyright)}
	for _, a := range g.Authors {
		b.Authors = append(b.Authors, a.Name)
	}
	if len(g.Languages) > 0 {
		b.Language = strings.Join(g.Languages, ", ")
	}
	if len(g.Summaries) > 0 {
		b.Description = g.Summaries[0]
	}
	if u, e := url.Parse(g.Formats["image/jpeg"]); e == nil && u.Scheme == "https" && u.Host == "www.gutenberg.org" {
		b.CoverURL = u.String()
	}
	for _, format := range []string{"epub", "txt"} {
		if g.file(format) != "" {
			b.Formats = append(b.Formats, format)
		}
	}
	return b
}
func (g gutenbergRecord) file(format string) string {
	// Prefer the smaller image-free edition for leisure reading when offered.
	var candidates []string
	for mime, raw := range g.Formats {
		if (format == "epub" && mime == "application/epub+zip") || (format == "txt" && strings.HasPrefix(mime, "text/plain")) {
			candidates = append(candidates, raw)
		}
	}
	for _, raw := range candidates {
		u, e := safeURL(raw)
		if e == nil && u.Hostname() != "gutendex.com" && (bookPath.MatchString(u.Path) || cachePath.MatchString(u.Path) || filesPath.MatchString(u.Path)) {
			return raw
		}
	}
	return ""
}
func (p *gutenberg) record(ctx context.Context, id string) (gutenbergRecord, error) {
	var g gutenbergRecord
	if !validID(id) {
		return g, Fail("SOURCE_NOT_SUPPORTED", "书籍编号无效", 400)
	}
	data, err := readCatalog(ctx, p.client, "https://gutendex.com/books/"+id+"/")
	if err != nil {
		return g, err
	}
	if json.Unmarshal(data, &g) != nil || strconv.Itoa(g.ID) != id {
		return g, Fail("DOWNLOAD_FAILED", "书目信息无效", 502)
	}
	return g, nil
}
func (p *gutenberg) Search(ctx context.Context, q, cursor string) (SearchResult, error) {
	page, err := pageNumber(cursor)
	if err != nil {
		return SearchResult{}, err
	}
	params := url.Values{"search": {q}}
	if page > 1 {
		params.Set("page", strconv.Itoa(page))
	}
	raw := "https://gutendex.com/books/?" + params.Encode()
	data, err := readCatalog(ctx, p.client, raw)
	if err != nil {
		return SearchResult{}, err
	}
	var result struct {
		Next    *string           `json:"next"`
		Results []gutenbergRecord `json:"results"`
	}
	if json.Unmarshal(data, &result) != nil {
		return SearchResult{}, Fail("DOWNLOAD_FAILED", "书目响应格式无效", 502)
	}
	out := SearchResult{Books: []Book{}}
	for _, g := range result.Results {
		if len(out.Books) >= 32 {
			break
		}
		out.Books = append(out.Books, g.book())
	}
	if result.Next != nil {
		out.NextCursor = strconv.Itoa(page + 1)
	}
	return out, nil
}
func (p *gutenberg) Detail(ctx context.Context, id string) (Book, error) {
	g, e := p.record(ctx, id)
	return g.book(), e
}
func (p *gutenberg) Download(ctx context.Context, id, format string, progress Progress) (Artifact, error) {
	g, e := p.record(ctx, id)
	if e != nil {
		return Artifact{}, e
	}
	if !g.book().Rights.AllowsDownload() {
		return Artifact{}, Fail("NO_PERMISSION", "来源未明确允许下载和阅读", 403)
	}
	raw := g.file(format)
	if raw == "" {
		return Artifact{}, Fail("INVALID_FORMAT", "没有可用的 EPUB/TXT 文件", 400)
	}
	return download(ctx, p.client, raw, id, format, progress)
}

func defaultProviders(proxy func(*http.Request) (*url.URL, error)) []Provider {
	return DefaultProvidersWithZLibrary(proxy, NewZLibrary("", proxy))
}
func DefaultProvidersWithZLibrary(proxy func(*http.Request) (*url.URL, error), z *ZLibrary) []Provider {
	client := newClient(proxy)
	return []Provider{&gutenberg{client}, &opds{client}, z}
}
