package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type dailyPaper struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Authors   []string `json:"authors"`
	Venue     string   `json:"venue"`
	Year      int      `json:"year"`
	Published string   `json:"published"`
	DOI       string   `json:"doi"`
	URL       string   `json:"url"`
	PDFURL    string   `json:"pdfUrl"`
	Abstract  string   `json:"abstract"`
}

func dailyVenue(raw string) (string, int, bool) {
	venue := strings.TrimSpace(raw)
	if venue == "" {
		return "", 0, false
	}
	return venue, 0, true
}

// 每日推荐使用 OpenAlex 的公开 works 索引；领域、检索词、排除词和时间范围由用户配置。
// LNCS 的 OpenAlex source 不含具体会议名，仍按 DOI 从 Crossref 补充 container-title。
const (
	dailyLNCSourceID   = "S106296714"
	dailyMaxPapers     = 50
	dailyEnrichLimit   = 24
	dailyEnrichWorkers = 4
)

type dailyRecommendationRules struct {
	Field    string
	Keywords []string
	Exclude  []string
	Venues   []string
	Years    int
}

type openAlexSource struct {
	ID   string `json:"id"`
	Name string `json:"display_name"`
}

type openAlexLocation struct {
	Source      *openAlexSource `json:"source"`
	LandingPage string          `json:"landing_page_url"`
}

type openAlexPDFLocation struct {
	PDF string `json:"pdf_url"`
}

type openAlexOpenAccess struct {
	URL string `json:"oa_url"`
}

type openAlexAuthorship struct {
	Author struct {
		Name string `json:"display_name"`
	} `json:"author"`
}

type openAlexWork struct {
	ID            string               `json:"id"`
	DOI           string               `json:"doi"`
	Title         string               `json:"title"`
	Year          int                  `json:"publication_year"`
	Date          string               `json:"publication_date"`
	Primary       *openAlexLocation    `json:"primary_location"`
	Best          *openAlexPDFLocation `json:"best_oa_location"`
	OpenAccess    openAlexOpenAccess   `json:"open_access"`
	Authorships   []openAlexAuthorship `json:"authorships"`
	AbstractIndex map[string][]int     `json:"abstract_inverted_index"`
}

func (w openAlexWork) sourceID() string {
	if w.Primary == nil || w.Primary.Source == nil {
		return ""
	}
	return strings.TrimPrefix(w.Primary.Source.ID, "https://openalex.org/")
}

func (w openAlexWork) venueName() string {
	if w.Primary == nil || w.Primary.Source == nil {
		return ""
	}
	return w.Primary.Source.Name
}

// doi 归一化成裸 DOI（如 10.1007/978-3-032-38179-8_16），Crossref 与界面都按这个形式使用。
func (w openAlexWork) doi() string {
	value := strings.TrimSpace(w.DOI)
	value = strings.TrimPrefix(value, "https://doi.org/")
	value = strings.TrimPrefix(value, "http://dx.doi.org/")
	return strings.TrimPrefix(value, "doi:")
}

func (w openAlexWork) shortID() string {
	return strings.TrimPrefix(w.ID, "https://openalex.org/")
}

func (s *Server) handleDailyRecommendations(w http.ResponseWriter, r *http.Request) {
	rules, err := parseDailyRecommendationRules(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	papers, err := fetchDailyPapers(ctx, rules)
	if err != nil {
		writeError(w, 502, "每日论文推荐暂时不可用："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"papers": papers, "fetchedAt": time.Now().Format(time.RFC3339)})
}

func parseDailyRecommendationRules(r *http.Request) (dailyRecommendationRules, error) {
	values := r.URL.Query()
	rules := dailyRecommendationRules{
		Field:    strings.TrimSpace(values.Get("field")),
		Keywords: splitDailyRuleValues(values.Get("keywords")),
		Exclude:  splitDailyRuleValues(values.Get("exclude")),
		Venues:   splitDailyRuleValues(values.Get("venues")),
		Years:    2,
	}
	if raw := strings.TrimSpace(values.Get("years")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			rules.Years = parsed
		} else {
			return rules, fmt.Errorf("时间范围必须是 1、2、3 或 5 年")
		}
	}
	if rules.Years != 1 && rules.Years != 2 && rules.Years != 3 && rules.Years != 5 {
		return rules, fmt.Errorf("时间范围必须是 1、2、3 或 5 年")
	}
	if rules.Field != "" {
		rules.Keywords = append([]string{rules.Field}, rules.Keywords...)
	}
	rules.Keywords = cleanDailyRuleValues(rules.Keywords, 12)
	rules.Exclude = cleanDailyRuleValues(rules.Exclude, 20)
	rules.Venues = cleanDailyRuleValues(rules.Venues, 12)
	if len(rules.Keywords) == 0 {
		return rules, fmt.Errorf("请先设置研究领域或至少一个检索词")
	}
	return rules, nil
}

