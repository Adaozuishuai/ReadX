package translate

import "testing"

func TestBuildNumericQAEquivalentScientificAndScaledNumbers(t *testing.T) {
	items := []Item{
		{ItemID: "p1-b1", PageIndex: 0, Source: "The result is 2.5 × 10^3."},
		{ItemID: "p1-b2", PageIndex: 0, Source: "The model has 1.2M parameters."},
		{ItemID: "p1-b3", PageIndex: 0, Source: "A total of 12,000 samples."},
	}
	report := BuildNumericQA(items, []string{"结果为 2500。", "模型有 120 万个参数。", "共 12000 个样本。"})
	if report.Schema != numericQASchema || report.ItemCount != 3 || report.ViolationCount != 0 {
		t.Fatalf("equivalent numeric forms should pass: %+v", report)
	}
}

func TestBuildNumericQAReportsMissingNumberAcrossContinuationUnit(t *testing.T) {
	items := []Item{
		{ItemID: "p1-b1", PageIndex: 0, Source: "The baseline reaches 84.7 percent", ContinuationGroup: "continuation-1"},
		{ItemID: "p2-b1", PageIndex: 1, Source: "on the held-out set.", ContinuationGroup: "continuation-1"},
	}
	report := BuildNumericQA(items, []string{"基线在测试集上达到 80%", "。"})
	if report.CheckedUnitCount != 1 || report.ViolationCount == 0 {
		t.Fatalf("continuation members should be checked together and report a mismatch: %+v", report)
	}
	if got := report.Violations[0].UnitID; got != "continuation-1" {
		t.Fatalf("issue should point to the continuation unit, got %q", got)
	}
}
