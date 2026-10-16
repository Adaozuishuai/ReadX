package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

type dailyPaper struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Authors   []string `json:"authors"`
	Venue     string   `json:"venue"`
	VenueTier int      `json:"venueTier"`
	Year      int      `json:"year"`
	Published string   `json:"published"`
	DOI       string   `json:"doi"`
	URL       string   `json:"url"`
	PDFURL    string   `json:"pdfUrl"`
	Abstract  string   `json:"abstract"`
}

// Venue tiers keep the v1 preference for leading conference proceedings while
// giving top medical-imaging journals equal priority and field meetings a
// separate lower tier. Workshop proceedings are deliberately excluded.
var dailyVenueRules = []struct {
	label string
	tier  int
	cues  []string
}{
	{"MICCAI", 0, []string{"miccai", "medical image computing and computer-assisted intervention", "medical image computing and computer assisted intervention"}},
	{"CVPR", 0, []string{"cvpr", "computer vision and pattern recognition"}},
	{"ICCV", 0, []string{"iccv", "international conference on computer vision"}},
	{"ECCV", 0, []string{"eccv", "european conference on computer vision"}},
	{"NeurIPS", 0, []string{"neurips", "neural information processing systems"}},
	{"ICLR", 0, []string{"iclr", "international conference on learning representations"}},
	{"AAAI", 0, []string{"aaai", "association for the advancement of artificial intelligence"}},
	{"TMI", 0, []string{"ieee transactions on medical imaging", "transactions on medical imaging"}},
	{"Medical Image Analysis", 0, []string{"medical image analysis"}},
	{"ISBI", 1, []string{"isbi", "international symposium on biomedical imaging"}},
	{"SPIE Medical Imaging", 1, []string{"spie medical imaging", "medical imaging (spie)"}},
}

func dailyVenue(raw string) (string, int, bool) {
	lower := strings.ToLower(strings.TrimSpace(raw))
	if lower == "" || strings.Contains(lower, "workshop") || strings.Contains(lower, "work in progress") {
		return "", 0, false
	}
	for _, rule := range dailyVenueRules {
		for _, cue := range rule.cues {
			if strings.Contains(lower, cue) {
				return rule.label, rule.tier, true
			}
		}
	}
	return "", 0, false
}

func (s *Server) handleDailyRecommendations(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	endpoint := "https://api.semanticscholar.org/graph/v1/paper/search?query=" + url.QueryEscape("cone beam CT reconstruction sparse view") +
		"&fields=" + url.QueryEscape("title,abstract,year,venue,publicationDate,authors,externalIds,openAccessPdf") + "&limit=100"
	raw, _, err := fetchPublic(ctx, endpoint, 8<<20)
	if err != nil {
		writeError(w, 502, "每日论文推荐暂时不可用："+err.Error())
		return
	}
	var response struct {
		Data []struct {
			PaperID         string `json:"paperId"`
			Title           string `json:"title"`
			Abstract        string `json:"abstract"`
			Venue           string `json:"venue"`
			Year            int    `json:"year"`
			PublicationDate string `json:"publicationDate"`
			Authors         []struct {
				Name string `json:"name"`
			} `json:"authors"`
			ExternalIDs struct {
				DOI string `json:"DOI"`
			} `json:"externalIds"`
			OpenAccessPDF struct {
				URL string `json:"url"`
			} `json:"openAccessPdf"`
		} `json:"data"`
	}
	if err = json.Unmarshal(raw, &response); err != nil {
		writeError(w, 502, "每日论文推荐返回了无法识别的数据")
		return
	}
	papers := make([]dailyPaper, 0, 20)
	seen := map[string]bool{}
	for _, item := range response.Data {
		if strings.TrimSpace(item.Title) == "" {
			continue
		}
		label, tier, ok := dailyVenue(item.Venue)
		if !ok {
			continue
		}
		id := strings.TrimSpace(item.PaperID)
		if id == "" {
			id = strings.ToLower(strings.TrimSpace(item.ExternalIDs.DOI))
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		authors := make([]string, 0, len(item.Authors))
		for _, author := range item.Authors {
			if name := strings.TrimSpace(author.Name); name != "" {
				authors = append(authors, name)
			}
		}
		papers = append(papers, dailyPaper{
			ID: id, Title: strings.TrimSpace(item.Title), Authors: authors, Venue: label,
			VenueTier: tier, Year: item.Year, Published: item.PublicationDate,
			DOI: strings.TrimSpace(item.ExternalIDs.DOI),
			URL: func() string {
				if item.ExternalIDs.DOI != "" {
					return "https://doi.org/" + strings.TrimPrefix(item.ExternalIDs.DOI, "https://doi.org/")
				}
				return ""
			}(),
			PDFURL: strings.TrimSpace(item.OpenAccessPDF.URL), Abstract: strings.TrimSpace(item.Abstract),
		})
	}
	sort.SliceStable(papers, func(i, j int) bool {
		if papers[i].VenueTier != papers[j].VenueTier {
			return papers[i].VenueTier < papers[j].VenueTier
		}
		if papers[i].Year != papers[j].Year {
			return papers[i].Year > papers[j].Year
		}
		return strings.ToLower(papers[i].Title) < strings.ToLower(papers[j].Title)
	})
	if len(papers) > 50 {
		papers = papers[:50]
	}
	writeJSON(w, 200, map[string]any{"papers": papers, "fetchedAt": time.Now().Format(time.RFC3339)})
}