func splitDailyRuleValues(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool { return r == '\n' || r == '\r' || r == ';' })
}

func cleanDailyRuleValues(values []string, limit int) []string {
	cleaned := make([]string, 0, limit)
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || len([]rune(value)) > 100 {
			continue
		}
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		cleaned = append(cleaned, value)
		if len(cleaned) == limit {
			break
		}
	}
	return cleaned
}

func fetchDailyPapers(ctx context.Context, rules dailyRecommendationRules) ([]dailyPaper, error) {
	works, err := fetchOpenAlexDaily(ctx, rules)
	if err != nil {
		return nil, err
	}
	return buildDailyPapers(ctx, works, rules), nil
}

func fetchOpenAlexDaily(ctx context.Context, rules dailyRecommendationRules) ([]openAlexWork, error) {
	terms := make([]string, len(rules.Keywords))
	for index, term := range rules.Keywords {
		term = strings.ReplaceAll(term, `\`, `\\`)
		term = strings.ReplaceAll(term, `"`, `\"`)
		terms[index] = `"` + term + `"`
	}
	filters := strings.Join([]string{
		"title_and_abstract.search:" + strings.Join(terms, " OR "),
		"from_publication_date:" + time.Now().AddDate(-rules.Years, 0, 0).Format("2006-01-02"),
	}, ",")
	fields := "id,doi,title,publication_year,publication_date,primary_location,best_oa_location,open_access,authorships,abstract_inverted_index"
	endpoint := "https://api.openalex.org/works?per-page=200&sort=publication_date:desc" +
		"&select=" + url.QueryEscape(fields) + "&filter=" + url.QueryEscape(filters)
	raw, _, err := fetchPublic(ctx, endpoint, 8<<20)
	if err != nil {
		return nil, fmt.Errorf("OpenAlex 检索失败：%w", err)
	}
	var response struct {
		Results []openAlexWork `json:"results"`
	}
	if err = json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("OpenAlex 返回了无法识别的数据：%w", err)
	}
	return response.Results, nil
}

func buildDailyPapers(ctx context.Context, works []openAlexWork, rules dailyRecommendationRules) []dailyPaper {
	containers := resolveLNCSContainers(ctx, works)
	papers := make([]dailyPaper, 0, 20)
	seen := map[string]bool{}
	for _, work := range works {
		containerTitles := containers[work.doi()]
		paper, ok := dailyPaperFromWork(work, containerTitles)
		if !ok || !matchesDailyRecommendationRules(paper, containerTitles, rules) || seen[paper.ID] {
			continue
		}
		seen[paper.ID] = true
		papers = append(papers, paper)
	}
	sort.SliceStable(papers, func(i, j int) bool {
		if papers[i].Published != papers[j].Published {
			return papers[i].Published > papers[j].Published
		}
		return strings.ToLower(papers[i].Title) < strings.ToLower(papers[j].Title)
	})
	if len(papers) > dailyMaxPapers {
		papers = papers[:dailyMaxPapers]
	}
	return papers
}

func matchesDailyRecommendationRules(paper dailyPaper, containers []string, rules dailyRecommendationRules) bool {
	searchable := strings.ToLower(strings.Join([]string{paper.Title, paper.Abstract}, " "))
	for _, term := range rules.Exclude {
		if strings.Contains(searchable, strings.ToLower(term)) {
			return false
		}
	}
	if len(rules.Venues) == 0 {
		return true
	}
	venueText := strings.ToLower(strings.Join(append([]string{paper.Venue}, containers...), " "))
	for _, venue := range rules.Venues {
		if strings.Contains(venueText, strings.ToLower(venue)) {
			return true
		}
	}
	return false
}

