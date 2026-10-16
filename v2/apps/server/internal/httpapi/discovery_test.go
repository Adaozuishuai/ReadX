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
