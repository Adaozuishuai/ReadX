package httpapi

import "testing"

func TestDailyVenuePrioritizesTargetJournalsAndConferences(t *testing.T) {
	cases := []struct {
		venue string
		label string
		tier  int
		ok    bool
	}{
		{"Medical Image Computing and Computer Assisted Intervention (MICCAI)", "MICCAI", 0, true},
		{"IEEE Transactions on Medical Imaging", "TMI", 0, true},
		{"Medical Image Analysis", "Medical Image Analysis", 0, true},
		{"IEEE International Symposium on Biomedical Imaging", "ISBI", 1, true},
		{"CVPR Workshops", "", 0, false},
		{"arXiv preprint", "", 0, false},
	}
	for _, tc := range cases {
		label, tier, ok := dailyVenue(tc.venue)
		if label != tc.label || tier != tc.tier || ok != tc.ok {
			t.Errorf("dailyVenue(%q) = (%q, %d, %v), want (%q, %d, %v)", tc.venue, label, tier, ok, tc.label, tc.tier, tc.ok)
		}
	}
}

// 每个 OpenAlex source 的名称都必须能被 dailyVenue 认出来（LNCS 例外：它的会议名
// 只能从 Crossref 的 container-title 补），否则筛选会静默丢掉整个 venue。
func TestDailyVenueSourcesMatchVenueRules(t *testing.T) {
	seen := map[string]bool{}
	lncs := 0
	for _, source := range dailyVenueSources {
		if seen[source.id] {
			t.Errorf("source %s 重复出现", source.id)
		}
		seen[source.id] = true
		if source.id == dailyLNCSourceID {
			lncs++
			continue
		}
		if _, _, ok := dailyVenue(source.label); !ok {
			t.Errorf("source 名称 %q 无法匹配任何 venue 规则", source.label)
		}
	}
	if lncs != 1 {
		t.Errorf("LNCS source 出现 %d 次，want 1", lncs)
	}
}

func TestOpenAlexAbstractRestoresWordOrder(t *testing.T) {
	index := map[string][]int{
		"Sparse": {1},
		"view":   {2},
		"CBCT":   {3},
		"uses":   {4},
		"a":      {0},
	}
	if got, want := openAlexAbstract(index), "a Sparse view CBCT uses"; got != want {
		t.Errorf("openAlexAbstract() = %q, want %q", got, want)
	}
	if got := openAlexAbstract(nil); got != "" {
		t.Errorf("openAlexAbstract(nil) = %q, want 空字符串", got)
	}
}

func TestDailyPaperFromWorkNeedsCrossrefForLNCS(t *testing.T) {
	work := openAlexWork{
		ID:    "https://openalex.org/W1",
		DOI:   "https://doi.org/10.1007/978-3-032-38179-8_16",
		Title: "Sparse-view CBCT reconstruction",
		Year:  2026,
		Primary: &openAlexLocation{Source: &openAlexSource{
			ID:   "https://openalex.org/" + dailyLNCSourceID,
			Name: "Lecture notes in computer science",
		}},
	}
	if _, ok := dailyPaperFromWork(work, nil); ok {
		t.Fatalf("LNCS 论文在缺少 Crossref container-title 时不应被收录")
	}
	paper, ok := dailyPaperFromWork(work, []string{"Lecture Notes in Computer Science", "Medical Image Computing and Computer Assisted Intervention – MICCAI 2026"})
	if !ok {
		t.Fatalf("LNCS 论文应能靠 container-title 匹配到 MICCAI")
	}
	if paper.Venue != "MICCAI" || paper.VenueTier != 0 {
		t.Errorf("venue = (%q, %d), want (MICCAI, 0)", paper.Venue, paper.VenueTier)
	}
	if paper.ID != "10.1007/978-3-032-38179-8_16" || paper.URL != "https://doi.org/10.1007/978-3-032-38179-8_16" {
		t.Errorf("id/url 未归一化：id=%q url=%q", paper.ID, paper.URL)
	}
}

func TestDailyPaperFromWorkKeepsJournalVenueAndAbstract(t *testing.T) {
	work := openAlexWork{
		ID:    "https://openalex.org/W2",
		DOI:   "https://doi.org/10.1109/TMI.2026.1234567",
		Title: "Cone-beam CT reconstruction",
		Year:  2026,
		Date:  "2026-03-01",
		Primary: &openAlexLocation{Source: &openAlexSource{
			ID:   "https://openalex.org/S58069681",
			Name: "IEEE Transactions on Medical Imaging",
		}},
		Best:          &openAlexPDFLocation{PDF: "https://example.org/paper.pdf"},
		AbstractIndex: map[string][]int{"CBCT": {0}, "works": {1}},
	}
	work.Authorships = []openAlexAuthorship{{}, {}}
	work.Authorships[0].Author.Name = "Ada Lovelace"
	work.Authorships[1].Author.Name = "  "

	paper, ok := dailyPaperFromWork(work, nil)
	if !ok {
		t.Fatalf("TMI 论文应被收录")
	}
	if paper.Venue != "TMI" || paper.VenueTier != 0 {
		t.Errorf("venue = (%q, %d), want (TMI, 0)", paper.Venue, paper.VenueTier)
	}
	if len(paper.Authors) != 1 || paper.Authors[0] != "Ada Lovelace" {
		t.Errorf("authors = %v, want [Ada Lovelace]", paper.Authors)
	}
	if paper.Abstract != "CBCT works" {
		t.Errorf("abstract = %q, want %q", paper.Abstract, "CBCT works")
	}
	if paper.PDFURL != "https://example.org/paper.pdf" || paper.Published != "2026-03-01" {
		t.Errorf("pdf/published = %q/%q", paper.PDFURL, paper.Published)
	}
}

func TestDailyPaperFromWorkDropsUnlistedVenues(t *testing.T) {
	work := openAlexWork{
		ID:    "https://openalex.org/W3",
		Title: "Some preprint",
		Primary: &openAlexLocation{Source: &openAlexSource{
			ID:   "https://openalex.org/S4306400194",
			Name: "arXiv (Cornell University)",
		}},
	}
	if _, ok := dailyPaperFromWork(work, []string{"arXiv (Cornell University)"}); ok {
		t.Fatalf("非目标 venue 不应被收录")
	}
}
