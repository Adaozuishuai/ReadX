package httpapi

import (
	"context"
	"encoding/xml"
	"html"
	"net/http"
	"regexp"
	"strings"
	"time"
)

type researchFeedItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	Published string `json:"published"`
	Summary   string `json:"summary"`
	Source    string `json:"source"`
}

var feedHTMLTagPattern = regexp.MustCompile(`<[^>]*>`)

var researchFeeds = map[string]struct{ url, source string }{
	"arxiv":    {"https://rss.arxiv.org/rss/cs.CV", "arXiv · cs.CV"},
	"journals": {"https://www.nature.com/nature.rss", "Nature"},
	"weekly":   {"https://www.ruanyifeng.com/blog/atom.xml", "科技爱好者周刊"},
}

func (s *Server) handleResearchFeed(w http.ResponseWriter, r *http.Request) {
	feed, ok := researchFeeds[r.URL.Query().Get("source")]
	if !ok {
		writeError(w, http.StatusBadRequest, "未知资讯源")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	raw, _, err := fetchPublic(ctx, feed.url, 4<<20)
	if err != nil {
		writeError(w, http.StatusBadGateway, "读取 RSS 失败："+err.Error())
		return
	}
	var document struct {
		Channel struct {
			Items []struct {
				Title       string `xml:"title"`
				Link        string `xml:"link"`
				GUID        string `xml:"guid"`
				PubDate     string `xml:"pubDate"`
				Description string `xml:"description"`
			} `xml:"item"`
		} `xml:"channel"`
		Entries []struct {
			ID    string `xml:"id"`
			Title string `xml:"title"`
			Link  struct {
				Href string `xml:"href,attr"`
			} `xml:"link"`
			Updated string `xml:"updated"`
			Summary string `xml:"summary"`
			Content string `xml:"content"`
		} `xml:"entry"`
	}
	if err = xml.Unmarshal(raw, &document); err != nil {
		writeError(w, http.StatusBadGateway, "RSS 格式无法解析")
		return
	}
	items := make([]researchFeedItem, 0, 20)
	for _, entry := range document.Channel.Items {
		url := strings.TrimSpace(entry.Link)
		if url == "" {
			url = strings.TrimSpace(entry.GUID)
		}
		items = append(items, researchFeedItem{ID: url, Title: cleanFeedText(entry.Title), URL: url, Published: strings.TrimSpace(entry.PubDate), Summary: cleanFeedText(entry.Description), Source: feed.source})
		if len(items) == 20 {
			break
		}
	}
	for _, entry := range document.Entries {
		if len(items) == 20 {
			break
		}
		url := strings.TrimSpace(entry.Link.Href)
		if url == "" {
			url = strings.TrimSpace(entry.ID)
		}
		summary := entry.Summary
		if summary == "" {
			summary = entry.Content
		}
		items = append(items, researchFeedItem{ID: url, Title: cleanFeedText(entry.Title), URL: url, Published: strings.TrimSpace(entry.Updated), Summary: cleanFeedText(summary), Source: feed.source})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "fetchedAt": time.Now().Format(time.RFC3339)})
}

func cleanFeedText(value string) string {
	value = html.UnescapeString(value)
	return strings.TrimSpace(feedHTMLTagPattern.ReplaceAllString(value, " "))
}
