package latex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSnapshotRoundTripRestoresEverything(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "快照", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	original, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := service.CreateSnapshot(ctx, project.ID, "测试快照")
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.FileCount < 3 || snapshot.ByteCount == 0 || snapshot.Manifest == "" {
		t.Fatalf("快照元数据不完整: %+v", snapshot)
	}

	// 快照之后：改内容、删文件、加新文件。
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte("改坏了"), original.Revision); err != nil {
		t.Fatal(err)
	}
	if err := service.DeletePath(ctx, project.ID, "sections/method.tex"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "sections/new.tex", []byte("新增"), ""); err != nil {
		t.Fatal(err)
	}

	report, err := service.RestoreSnapshot(ctx, snapshot.ID)
	if err != nil {
		t.Fatal(err)
	}
	if report.Restored < 3 {
		t.Fatalf("回滚应当写回快照里的全部文件，实际 %d", report.Restored)
	}
	// 恢复内容与删除的文件。
	restored, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil || restored.Content != original.Content {
		t.Fatalf("回滚后 main.tex 内容不对: %v", err)
	}
	if _, err := service.ReadFile(ctx, project.ID, "sections/method.tex"); err != nil {
		t.Fatalf("被删掉的文件应当恢复: %v", err)
	}
	// 新增的文件必须被移除，并且如实报告。
	if _, err := service.ReadFile(ctx, project.ID, "sections/new.tex"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("快照之后新增的文件应当被移除: %v", err)
	}
	if len(report.RemovedFiles) == 0 {
		t.Fatal("被移除的文件必须列在报告里，不能静默删除")
	}
}

func TestSnapshotRejectsUnsafeIDsAndKeepsHistory(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "快照2", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"../x", "a/b", `a\b`, ""} {
		if _, err := service.SnapshotDir(project.ID, id); err == nil {
			t.Fatalf("非法快照编号 %q 必须被拒绝", id)
		}
	}
	first, err := service.CreateSnapshot(ctx, project.ID, "第一次")
	if err != nil {
		t.Fatal(err)
	}
	list, err := service.ListSnapshots(ctx, project.ID, 0)
	if err != nil || len(list) != 1 || list[0].ID != first.ID {
		t.Fatalf("快照列表不对: %v %+v", err, list)
	}
	if err := service.DeleteSnapshot(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Snapshot(ctx, first.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删除后应当查不到: %v", err)
	}
	if dir, dirErr := service.SnapshotDir(project.ID, first.ID); dirErr == nil {
		if _, statErr := os.Stat(dir); !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("快照目录应当被清掉: %v", statErr)
		}
	}
}

func TestSnapshotPrunesOldOnes(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "快照3", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < keptSnapshots+3; index++ {
		// 时间戳是秒级的，插入时手动错开一点，保证排序稳定。
		if _, err := service.CreateSnapshot(ctx, project.ID, "批量"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond)
	}
	list, err := service.ListSnapshots(ctx, project.ID, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) > keptSnapshots {
		t.Fatalf("快照数量应当被裁剪到 %d，实际 %d", keptSnapshots, len(list))
	}
}

// 直接写盘的第一道闸：没开开关就绝不能写。
func TestApplyAndVerifyRefusesWhenDisabled(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "未开启", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	before, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.ApplyAndVerify(ctx, project.ID, "main.tex", "被改掉了", "测试", AutoFixOptions{})
	if !errors.Is(err, ErrAIAutoFixDisabled) {
		t.Fatalf("未开启时必须拒绝，实际 %v", err)
	}
	after, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil || after.Content != before.Content {
		t.Fatalf("被拒绝的写入不能改动磁盘: %v", err)
	}
}

