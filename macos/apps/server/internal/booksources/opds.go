package booksources

import (
	"bytes"
	"context"
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// MVP registers the official Gutenberg OPDS catalog only. Adding another
// catalog requires an explicit origin/path policy and rights mapping.
type opds struct{ client *http.Client }
type atomLink struct {
	Rel  string `xml:"rel,attr"`
	Type string `xml:"type,attr"`
	Href string `xml:"href,attr"`
}
type atomEntry struct {
	ID       string `xml:"id"`
	Title    string `xml:"title"`
	Summary  string `xml:"summary"`
	Content  string `xml:"content"`
	Rights   string `xml:"rights"`
	Language string `xml:"language"`
	Authors  []struct {
		Name string `xml:"name"`
	} `xml:"author"`
	Links []atomLink `xml:"link"`
}
type atomFeed struct {
	XMLName xml.Name    `xml:"http://www.w3.org/2005/Atom feed"`
	Entries []atomEntry `xml:"entry"`
	Links   []atomLink  `xml:"link"`
}

func parseFeed(data []byte) (atomFeed, error) {
	var feed atomFeed
	// encoding/xml never fetches external entities. Reject directives too, so
	// catalogs cannot introduce a DTD or custom entity declarations.
	d := xml.NewDecoder(bytes.NewReader(data))
	for {
		t, e := d.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			return feed, Fail("DOWNLOAD_FAILED", "OPDS XML 无效", 502)
		}
		if _, ok := t.(xml.Directive); ok {
			return feed, Fail("SOURCE_NOT_SUPPORTED", "OPDS 不允许 DTD 或实体声明", 400)
		}
	}
	if xml.Unmarshal(data, &feed) != nil || len(feed.Entries) > 100 {
		return feed, Fail("DOWNLOAD_FAILED", "OPDS 书目格式无效或条目过多", 502)
	}
	return feed, nil
}
func (p *opds) Info() Source {
	return Source{"opds", "OPDS · Gutenberg 官方目录", true, Capability{Search: true, Detail: true, Download: true}, "已登记的官方 Atom/OPDS 目录；不接受任意下载 URL"}
}

var atomID = regexp.MustCompile(`^https://www\.gutenberg\.org/ebooks/([1-9][0-9]*)\.opds$`)
var atomURN = regexp.MustCompile(`^urn:gutenberg:([1-9][0-9]*):[0-9]+$`)

func entryID(e atomEntry) string {
	m := atomID.FindStringSubmatch(e.ID)
	if len(m) != 2 {
		m = atomURN.FindStringSubmatch(e.ID)
	}
	if len(m) == 2 && validID(m[1]) {
		return m[1]
	}
	return ""
}
func resolveLink(raw string) string {
	base, _ := url.Parse("https://www.gutenberg.org/")
	u, e := url.Parse(raw)
	if e != nil {
		return ""
	}
	return base.ResolveReference(u).String()
}
func (e atomEntry) file(format string) string {
	want := "application/epub+zip"
	if format == "txt" {
		want = "text/plain"
	}
	if format != "epub" && format != "txt" {
		return ""
	}
	for _, l := range e.Links {
		if (l.Rel == "http://opds-spec.org/acquisition" || l.Rel == "http://opds-spec.org/acquisition/open-access") && strings.Split(l.Type, ";")[0] == want {
			raw := resolveLink(l.Href)
			u, err := safeURL(raw)
			if err == nil && u.Hostname() != "gutendex.com" && (bookPath.MatchString(u.Path) || cachePath.MatchString(u.Path) || filesPath.MatchString(u.Path)) {
				return raw
			}
		}
	}
	return ""
}
func (e atomEntry) book() Book {
	b := Book{ID: entryID(e), ProviderID: "opds", Title: e.Title, Authors: []string{}, Formats: []string{}, Language: e.Language, Description: e.Summary, Rights: publicRights(strings.TrimSpace(e.Rights) == "Public domain in the USA.")}
	if b.Description == "" {
		b.Description = e.Content
	}
	for _, a := range e.Authors {
		b.Authors = append(b.Authors, a.Name)
	}
	if len(b.Authors) == 0 && e.Content != "" && e.Summary == "" {
		b.Authors = append(b.Authors, e.Content)
		b.Description = ""
	}
	if b.ID != "" {
		b.SourceURL = "https://www.gutenberg.org/ebooks/" + b.ID
	}
	for _, f := range []string{"epub", "txt"} {
		if e.file(f) != "" {
			b.Formats = append(b.Formats, f)
		}
	}
	for _, l := range e.Links {
		if l.Rel == "http://opds-spec.org/image/thumbnail" && strings.HasPrefix(resolveLink(l.Href), "https://www.gutenberg.org/cache/epub/") {
			b.CoverURL = resolveLink(l.Href)
		}
	}
	return b
}
func (p *opds) Search(ctx context.Context, q, cursor string) (SearchResult, error) {
	page, err := pageNumber(cursor)
	if err != nil {
		return SearchResult{}, err
	}
	raw := "https://www.gutenberg.org/ebooks/search.opds/?" + url.Values{"query": {q}, "start_index": {strconv.Itoa((page-1)*25 + 1)}}.Encode()
	data, err := readCatalog(ctx, p.client, raw)
	if err != nil {
		return SearchResult{}, err
	}
	feed, err := parseFeed(data)
	if err != nil {
		return SearchResult{}, err
	}
	out := SearchResult{Books: []Book{}}
	for _, e := range feed.Entries {
		if entryID(e) != "" {
			out.Books = append(out.Books, e.book())
		}
	}
	for _, l := range feed.Links {
		if l.Rel == "next" {
			out.NextCursor = strconv.Itoa(page + 1)
		}
	}
	return out, nil
}
func (p *opds) entry(ctx context.Context, id string) (atomEntry, error) {
	if !validID(id) {
		return atomEntry{}, Fail("SOURCE_NOT_SUPPORTED", "书籍编号无效", 400)
	}
	data, err := readCatalog(ctx, p.client, "https://www.gutenberg.org/ebooks/"+id+".opds")
	if err != nil {
		return atomEntry{}, err
	}
	feed, err := parseFeed(data)
	if err != nil {
		return atomEntry{}, err
	}
	for _, e := range feed.Entries {
		if entryID(e) == id && len(e.book().Formats) > 0 {
			return e, nil
		}
	}
	return atomEntry{}, Fail("INVALID_FORMAT", "该目录没有可导入的 EPUB/TXT；PDF 请从科研书库导入", 400)
}
func (p *opds) Detail(ctx context.Context, id string) (Book, error) {
	e, err := p.entry(ctx, id)
	return e.book(), err
}
func (p *opds) Download(ctx context.Context, id, format string, progress Progress) (Artifact, error) {
	e, err := p.entry(ctx, id)
	if err != nil {
		return Artifact{}, err
	}
	if !e.book().Rights.AllowsDownload() {
		return Artifact{}, Fail("NO_PERMISSION", "OPDS 未明确允许下载和阅读", 403)
	}
	raw := e.file(format)
	if raw == "" {
		return Artifact{}, Fail("INVALID_FORMAT", "目录未提供该格式", 400)
	}
	return download(ctx, p.client, raw, id, format, progress)
}
