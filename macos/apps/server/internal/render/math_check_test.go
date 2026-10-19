package render

import "testing"

func TestMathFormulaMapExtractsInlineAndDisplay(t *testing.T) {
	formulas := mathFormulaMap(`inline $x_1$ display $$\frac{a}{b}$$ escaped \\$literal$`)
	if len(formulas) != 2 {
		t.Fatalf("want two formulas, got %#v", formulas)
	}
	if _, ok := formulas[mathCheckKey{tex: "x_1"}]; !ok {
		t.Fatalf("inline formula missing: %#v", formulas)
	}
	if _, ok := formulas[mathCheckKey{tex: `\frac{a}{b}`, display: true}]; !ok {
		t.Fatalf("display formula missing: %#v", formulas)
	}
}