func TestApplyAndVerifyValidatesInputs(t *testing.T) {
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "开启", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{AIAutoFix: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ApplyAndVerify(ctx, project.ID, "references.bib", "@article{x}", "", AutoFixOptions{}); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("非 .tex 文件必须拒绝，实际 %v", err)
	}
	if _, err := service.ApplyAndVerify(ctx, project.ID, "../escape.tex", "x", "", AutoFixOptions{}); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("逃逸路径必须拒绝，实际 %v", err)
	}
	if _, err := service.ApplyAndVerify(ctx, project.ID, "nope.tex", "x", "", AutoFixOptions{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的文件应当报 ErrNotFound，实际 %v", err)
	}
	// 内容根本无法编译时不报错，而是回滚——这才是设计：
	// 「改坏了」是一个有结果、有证据、可回滚的结局，不是一次失败。
	rolled, err := service.ApplyAndVerify(ctx, project.ID, "main.tex", "这不是一份 LaTeX 文档", "垃圾内容", AutoFixOptions{})
	if err != nil {
		t.Fatalf("无法编译的内容应当走回滚路径而不是报错: %v", err)
	}
	if rolled.Outcome != OutcomeRolledBack {
		t.Fatalf("无法编译的内容必须回滚，实际 %s（%s）", rolled.Outcome, rolled.Reason)
	}
	after, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(after.Content, "这不是一份") {
		t.Fatal("回滚后磁盘上不该留下无法编译的内容")
	}
}

