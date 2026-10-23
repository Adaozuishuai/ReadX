package latex

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"
	"time"
)

// ErrAIAutoFixDisabled 表示项目没有开启「AI 直接写盘」。
//
// 这是一个开关而不是一个提示：默认关闭时，任何直接写盘的路径都必须走不通，
// 否则「我只是问了个问题」就可能变成「我的论文被改了」。
var ErrAIAutoFixDisabled = errors.New("这个项目没有开启「AI 直接改文件」")

// VerifyOutcome 说明这次写入最终是被保留还是被回滚。
type VerifyOutcome string

const (
	OutcomeKept       VerifyOutcome = "kept"
	OutcomeRolledBack VerifyOutcome = "rolled-back"
)

// AutoFixResult 是一次「AI 直接写盘」的完整交代：改了什么、编译前后各有多少错误、
// 最后保留还是回滚、快照编号是多少（用户可以据此再回滚）。
//
// 每个字段都是给用户看的证据，不允许只有一句「已修复」。
type AutoFixResult struct {
	FilePath      string        `json:"filePath"`
	Summary       string        `json:"summary"`
	Outcome       VerifyOutcome `json:"outcome"`
	Reason        string        `json:"reason"`
	SnapshotID    string        `json:"snapshotId"`
	BuildID       string        `json:"buildId"`
	BeforeBuildID string        `json:"beforeBuildId"`
	BeforeErrors  int           `json:"beforeErrors"`
	AfterErrors   int           `json:"afterErrors"`
	BeforeStatus  string        `json:"beforeStatus"`
	AfterStatus   string        `json:"afterStatus"`
	BeforeMessage string        `json:"beforeMessage"`
	AfterMessage  string        `json:"afterMessage"`
	Diagnostics   []Diagnostic  `json:"diagnostics"`
	BytesChanged  int           `json:"bytesChanged"`
	DurationMs    int64         `json:"durationMs"`
	// BaselineRecompiled 表示基线是这次现编译的（原基线已过期或不存在）。
	// 如实标注：用户据此知道多花了一次编译时间，也知道错误数是在什么状态下取的。
	BaselineRecompiled bool `json:"baselineRecompiled"`
	// Content 只在被回滚时给出：让界面能把「AI 想改成什么」留档给用户判断。
	RejectedContent string `json:"rejectedContent,omitempty"`
}

// AutoFixOptions 控制一次直接写盘。
type AutoFixOptions struct {
	Note             string
	BuildTimeout     time.Duration
	ExpectedRevision string
	// Progress 用于把阶段变化推给界面（SSE）。允许为 nil。
	Progress func(stage, detail string)
}