// dailyPaperFromWork 把一条 OpenAlex work 转成推荐卡片；用户可以自行配置可选 venue 规则。
func dailyPaperFromWork(work openAlexWork, containers []string) (dailyPaper, bool) {
	title := strings.TrimSpace(work.Title)
	if title == "" {
		return dailyPaper{}, false
	}
	venue, _, _ := dailyVenue(work.venueName())
	if venue == "" || strings.EqualFold(venue, "Lecture notes in computer science") {
		for _, container := range containers {
			if strings.TrimSpace(container) != "" && !strings.EqualFold(strings.TrimSpace(container), "Lecture notes in computer science") {
				venue, _, _ = dailyVenue(container)
				break
			}
		}
	}
	doi := work.doi()
	authors := make([]string, 0, len(work.Authorships))
	for _, authorship := range work.Authorships {
		if name := strings.TrimSpace(authorship.Author.Name); name != "" {
			authors = append(authors, name)
		}
	}
	pdf := ""
	if work.Best != nil {
		pdf = strings.TrimSpace(work.Best.PDF)
	}
	if pdf == "" {
		pdf = strings.TrimSpace(work.OpenAccess.URL)
	}
	link := ""
	if doi != "" {
		link = "https://doi.org/" + doi
	} else if work.Primary != nil {
		link = strings.TrimSpace(work.Primary.LandingPage)
	}
	id := doi
	if id == "" {
		id = work.shortID()
	}
	if id == "" {
		return dailyPaper{}, false
	}
	return dailyPaper{
		ID: id, Title: title, Authors: authors, Venue: venue,
		Year: work.Year, Published: strings.TrimSpace(work.Date), DOI: doi,
		URL: link, PDFURL: pdf, Abstract: openAlexAbstract(work.AbstractIndex),
	}, true
}

// openAlexAbstract 把 abstract_inverted_index（词 → 位置列表）还原成句子。
func openAlexAbstract(index map[string][]int) string {
	if len(index) == 0 {
		return ""
	}
	type token struct {
		position int
		word     string
	}
	tokens := make([]token, 0, len(index))
	for word, positions := range index {
		for _, position := range positions {
			tokens = append(tokens, token{position: position, word: word})
		}
	}
	sort.Slice(tokens, func(i, j int) bool { return tokens[i].position < tokens[j].position })
	words := make([]string, 0, len(tokens))
	for _, item := range tokens {
		words = append(words, item.word)
	}
	return strings.Join(words, " ")
}

// resolveLNCSContainers 只对 LNCS 下的论文查 Crossref（有上限、4 路并发），
// 返回 DOI → container-title 列表。查询失败或超时的条目会在筛选中被丢弃。
func resolveLNCSContainers(ctx context.Context, works []openAlexWork) map[string][]string {
	targets := make([]openAlexWork, 0, len(works))
	for _, work := range works {
		if work.sourceID() == dailyLNCSourceID && work.doi() != "" {
			targets = append(targets, work)
		}
	}
	if len(targets) > dailyEnrichLimit {
		targets = targets[:dailyEnrichLimit]
	}
	if len(targets) == 0 {
		return nil
	}
	out := make(map[string][]string, len(targets))
	var mu sync.Mutex
	var group sync.WaitGroup
	semaphore := make(chan struct{}, dailyEnrichWorkers)
	for _, work := range targets {
		group.Add(1)
		go func(doi string) {
			defer group.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			titles, err := crossrefContainerTitles(ctx, doi)
			if err != nil || len(titles) == 0 {
				return
			}
			mu.Lock()
			out[doi] = titles
			mu.Unlock()
		}(work.doi())
	}
	group.Wait()
	return out
}

func crossrefContainerTitles(ctx context.Context, doi string) ([]string, error) {
	endpoint := "https://api.crossref.org/works/" + url.PathEscape(doi)
	raw, _, err := fetchPublic(ctx, endpoint, 1<<20)
	if err != nil {
		return nil, err
	}
	var response struct {
		Message struct {
			Container []string `json:"container-title"`
		} `json:"message"`
	}
	if err = json.Unmarshal(raw, &response); err != nil {
		return nil, err
	}
	return response.Message.Container, nil
}