// 没有编译基线时不再把用户挡在门外：先真编译一次作为基线，并如实标注。
func TestApplyAndVerifyBuildsBaselineWhenMissing(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "无基线", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{AIAutoFix: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}
	if project.LastBuildID != "" {
		t.Fatal("新项目不该有编译记录")
	}
	result, err := service.ApplyAndVerify(ctx, project.ID, "main.tex",
		"\\documentclass{article}\n\\begin{document}\nBaseline test.\n\\end{document}\n", "首次写入", AutoFixOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if !result.BaselineRecompiled {
		t.Fatal("基线是现编译的，必须在结果里标注出来")
	}
	if result.BeforeBuildID == "" || result.BuildID == "" || result.BeforeBuildID == result.BuildID {
		t.Fatalf("基线编译与验证编译应当是两次不同的编译: %+v", result)
	}
	if result.Outcome != OutcomeKept {
		t.Fatalf("内容能编译通过时应当保留，实际 %s（%s）", result.Outcome, result.Reason)
	}
}

// 真实编译验证：改对了 → 保留；改坏了 → 自动回滚，磁盘回到修改前。
func TestApplyAndVerifyKeepsAndRollsBackWithRealCompile(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "自动修复", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{AIAutoFix: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}
	// 初始：编译通过。
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(
		"\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n"), ""); err != nil {
		t.Fatal(err)
	}
	baseline, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if finished := waitForBuild(t, service, baseline.ID, 3*time.Minute); finished.Status != BuildSucceeded {
		t.Fatalf("基线应当编译成功，实际 %s：%s", finished.Status, finished.Message)
	}

	// 情形一：AI 改坏了 → 必须回滚。
	broken := "\\documentclass{article}\n\\begin{document}\nHello \\thisCommandDoesNotExist{world}.\n\\end{document}\n"
	rolled, err := service.ApplyAndVerify(ctx, project.ID, "main.tex", broken, "故意改坏", AutoFixOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if rolled.Outcome != OutcomeRolledBack {
		t.Fatalf("改坏时必须回滚，实际 %s（%s）", rolled.Outcome, rolled.Reason)
	}
	if rolled.RejectedContent == "" {
		t.Fatal("被回滚的内容应当留在结果里供用户查看")
	}
	current, err := service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(current.Content, "thisCommandDoesNotExist") {
		t.Fatal("回滚后磁盘上不该还留着坏内容")
	}
	if rolled.SnapshotID == "" {
		t.Fatal("即使回滚也要留下快照编号")
	}

	// 情形二：AI 改好了（这里用一份等价但不同的内容模拟）→ 保留。
	good := "\\documentclass{article}\n\\begin{document}\nHello world, again.\n\\end{document}\n"
	kept, err := service.ApplyAndVerify(ctx, project.ID, "main.tex", good, "润色", AutoFixOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if kept.Outcome != OutcomeKept {
		t.Fatalf("仍然编译通过时应当保留，实际 %s（%s）", kept.Outcome, kept.Reason)
	}
	if kept.AfterErrors != 0 || kept.AfterStatus != string(BuildSucceeded) {
		t.Fatalf("保留时的编译结果不对: %+v", kept)
	}
	current, err = service.ReadFile(ctx, project.ID, "main.tex")
	if err != nil || current.Content != good {
		t.Fatalf("保留时磁盘内容应当是新版本: %v", err)
	}
	// 保留也要留快照（用户可能想回到修改前）。
	if _, err := service.Snapshot(ctx, kept.SnapshotID); err != nil {
		t.Fatalf("保留时也必须有可回滚的快照: %v", err)
	}
}

// 从「有错误」修到「没错误」：错误数减少即保留。
func TestApplyAndVerifyKeepsErrorReduction(t *testing.T) {
	requireTeX(t)
	service := newTestService(t)
	ctx := context.Background()
	project, err := service.Create(ctx, "错误减少", EnginePDFLaTeX, "main.tex")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Update(ctx, project.ID, ProjectPatch{AIAutoFix: boolPointer(true)}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.WriteFile(ctx, project.ID, "main.tex", []byte(
		"\\documentclass{article}\n\\begin{document}\nA \\thisCommandDoesNotExist{one}.\nB \\anotherMissingCommand{two}.\n\\end{document}\n"), ""); err != nil {
		t.Fatal(err)
	}
	baseline, err := service.StartBuild(ctx, project.ID, BuildOptions{})
	if err != nil {
		t.Fatal(err)
	}
	failed := waitForBuild(t, service, baseline.ID, 3*time.Minute)
	if failed.Status != BuildFailed || failed.ErrorCount == 0 {
		t.Fatalf("基线应当是失败的编译: %s / %d 个错误", failed.Status, failed.ErrorCount)
	}
	// 只修掉其中一个错误：错误数下降 → 保留（部分修复也是有价值的进展）。
	partial := "\\documentclass{article}\n\\begin{document}\nA fixed line.\nB \\anotherMissingCommand{two}.\n\\end{document}\n"
	result, err := service.ApplyAndVerify(ctx, project.ID, "main.tex", partial, "先修一个", AutoFixOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeKept {
		t.Fatalf("错误数下降时应当保留，实际 %s（%s）", result.Outcome, result.Reason)
	}
	if result.AfterErrors >= result.BeforeErrors {
		t.Fatalf("结果记录的错误数不对: %d → %d", result.BeforeErrors, result.AfterErrors)
	}
	if !strings.Contains(result.Reason, "编译错误") {
		t.Fatalf("说明里应当给出错误数变化: %q", result.Reason)
	}
}

func TestJudgeFixRules(t *testing.T) {
	build := func(status BuildStatus, errors int) *Build {
		return &Build{Status: status, ErrorCount: errors}
	}
	cases := []struct {
		name          string
		before, after *Build
		want          bool
	}{
		{"有错误→修好", build(BuildFailed, 3), build(BuildSucceeded, 0), true},
		{"有错误→变少", build(BuildFailed, 3), build(BuildFailed, 1), true},
		{"有错误→没变", build(BuildFailed, 3), build(BuildFailed, 3), false},
		{"有错误→变多", build(BuildFailed, 1), build(BuildFailed, 4), false},
		{"本来没问题→仍然没问题", build(BuildSucceeded, 0), build(BuildSucceeded, 0), true},
		{"本来没问题→改坏", build(BuildSucceeded, 0), build(BuildFailed, 2), false},
		// 有错误但生成了 PDF 的情况在 compile.go 里被归为 failed，这里同样按错误数判断。
		{"有错误→有错误但更少且成功", build(BuildFailed, 2), build(BuildSucceeded, 0), true},
	}
	for _, testCase := range cases {
		got, reason := judgeFix(testCase.before, testCase.after)
		if got != testCase.want {
			t.Fatalf("%s：判定应当为 %v，实际 %v（%s）", testCase.name, testCase.want, got, reason)
		}
		if reason == "" {
			t.Fatalf("%s：判定必须给出理由", testCase.name)
		}
	}
}

func boolPointer(value bool) *bool { return &value }

var _ = filepath.Join // 保持 filepath 引用（部分用例按平台拼接路径）
