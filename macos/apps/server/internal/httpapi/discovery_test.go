package httpapi

import "testing"

func TestDailyVenueAcceptsAnyNamedSource(t *testing.T) {
	cases := []struct {
		venue string
		label string
		ok    bool
	}{
		{"Medical Image Computing and Computer Assisted Intervention (MICCAI)", "Medical Image Computing and Computer Assisted Intervention (MICCAI)", true},
		{"ACL", "ACL", true},
		{"arXiv (Cornell University)", "arXiv (Cornell University)", true},
		{"", "", false},
	}
	for _, tc := range cases {
		label, _, ok := dailyVenue(tc.venue)
		if label != tc.label || ok != tc.ok {
			t.Errorf("dailyVenue(%q) = (%q, %v), want (%q, %v)", tc.venue, label, ok, tc.label, tc.ok)
		}
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

func TestDailyPaperFromWorkUsesCrossrefVenueForLNCS(t *testing.T) {
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
	paper, ok := dailyPaperFromWork(work, nil)
	if !ok || paper.Venue != "Lecture notes in computer science" {
		t.Fatalf("缺少 Crossref 时也应收录通用来源，paper=%+v ok=%v", paper, ok)
	}
	paper, ok = dailyPaperFromWork(work, []string{"Lecture Notes in Computer Science", "Medical Image Computing and Computer Assisted Intervention – MICCAI 2026"})
	if !ok {
		t.Fatalf("LNCS 论文应能靠 container-title 展示具体会议")
	}
	if paper.Venue != "Medical Image Computing and Computer Assisted Intervention – MICCAI 2026" {
		t.Errorf("venue = %q, want Crossref container-title", paper.Venue)
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
	if paper.Venue != "IEEE Transactions on Medical Imaging" {
		t.Errorf("venue = %q, want generic source name", paper.Venue)
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

func TestDailyPaperFromWorkAllowsUnlistedVenues(t *testing.T) {
	work := openAlexWork{
		ID:    "https://openalex.org/W3",
		Title: "Some preprint",
		Primary: &openAlexLocation{Source: &openAlexSource{
			ID:   "https://openalex.org/S4306400194",
			Name: "arXiv (Cornell University)",
		}},
	}
	if paper, ok := dailyPaperFromWork(work, []string{"arXiv (Cornell University)"}); !ok || paper.Venue != "arXiv (Cornell University)" {
		t.Fatalf("用户可在规则中自行筛选任意来源，paper=%+v ok=%v", paper, ok)
	}
}
