package publication

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"
)

func fixture(t *testing.T, extra string) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	files := map[string]string{
		"mimetype": "application/epub+zip", "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>`,
		"OEBPS/book.opf":     `<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Reading fixture</dc:title><dc:creator>Ada</dc:creator></metadata><manifest><item id="b" href="second.xhtml" media-type="application/xhtml+xml"/><item id="a" href="first.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>`,
		"OEBPS/first.xhtml":  `<html><head><title>Head</title></head><body><h1>First</h1><p>A <b>bold</b> paragraph.</p><script>secret()</script><iframe src="https://evil.test"/><img src="images/a.png"/><img src="https://evil.test/a.png"/></body></html>`,
		"OEBPS/second.xhtml": `<html><body><h2>Second</h2><p>Second chapter</p></body></html>`}
	if extra != "" {
		files[extra] = "bad"
	}
	for name, text := range files {
		f, e := z.Create(name)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.Write([]byte(text)); e != nil {
			t.Fatal(e)
		}
	}
	if e := z.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func TestEPUBSpineAndSafeContent(t *testing.T) {
	book, err := ParseEPUB(fixture(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	if book.Title != "Reading fixture" || len(book.Authors) != 1 || len(book.Sections) != 2 || book.Sections[0].Title != "First" {
		t.Fatalf("metadata/spine lost: %+v", book)
	}
	first := book.Sections[0]
	if strings.Contains(first.Text, "secret") || !strings.Contains(first.Text, "A bold paragraph.") {
		t.Fatal(first.Text)
	}
	if first.Blocks[len(first.Blocks)-1].Src != "OEBPS/images/a.png" {
		t.Fatalf("image resolution: %+v", first.Blocks)
	}
}
func TestEPUBRejectsTraversalAndMalformedContainers(t *testing.T) {
	if _, err := ParseEPUB(fixture(t, "../outside")); err == nil {
		t.Fatal("traversal accepted")
	}
	for _, value := range [][]byte{nil, []byte("not an epub")} {
		if _, err := ParseEPUB(value); err == nil {
			t.Fatal("invalid EPUB accepted")
		}
	}
}
func TestLocalResourcesRejectExternalAndEscapingPaths(t *testing.T) {
	for _, ref := range []string{"../../etc/passwd", "https://evil.test/a", "//evil.test/a", "..\\secret"} {
		if _, err := localPath("OEBPS/chapter.xhtml", ref); err == nil {
			t.Fatalf("accepted %s", ref)
		}
	}
}