// ApplyAndVerify 是「AI 直接写盘」的唯一写入口。
//
// 流程固定为：校验开关 → 取基线编译 → 快照 → 原子写 → 强制重新编译 → 比较 → 保留或回滚。
// 顺序不能变：**先有基线、先有快照**，否则一旦改坏就没有可回滚的目标，
// 也无法判断这次改动到底让情况变好还是变坏。
func (s *Service) ApplyAndVerify(ctx context.Context, projectID, filePath, content, summary string, options AutoFixOptions) (*AutoFixResult, error) {
	started := time.Now()
	progress := options.Progress
	if progress == nil {
		progress = func(string, string) {}
	}
	project, err := s.Get(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if !project.AIAutoFix {
		return nil, ErrAIAutoFixDisabled
	}
	normalized, err := NormalizeRelative(filePath)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(path.Ext(normalized), ".tex") {
		return nil, fmt.Errorf("%w: AI 直接写盘只允许 .tex 文件", ErrUnsafePath)
	}
	if len(content) > MaxFileBytes {
		return nil, fmt.Errorf("%w: 修复后的源码超过 %d MB", ErrTooLarge, MaxFileBytes>>20)
	}

	progress("checking", "准备基线编译结果")
	baseline, recompiled, err := s.ensureBaseline(ctx, project, options, progress)
	if err != nil {
		return nil, err
	}

	srcDir, err := s.SrcDir(projectID)
	if err != nil {
		return nil, err
	}
	target, err := ResolveUnder(srcDir, normalized)
	if err != nil {
		return nil, err
	}
	before, err := os.ReadFile(target)
	if err != nil {
		return nil, fmt.Errorf("%w: 读不到 %s", ErrNotFound, normalized)
	}
	// 对照 AI 生成前读取的 revision，拒绝覆盖生成期间的用户编辑。
	revision := fileRevision(before)
	if options.ExpectedRevision != "" && revision != options.ExpectedRevision {
		return nil, fmt.Errorf("%w: 文件在 AI 生成期间被改动，已放弃写入", ErrRevisionMismatch)
	}

	progress("snapshot", "写入前保存源码快照")
	note := strings.TrimSpace(options.Note)
	if note == "" {
		note = "AI 自动修复前：" + normalized
	}
	snapshot, err := s.CreateSnapshot(ctx, projectID, note)
	if err != nil {
		return nil, err
	}
	result := &AutoFixResult{
		FilePath: normalized, Summary: strings.TrimSpace(summary),
		SnapshotID: snapshot.ID, BeforeBuildID: baseline.ID,
		BeforeErrors: baseline.ErrorCount, BeforeStatus: string(baseline.Status),
		BeforeMessage: baseline.Message, Diagnostics: []Diagnostic{},
		BaselineRecompiled: recompiled,
	}

	progress("writing", "写入 AI 修改后的源码")
	writtenRevision, err := s.WriteFile(ctx, projectID, normalized, []byte(content), revision)
	if err != nil {
		// 写失败时磁盘没变，快照留着也无害（用户可能想对比）。
		if errors.Is(err, ErrRevisionMismatch) {
			return nil, fmt.Errorf("%w: 文件在 AI 生成期间被改动，已放弃写入", err)
		}
		return nil, err
	}
	result.BytesChanged = len(content) - len(before)

	progress("compiling", "重新编译以验证修改")
	build, err := s.StartBuild(ctx, projectID, BuildOptions{Timeout: options.BuildTimeout})
	if err != nil {
		// 编译起不来（例如引擎被卸载）：立刻回滚，不能让源码停在未验证状态。
		rollbackErr := s.rollback(ctx, snapshot, normalized, writtenRevision)
		if rollbackErr != nil {
			return nil, fmt.Errorf("编译无法启动（%v），且回滚失败（%v）：请手动用快照 %s 恢复", err, rollbackErr, snapshot.ID)
		}
		result.Outcome = OutcomeRolledBack
		result.Reason = "编译无法启动：" + err.Error() + "；源码已回滚"
		result.DurationMs = time.Since(started).Milliseconds()
		return result, nil
	}
	result.BuildID = build.ID
	verified, err := s.waitForBuildTerminal(ctx, build.ID, buildWaitTimeout(options.BuildTimeout))
	if err != nil {
		rollbackErr := s.rollback(ctx, snapshot, normalized, writtenRevision)
		if rollbackErr != nil {
			return nil, fmt.Errorf("等待编译结束失败（%v），且回滚失败（%v）：请手动用快照 %s 恢复", err, rollbackErr, snapshot.ID)
		}
		result.Outcome = OutcomeRolledBack
		result.Reason = "等待编译结束失败：" + err.Error() + "；源码已回滚"
		result.DurationMs = time.Since(started).Milliseconds()
		return result, nil
	}
	result.AfterErrors = verified.ErrorCount
	result.AfterStatus = string(verified.Status)
	result.AfterMessage = verified.Message
	result.Diagnostics = verified.Diagnostics

	progress("verifying", "比较修改前后的编译错误")
	improved, reason := judgeFix(baseline, verified)
	if !improved {
		if rollbackErr := s.rollback(ctx, snapshot, normalized, writtenRevision); rollbackErr != nil {
			return nil, fmt.Errorf("修改没有改善（%s），且回滚失败（%v）：请手动用快照 %s 恢复", reason, rollbackErr, snapshot.ID)
		}
		result.Outcome = OutcomeRolledBack
		result.Reason = reason + "；源码已回滚到修改前"
		result.RejectedContent = content
		result.DurationMs = time.Since(started).Milliseconds()
		return result, nil
	}
	result.Outcome = OutcomeKept
	result.Reason = reason
	result.DurationMs = time.Since(started).Milliseconds()
	return result, nil
}

// ensureBaseline 保证手里有一份「与当前源码一致」的编译结果。
//
// 为什么允许自动补编译而不是直接拒绝：回滚之后，最后一次编译记录对应的是**被回滚掉的坏内容**，
// 它诚实地过期了；此时若一律要求用户先手动编译，就会出现「AI 改坏 → 自动回滚 → 再点一次被拒」
// 这种死循环式的体验。补一次编译只多花几秒，而且这次编译是真实的、结果照样如实展示。
func (s *Service) ensureBaseline(ctx context.Context, project *Project, options AutoFixOptions, progress func(string, string)) (*Build, bool, error) {
	if project.LastBuildID != "" {
		existing, err := s.Build(ctx, project.LastBuildID)
		if err != nil {
			return nil, false, err
		}
		if existing.Status == BuildQueued || existing.Status == BuildRunning {
			// 正在编译：等它结束，再判断是否可用。
			progress("checking", "等待进行中的编译结束")
			finished, waitErr := s.waitForBuildTerminal(ctx, existing.ID, buildWaitTimeout(options.BuildTimeout))
			if waitErr != nil {
				return nil, false, waitErr
			}
			existing = finished
		}
		if !existing.Stale {
			return existing, false, nil
		}
		progress("checking", "原编译结果已过期，先重新编译一次作为基线")
	} else {
		progress("checking", "这个项目还没有编译过，先编译一次作为基线")
	}
	fresh, err := s.StartBuild(ctx, project.ID, BuildOptions{Timeout: options.BuildTimeout})
	if err != nil {
		return nil, false, fmt.Errorf("无法建立基线：%w", err)
	}
	finished, err := s.waitForBuildTerminal(ctx, fresh.ID, buildWaitTimeout(options.BuildTimeout))
	if err != nil {
		return nil, false, fmt.Errorf("基线编译没有正常结束：%w", err)
	}
	return finished, true, nil
}

// rollback 只恢复自动修复目标文件，避免触碰项目中的其他同期改动。
func (s *Service) rollback(ctx context.Context, snapshot *Snapshot, filePath, expectedRevision string) error {
	return s.restoreSnapshotFile(ctx, snapshot.ID, filePath, expectedRevision)
}

// judgeFix 是唯一的判定规则，写清楚是为了让它可被质疑：
//
//   - 修改前有错误：修改后编译成功，或编译确实报告更少错误 → 保留。
//   - 超时、取消等非正常结束不能作为错误数改善的证据 → 回滚。
//   - 修改前没有错误（例如用户只是让 AI 润色）：修改后必须仍然编译成功且没有错误 → 保留；
//     否则回滚——把一份能编译的稿子改坏是纯粹的损失。
//
// 刻意不做「错误数相同就算成功」：错误数没变说明没修好，而源码已经变了，
// 保留它等于让用户承担一次没有收益的风险。
func judgeFix(before, after *Build) (bool, string) {
	beforeErrors, afterErrors := before.ErrorCount, after.ErrorCount
	afterOK := after.Status == BuildSucceeded && afterErrors == 0
	switch {
	case beforeErrors > 0 && afterOK:
		return true, fmt.Sprintf("编译错误 %d → 0，已保留修改", beforeErrors)
	case beforeErrors > 0 && after.Status == BuildFailed && afterErrors > 0 && afterErrors < beforeErrors:
		return true, fmt.Sprintf("编译错误 %d → %d，已保留修改", beforeErrors, afterErrors)
	case beforeErrors > 0 && (after.Status != BuildFailed || afterErrors == 0):
		return false, fmt.Sprintf("验证编译未能确认修复（状态：%s，诊断：%d 个错误）", after.Status, afterErrors)
	case beforeErrors == 0 && afterOK:
		return true, "修改后仍然编译通过，已保留修改"
	case beforeErrors == 0:
		return false, fmt.Sprintf("修改前编译通过，修改后出现 %d 个错误", afterErrors)
	default:
		return false, fmt.Sprintf("编译错误没有减少（%d → %d）", beforeErrors, afterErrors)
	}
}

// waitForBuildTerminal 轮询到编译结束。
//
// 这里必须走数据库轮询而不是复用 StartBuild 的 goroutine：
// 直接写盘要在同一段逻辑里拿到最终结果并据此决定回滚，跨请求共享内存状态会很难推理。
func (s *Service) waitForBuildTerminal(ctx context.Context, buildID string, timeout time.Duration) (*Build, error) {
	deadline := time.Now().Add(timeout)
	for {
		build, err := s.Build(ctx, buildID)
		if err != nil {
			return nil, err
		}
		if build.Status != BuildQueued && build.Status != BuildRunning {
			return build, nil
		}
		if time.Now().After(deadline) {
			_ = s.CancelBuild(ctx, buildID)
			return build, fmt.Errorf("等待编译结束超过 %s", timeout)
		}
		select {
		case <-ctx.Done():
			return build, ctx.Err()
		case <-time.After(300 * time.Millisecond):
		}
	}
}

// buildWaitTimeout 给编译本身留出余量：StartBuild 的超时控制进程，
// 这里控制「等它多久就认定卡住」，两者不能是同一个数。
func buildWaitTimeout(buildTimeout time.Duration) time.Duration {
	if buildTimeout <= 0 {
		buildTimeout = DefaultBuildTimeout
	}
	return buildTimeout + 30*time.Second
}
