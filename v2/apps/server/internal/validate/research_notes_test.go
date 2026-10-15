package validate

import (
	"strings"
	"testing"
)

func TestResearchNotesRequireRealPageAndVerbatimEvidence(t *testing.T) {
	source := "=== Page 1 ===\nContinuous density fields enforce projection consistency."
	valid := `{"sections":[{"title":"表示方法","fields":[{"k":"表示","v":"连续密度场","page":1,"excerpt":"Continuous density fields enforce projection consistency."}]}]}`
	for _, kind := range []string{"motivation", "method"} {
		if err := ValidateGenerated(kind, valid, source); err != nil {
			t.Fatal(err)
		}
		if err := ValidateGenerated(kind, strings.Replace(valid, `"page":1`, `"page":8`, 1), source); err == nil {
			t.Fatal("accepted missing page")
		}
		if err := ValidateGenerated(kind, strings.Replace(valid, "Continuous density fields enforce projection consistency.", "Fabricated evidence without source.", 1), source); err == nil {
			t.Fatal("accepted fabricated quote")
		}
		if err := ValidateGenerated(kind, `{"sections":[]}`, source); err == nil {
			t.Fatal("accepted empty notes")
		}
	}
}
