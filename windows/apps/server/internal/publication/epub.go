// Package publication reads EPUB containers without executing document content.
// Only structured text and archive-local raster images reach the renderer.
package publication

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
)

type Block struct {
	Kind string `json:"kind"`
	Text string `json:"text,omitempty"`
	Src  string `json:"src,omitempty"`
	ID   string `json:"id,omitempty"`
}
type Section struct {
	Index  int     `json:"index"`
	Href   string  `json:"href"`
	Title  string  `json:"title"`
	Blocks []Block `json:"blocks,omitempty"`
	Text   string  `json:"text,omitempty"`
}
type Book struct {
	Title    string
	Authors  []string
	Sections []Section
}

func Archive(data []byte) (*zip.Reader, error) {
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("不是有效的 EPUB 压缩包: %w", err)
	}
	if len(z.File) > 10000 {
		return nil, fmt.Errorf("EPUB 资源数超过上限")
	}
	var total uint64
	for _, f := range z.File {
		if path.IsAbs(f.Name) || strings.Contains(f.Name, "\\") || path.Clean(f.Name) != strings.TrimSuffix(f.Name, "/") || strings.HasPrefix(f.Name, "../") {
			return nil, fmt.Errorf("EPUB 含非法资源路径")
		}
		total += f.UncompressedSize64
		if total > 256<<20 || f.UncompressedSize64 > 32<<20 {
			return nil, fmt.Errorf("EPUB 解压大小超过上限")
		}
	}
	return z, nil
}
func ReadResource(z *zip.Reader, name string) ([]byte, error) {
	f, err := z.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, (32<<20)+1))
	if len(b) > 32<<20 {
		return nil, fmt.Errorf("资源过大")
	}
	return b, err
}
func ParseEPUB(data []byte) (Book, error) {
	z, err := Archive(data)
	if err != nil {
		return Book{}, err
	}
	container, err := ReadResource(z, "META-INF/container.xml")
	if err != nil {
		return Book{}, fmt.Errorf("EPUB 缺少 container.xml")
	}
	var c struct {
		Roots []struct {
			Path string `xml:"full-path,attr"`
		} `xml:"rootfiles>rootfile"`
	}
	if err = xml.Unmarshal(container, &c); err != nil || len(c.Roots) == 0 {
		return Book{}, fmt.Errorf("无法读取 EPUB 根文档")
	}
	opfPath := c.Roots[0].Path
	raw, err := ReadResource(z, opfPath)
	if err != nil {
		return Book{}, err
	}
	var opf struct {
		Metadata struct {
			Titles   []string `xml:"title"`
			Creators []string `xml:"creator"`
		} `xml:"metadata"`
		Items []struct {
			ID    string `xml:"id,attr"`
			Href  string `xml:"href,attr"`
			Media string `xml:"media-type,attr"`
		} `xml:"manifest>item"`
		Spine []struct {
			Ref    string `xml:"idref,attr"`
			Linear string `xml:"linear,attr"`
		} `xml:"spine>itemref"`
	}
	if err = xml.Unmarshal(raw, &opf); err != nil {
		return Book{}, fmt.Errorf("无法读取 EPUB 清单: %w", err)
	}
	book := Book{Authors: opf.Metadata.Creators, Sections: []Section{}}
	if len(opf.Metadata.Titles) > 0 {
		book.Title = strings.TrimSpace(opf.Metadata.Titles[0])
	}
	for _, ref := range opf.Spine {
		if ref.Linear == "no" {
			continue
		}
		for _, item := range opf.Items {
			if item.ID != ref.Ref {
				continue
			}
			if item.Media != "application/xhtml+xml" && item.Media != "text/html" {
				continue
			}
			href, err := localPath(opfPath, item.Href)
			if err != nil {
				return Book{}, err
			}
			content, err := ReadResource(z, href)
			if err != nil {
				return Book{}, err
			}
			blocks, title, err := parseChapter(content, href)
			if err != nil {
				return Book{}, fmt.Errorf("章节 %s: %w", href, err)
			}
			if title == "" {
				title = fmt.Sprintf("第 %d 章", len(book.Sections)+1)
			}
			var paragraphs []string
			for _, b := range blocks {
				if b.Text != "" {
					paragraphs = append(paragraphs, b.Text)
				}
			}
			book.Sections = append(book.Sections, Section{Index: len(book.Sections) + 1, Href: href, Title: title, Blocks: blocks, Text: strings.Join(paragraphs, "\n\n")})
		}
	}
	if len(book.Sections) == 0 {
		return Book{}, fmt.Errorf("EPUB 没有可读章节（暂不支持 DRM 或固定版式）")
	}
	return book, nil
}
func localPath(base, ref string) (string, error) {
	u, err := url.Parse(ref)
	if err != nil || u.IsAbs() || u.Host != "" {
		return "", fmt.Errorf("EPUB 资源必须在文档内")
	}
	decoded, err := url.PathUnescape(u.Path)
	if err != nil {
		return "", err
	}
	p := path.Join(path.Dir(base), decoded)
	if strings.HasPrefix(p, "../") || path.IsAbs(p) || strings.Contains(p, "\\") {
		return "", fmt.Errorf("EPUB 资源越界")
	}
	return p, nil
}
func parseChapter(raw []byte, href string) ([]Block, string, error) {
	d := xml.NewDecoder(bytes.NewReader(raw))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	blocks := []Block{}
	var text strings.Builder
	kind, id, title := "p", "", ""
	skip, body := 0, false
	flush := func() {
		t := strings.TrimSpace(text.String())
		if kind != "pre" {
			t = strings.Join(strings.Fields(t), " ")
		}
		text.Reset()
		if t != "" {
			blocks = append(blocks, Block{Kind: kind, Text: t, ID: id})
			if title == "" && strings.HasPrefix(kind, "h") {
				title = t
			}
		}
		id = ""
	}
	blockTags := map[string]bool{"p": true, "h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true, "li": true, "blockquote": true, "pre": true, "tr": true, "div": true, "section": true}
	for {
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", err
		}
		switch t := tok.(type) {
		case xml.StartElement:
			tag := strings.ToLower(t.Name.Local)
			if tag == "body" {
				body = true
			}
			if !body {
				continue
			}
			if skip > 0 {
				skip++
				continue
			}
			if tag == "script" || tag == "style" || tag == "iframe" || tag == "object" || tag == "svg" {
				skip = 1
				continue
			}
			if blockTags[tag] {
				flush()
				kind = tag
				for _, a := range t.Attr {
					if a.Name.Local == "id" {
						id = a.Value
					}
				}
			}
			if tag == "br" || tag == "td" || tag == "th" {
				text.WriteByte(' ')
			}
			if tag == "img" {
				flush()
				for _, a := range t.Attr {
					if a.Name.Local == "src" {
						src, e := localPath(href, a.Value)
						if e == nil {
							blocks = append(blocks, Block{Kind: "image", Src: src})
						}
					}
				}
			}
		case xml.EndElement:
			if skip > 0 {
				skip--
				continue
			}
			if blockTags[strings.ToLower(t.Name.Local)] {
				flush()
				kind = "p"
			}
			if t.Name.Local == "body" {
				body = false
			}
		case xml.CharData:
			if body && skip == 0 {
				text.Write(t)
			}
		}
	}
	flush()
	return blocks, title, nil
}
