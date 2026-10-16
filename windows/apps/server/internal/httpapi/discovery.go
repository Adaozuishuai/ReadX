package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
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

// 每日推荐的数据源是 OpenAlex。Semantic Scholar 的匿名配额在 AWS 网关层长期返回
// 429（重试无用，官方要求申请 Key），因此换成免密钥、限流宽松的 OpenAlex，
// 检索结果再交给上面的 venue 规则筛选。
//
// 期刊与 IEEE 会议在 OpenAlex 里各有独立 source；Springer 的 MICCAI/ECCV 论文
// 统一挂在下述 LNCS source 下，source 名不含会议名，需要按 DOI 到 Crossref 的
// container-title 还原（如 "Medical Image Computing and Computer Assisted
// Intervention – MICCAI 2026"）。LNCS 命中会额外做一批受限的 Crossref 查询。
const (
	dailyLNCSourceID   = "S106296714"
	dailyTopicQuery    = `"cone beam" OR "CBCT" OR "cone-beam CT" OR "sparse-view CT" OR "sparse view CT"`
	dailyRecentMonths  = 24
	dailyWidestMonths  = 60
	dailyMaxPapers     = 50
	dailyEnrichLimit   = 24
	dailyEnrichWorkers = 4
)

// dailyVenueSources 把 dailyVenueRules 里的 venue 映射到 OpenAlex source ID
// （2026-10 通过 /sources 精确匹配名称解析，source 是长期稳定的实体）。
var dailyVenueSources = []struct {
	label string
	id    string
}{
	{"IEEE Transactions on Medical Imaging", "S58069681"},
	{"Medical Image Analysis", "S116571295"},
	{"IEEE/CVF Conference on Computer Vision and Pattern Recognition", "S4210176548"},
	{"IEEE/CVF International Conference on Computer Vision", "S4363607764"},
	{"Proceedings of the AAAI Conference on Artificial Intelligence", "S4210191458"},
	{"International Conference on Learning Representations", "S4306419637"},
	{"Neural Information Processing Systems", "S4363606243"},
	{"IEEE International Symposium on Biomedical Imaging", "S4363605129"},
	{"SPIE Medical Imaging: Physics of Medical Imaging", "S4363606018"},
	{"Lecture notes in computer science", dailyLNCSourceID},
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
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	papers, err := fetchDailyPapers(ctx)
	if err != nil {
		writeError(w, 502, "每日论文推荐暂时不可用："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"papers": papers, "fetchedAt": time.Now().Format(time.RFC3339)})
}

// fetchDailyPapers 先按近两年检索；一条都筛不出来时把窗口放宽到五年再试一次。
func fetchDailyPapers(ctx context.Context) ([]dailyPaper, error) {
	for _, months := range []int{dailyRecentMonths, dailyWidestMonths} {
		works, err := fetchOpenAlexDaily(ctx, months)
		if err != nil {
			return nil, err
		}
		papers := buildDailyPapers(ctx, works)
		if len(papers) > 0 {
			return papers, nil
		}
	}
	return []dailyPaper{}, nil
}

func fetchOpenAlexDaily(ctx context.Context, months int) ([]openAlexWork, error) {
	ids := make([]string, 0, len(dailyVenueSources))
	for _, source := range dailyVenueSources {
		ids = append(ids, source.id)
	}
	filters := strings.Join([]string{
		"primary_location.source.id:" + strings.Join(ids, "|"),
		"title_and_abstract.search:" + dailyTopicQuery,
		"from_publication_date:" + time.Now().AddDate(0, -months, 0).Format("2006-01-02"),
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

func buildDailyPapers(ctx context.Context, works []openAlexWork) []dailyPaper {
	containers := resolveLNCSContainers(ctx, works)
	papers := make([]dailyPaper, 0, 20)
	seen := map[string]bool{}
	for _, work := range works {
		paper, ok := dailyPaperFromWork(work, containers[work.doi()])
		if !ok || seen[paper.ID] {
			continue
		}
		seen[paper.ID] = true
		papers = append(papers, paper)
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
	if len(papers) > dailyMaxPapers {
		papers = papers[:dailyMaxPapers]
	}
	return papers
}

// dailyPaperFromWork 把一条 OpenAlex work 转成推荐卡片。venue 先按 OpenAlex 的
// source 名匹配规则；LNCS 这类只有刊名没有会议名的，再用 Crossref 的
// container-title 补一次。
func dailyPaperFromWork(work openAlexWork, containers []string) (dailyPaper, bool) {
	title := strings.TrimSpace(work.Title)
	if title == "" {
		return dailyPaper{}, false
	}
	label, tier, ok := dailyVenue(work.venueName())
	if !ok {
		for _, container := range containers {
			if label, tier, ok = dailyVenue(container); ok {
				break
			}
		}
	}
	if !ok {
		return dailyPaper{}, false
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
		ID: id, Title: title, Authors: authors, Venue: label, VenueTier: tier,
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
