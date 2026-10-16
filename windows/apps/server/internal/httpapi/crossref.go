package httpapi

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"time"
)

func lookupPapers(ctx context.Context, q string) ([]paperCandidate, error) {
	probe, cancel := context.WithTimeout(ctx, 15*time.Second)
	items, err := lookupOpenAlex(probe, q)
	cancel()
	if err == nil && len(items) > 0 {
		doi := normalizePublicationDOI(q)
		if strings.HasPrefix(strings.ToLower(doi), "10.") {
			crossrefCtx, stop := context.WithTimeout(ctx, 4*time.Second)
			defer stop()
			endpoint := "https://api.crossref.org/works/" + url.PathEscape(doi)
			if raw, _, fetchErr := fetchPublic(crossrefCtx, endpoint, 4<<20); fetchErr == nil {
				if supplemental, parseErr := crossrefCandidates(raw, true); parseErr == nil && len(supplemental) > 0 {
					for i := range items {
						if items[i].Venue == "" {
							items[i].Venue = supplemental[0].Venue
						}
						if items[i].Year == 0 {
							items[i].Year = supplemental[0].Year
						}
						if len(items[i].Authors) == 0 {
							items[i].Authors = supplemental[0].Authors
						}
					}
				}
			}
		}
		return items, nil
	}
	doi := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimPrefix(q, "https://doi.org/"), "http://doi.org/"), "doi:"))
	single := strings.HasPrefix(doi, "10.")
	endpoint := "https://api.crossref.org/works?rows=8&query.title=" + url.QueryEscape(q)
	if single {
		endpoint = "https://api.crossref.org/works/" + url.PathEscape(doi)
	}
	raw, _, err := fetchPublic(ctx, endpoint, 4<<20)
	if err != nil {
		return nil, err
	}
	return crossrefCandidates(raw, single)
}
func crossrefCandidates(raw []byte, single bool) ([]paperCandidate, error) {
	type work struct {
		Title []string `json:"title"`
		DOI   string   `json:"DOI"`
		Venue []string `json:"container-title"`
		Date  struct {
			DateParts [][]int `json:"date-parts"`
		} `json:"published-print"`
		OnlineDate struct {
			DateParts [][]int `json:"date-parts"`
		} `json:"published-online"`
		Issued struct {
			DateParts [][]int `json:"date-parts"`
		} `json:"issued"`
		Author []struct {
			Given  string `json:"given"`
			Family string `json:"family"`
		} `json:"author"`
		Links []struct {
			URL  string `json:"URL"`
			Type string `json:"content-type"`
		} `json:"link"`
	}
	var envelope struct {
		Message json.RawMessage `json:"message"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	works := []work{}
	if single {
		var item work
		if err := json.Unmarshal(envelope.Message, &item); err != nil {
			return nil, err
		}
		works = append(works, item)
	} else {
		var message struct {
			Items []work `json:"items"`
		}
		if err := json.Unmarshal(envelope.Message, &message); err != nil {
			return nil, err
		}
		works = message.Items
	}
	out := []paperCandidate{}
	for _, item := range works {
		if len(item.Title) == 0 {
			continue
		}
		authors := []string{}
		for _, a := range item.Author {
			authors = append(authors, strings.TrimSpace(a.Given+" "+a.Family))
		}
		link := ""
		for _, l := range item.Links {
			if l.Type == "application/pdf" {
				link = l.URL
				break
			}
		}
		year := crossrefYear(item.Date.DateParts)
		if year == 0 {
			year = crossrefYear(item.OnlineDate.DateParts)
		}
		if year == 0 {
			year = crossrefYear(item.Issued.DateParts)
		}
		venue := ""
		if len(item.Venue) > 0 {
			venue = item.Venue[0]
		}
		out = append(out, paperCandidate{Title: item.Title[0], DOI: item.DOI, Authors: authors, URL: link, Venue: venue, Year: year})
	}
	return out, nil
}

func crossrefYear(parts [][]int) int {
	if len(parts) == 0 || len(parts[0]) == 0 {
		return 0
	}
	return parts[0][0]
}
