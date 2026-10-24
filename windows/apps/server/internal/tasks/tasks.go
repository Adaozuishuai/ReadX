// Package tasks 统一后台异步任务的公共设施。
//
// 本仓库存在四套手写任务系统，骨架相同（map + mutex + goroutine +
// context.CancelFunc + 状态字符串），语义各异：
//
//	internal/httpapi/import_jobs.go     导入任务：app_state 持久化；重启 running→interrupted；
//	                                   cancelled 不可被 worker 回写 failed；无并发槽、无超时
//	internal/booksources/registry.go    书源下载：纯内存；2 并发槽；2 分钟硬超时；
//	                                   终态 10 分钟 TTL + 容量 32 驱逐 + 磁盘残留清扫
//	internal/latex/compile.go           LaTeX 编译：DB 持久化；2 槽；5–15 分钟超时；每项目留 10 条
//	internal/httpapi/comparison_jobs.go 对照实验：纯内存；30 分钟超时；
//	                                   【无取消入口；map 条目从不清理；零测试】
//
// 本包把四套收敛为一个 Registry，语义取各系统的并集并显式声明：
//   - 终态一次性生效（Cancelled 不会被 worker 回写成 Failed，import_jobs 语义）；
//   - 并发槽（默认 2，书源下载/LaTeX 编译的既有值）；
//   - 单任务硬超时（可选）；
//   - 容量上限 + 终态 TTL 清理（书源下载语义），杜绝 comparison_jobs 式的无限增长；
//   - 可选持久化适配器（导入任务→app_state、LaTeX→latex_builds）；
//   - 同 id 进行中任务直接复用（书源下载的去重语义）；
//   - 重启恢复：LoadAll 读到的非终态任务标记为 Failed（「服务重启，任务已中断」，
//     对应 import_jobs 的 interrupted 语义）。
//
// 第一个接入方是 comparison_jobs（泄漏/取消/零测试三个问题一并解决）；
// 其余三套按对照文档的迁移顺序逐个切换，行为由本包测试锁定。
package tasks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// State 是任务状态机。原四套系统的状态名（done/succeeded/ready、interrupted、
// timeout…）统一映射到这里；超时归入 Failed（Error 注明），不再单列状态。
type State string

const (
	Queued    State = "queued"
	Running   State = "running"
	Succeeded State = "succeeded"
	Failed    State = "failed"
	Cancelled State = "cancelled"
)

// Terminal 报告 s 是否终态。终态一次性生效，之后不可被覆盖。
func (s State) Terminal() bool { return s == Succeeded || s == Failed || s == Cancelled }

var (
	// ErrBusy 表示任务表已满且无可驱逐的终态任务（对应书源下载的 429 语义）。
	ErrBusy = errors.New("任务表已满，请稍后再试")
	// ErrClosed 表示 Registry 已关闭，不再接受新任务。
	ErrClosed = errors.New("任务系统已关闭")
)

// Snapshot 是任务的对外只读视图（handler 直接 JSON 化返回）。
type Snapshot struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"`
	State     State     `json:"state"`
	Percent   int       `json:"percent,omitempty"`
	Progress  string    `json:"progress,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	StartedAt time.Time `json:"startedAt,omitzero"`
	EndedAt   time.Time `json:"endedAt,omitzero"`
}

// Store 是可选的持久化适配器。实现必须并发安全；Registry 在每次状态变化后调用
// Save，在 TTL 清理/容量驱逐后调用 Delete。导入任务对接 app_state，LaTeX 对接
// latex_builds 表——差异被压缩到这两个方法里。
type Store interface {
	Save(Snapshot)
	Delete(id string)
	LoadAll() []Snapshot
}

// Options 声明一类任务的策略。
type Options struct {
	Kind      string        // 任务类型名，出现在 Snapshot.Kind
	MaxActive int           // 并发槽位数，默认 2
	Capacity  int           // 任务表容量，默认 32；满时先驱逐最旧终态，全为活跃则返回 ErrBusy
	TTL       time.Duration // 终态任务保留时长，默认 10 分钟；到点由后台清理协程移除
	Timeout   time.Duration // 单任务硬超时；0 = 不限时（由调用方的 ctx 决定）
	Log       func(format string, args ...any)
}

func (o *Options) fill() {
	if o.MaxActive <= 0 {
		o.MaxActive = 2
	}
	if o.Capacity <= 0 {
		o.Capacity = 32
	}
	if o.TTL <= 0 {
		o.TTL = 10 * time.Minute
	}
}

func (o *Options) logf(format string, args ...any) {
	if o.Log != nil {
		o.Log(format, args...)
	}
}

type task struct {
	snap   Snapshot
	cancel context.CancelFunc
	// extDone 由外部 Cancel 关闭；done 在终态生效时关闭。
	// 两个通道分开，run 循环才能区分「外部取消」与「超时」。
	extDone chan struct{}
	done    chan struct{}
}

// Registry 管理一类后台任务。零值不可用，必须经 New 创建。
type Registry struct {
	opts  Options
	store Store

	mu    sync.Mutex
	tasks map[string]*task
	order []string // 创建顺序，供容量驱逐与 TTL 清理使用

	slots chan struct{}

	closeOnce sync.Once
	closed    chan struct{}
}

// New 创建 Registry。store 可为 nil（纯内存，如书源下载与对照实验）；
// 非 nil 时先 LoadAll 恢复：终态任务原样读回（Get 仍可见），非终态任务
// 一律改判 Failed（「服务重启，任务已中断」），与 import_jobs 的恢复语义一致。
func New(opts Options, store Store) *Registry {
	opts.fill()
	r := &Registry{
		opts:   opts,
		store:  store,
		tasks:  make(map[string]*task),
		slots:  make(chan struct{}, opts.MaxActive),
		closed: make(chan struct{}),
	}
	if store != nil {
		for _, snap := range store.LoadAll() {
			s := snap
			if !s.State.Terminal() {
				s.State = Failed
				s.Error = "服务重启，任务已中断"
				s.EndedAt = time.Now()
			}
			r.tasks[s.ID] = &task{snap: s}
			r.order = append(r.order, s.ID)
		}
	}
	go r.reap()
	return r
}

// reap 周期清理过期的终态任务。这是原 comparison_jobs（从不清理）与
// 书源下载（10 分钟 TTL）之间的统一语义。
func (r *Registry) reap() {
	interval := r.opts.TTL / 2
	if interval < 100*time.Millisecond {
		interval = 100 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-r.closed:
			return
		case <-ticker.C:
			r.cleanup(time.Now())
		}
	}
}

func (r *Registry) cleanup(now time.Time) {
	r.mu.Lock()
	var removed []string
	kept := r.order[:0]
	for _, id := range r.order {
		t, ok := r.tasks[id]
		if !ok {
			continue // 已被驱逐/删除的陈旧条目
		}
		if t.snap.State.Terminal() && now.Sub(t.snap.EndedAt) > r.opts.TTL {
			delete(r.tasks, id)
			removed = append(removed, id)
			continue
		}
		kept = append(kept, id)
	}
	r.order = kept
	r.mu.Unlock()
	for _, id := range removed {
		if r.store != nil {
			r.store.Delete(id)
		}
	}
	if len(removed) > 0 {
		r.opts.logf("tasks(%s): TTL 清理 %d 个终态任务", r.opts.Kind, len(removed))
	}
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// Submit 登记并异步执行 run。id 为空时自动生成；同 id 存在进行中任务时直接
// 复用（不重复执行，书源下载的去重语义）；终态任务可重跑（覆盖旧记录）。
// report 供 run 上报进度（percent + 人类可读消息），仅 Running 态生效。
func (r *Registry) Submit(id string, run func(ctx context.Context, report func(percent int, message string)) error) (Snapshot, error) {
	if run == nil {
		return Snapshot{}, errors.New("tasks: run 不能为空")
	}
	r.mu.Lock()
	if id == "" {
		id = newID()
	}
	if existing, ok := r.tasks[id]; ok && !existing.snap.State.Terminal() {
		snap := existing.snap
		r.mu.Unlock()
		return snap, nil
	}
	select {
	case <-r.closed:
		r.mu.Unlock()
		return Snapshot{}, ErrClosed
	default:
	}
	if err := r.makeRoomLocked(); err != nil {
		r.mu.Unlock()
		return Snapshot{}, err
	}
	var ctx context.Context
	var cancel context.CancelFunc
	if r.opts.Timeout > 0 {
		ctx, cancel = context.WithTimeout(context.Background(), r.opts.Timeout)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
	}
	t := &task{
		snap:    Snapshot{ID: id, Kind: r.opts.Kind, State: Queued, CreatedAt: time.Now()},
		cancel:  cancel,
		extDone: make(chan struct{}),
		done:    make(chan struct{}),
	}
	r.tasks[id] = t
	r.order = append(r.order, id)
	snap := t.snap
	r.mu.Unlock()
	if r.store != nil {
		r.store.Save(snap)
	}
	go r.run(t, ctx, run)
	return snap, nil
}

// makeRoomLocked 保证容量：优先驱逐最旧终态；全为活跃任务则 ErrBusy。
func (r *Registry) makeRoomLocked() error {
	if len(r.tasks) < r.opts.Capacity {
		return nil
	}
	for i, id := range r.order {
		if t, ok := r.tasks[id]; ok && t.snap.State.Terminal() {
			delete(r.tasks, id)
			r.order = append(r.order[:i], r.order[i+1:]...)
			if r.store != nil {
				r.store.Delete(id)
			}
			r.opts.logf("tasks(%s): 容量满，驱逐终态任务 %s", r.opts.Kind, id)
			return nil
		}
	}
	return ErrBusy
}

func (r *Registry) run(t *task, ctx context.Context, fn func(ctx context.Context, report func(percent int, message string)) error) {
	defer t.cancel()
	// 等并发槽。排队期间被取消/关闭则直接终态。
	select {
	case r.slots <- struct{}{}:
	case <-t.extDone:
		t.cancel()
		r.finalize(t, Cancelled, "")
		return
	case <-r.closed:
		t.cancel()
		r.finalize(t, Cancelled, "")
		return
	case <-ctx.Done():
		r.finalizeContext(t)
		return
	}
	defer func() { <-r.slots }()
	// 槽位与超时可能同时就绪，不把已经过期的任务交给 worker。
	if ctx.Err() != nil {
		r.finalizeContext(t)
		return
	}

	r.mu.Lock()
	if t.snap.State != Queued { // 排队期间已被终态化（如取消）——终态不可被回写
		r.mu.Unlock()
		return
	}
	t.snap.State = Running
	t.snap.StartedAt = time.Now()
	snap := t.snap
	r.mu.Unlock()
	if r.store != nil {
		r.store.Save(snap)
	}

	report := func(percent int, message string) {
		r.mu.Lock()
		if t.snap.State == Running {
			t.snap.Percent = percent
			t.snap.Progress = message
		}
		r.mu.Unlock()
	}

	runErr := make(chan error, 1) // 缓冲 1：worker 晚于终态返回时也能退出，不泄漏
	go func() { runErr <- fn(ctx, report) }()

	select {
	case err := <-runErr:
		switch {
		case r.isTerminal(t):
			// 已被外部置为 Cancelled：worker 的返回值（包括它因 ctx 取消而返回的
			// context.Canceled）不得覆盖终态 —— import_jobs 的既有语义。
		case err == nil:
			r.finalize(t, Succeeded, "")
		default:
			r.finalize(t, Failed, err.Error())
		}
	case <-t.extDone:
		t.cancel() // 让 fn 内部的 ctx 感知取消（若 fn 忽略 ctx，由调用方保证其会退出）
		r.finalize(t, Cancelled, "")
		<-runErr // 等待 worker 落幕，避免把还在写的资源交给下一个同 id 任务
	case <-ctx.Done():
		r.finalizeContext(t)
		<-runErr
	}
}

func (r *Registry) finalizeContext(t *task) {
	select {
	case <-t.extDone:
		r.finalize(t, Cancelled, "")
	case <-r.closed:
		r.finalize(t, Cancelled, "")
	default:
		r.finalize(t, Failed, fmt.Sprintf("任务超时（上限 %s）", r.opts.Timeout))
	}
}

func (r *Registry) isTerminal(t *task) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return t.snap.State.Terminal()
}

// finalize 让终态一次性生效：第一个到达者胜出，之后所有调用都是空操作。
func (r *Registry) finalize(t *task, state State, errMsg string) {
	r.mu.Lock()
	if t.snap.State.Terminal() || t.done == nil {
		r.mu.Unlock()
		return
	}
	t.snap.State = state
	t.snap.Error = errMsg
	t.snap.EndedAt = time.Now()
	if state != Succeeded {
		t.snap.Percent = 0
	}
	snap := t.snap
	close(t.done)
	r.mu.Unlock()
	if r.store != nil {
		r.store.Save(snap)
	}
	r.opts.logf("tasks(%s): %s -> %s", r.opts.Kind, t.snap.ID, state)
}

// Get 返回任务快照。
func (r *Registry) Get(id string) (Snapshot, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[id]
	if !ok {
		return Snapshot{}, false
	}
	return t.snap, true
}

// Done 返回任务终态信号（在 finalize 时关闭）。缺失的任务返回 nil。
func (r *Registry) Done(id string) <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[id]
	if !ok {
		return nil
	}
	return t.done
}

// List 返回按创建顺序排列的任务快照。
func (r *Registry) List() []Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Snapshot, 0, len(r.order))
	for _, id := range r.order {
		if t, ok := r.tasks[id]; ok {
			out = append(out, t.snap)
		}
	}
	return out
}

// Cancel 请求取消。返回 false 表示任务不存在或已终态（「已经不在运行中」，
// LaTeX 编译的既有文案语义）；取消中的任务最终态为 Cancelled。
func (r *Registry) Cancel(id string) bool {
	r.mu.Lock()
	t, ok := r.tasks[id]
	if !ok || t.snap.State.Terminal() {
		r.mu.Unlock()
		return false
	}
	select {
	case <-t.extDone:
		// 已有取消在途：幂等返回 true
	default:
		close(t.extDone)
	}
	r.mu.Unlock()
	t.cancel()
	return true
}

// Close 取消全部在途任务并停止清理协程。之后 Submit 返回 ErrClosed。
func (r *Registry) Close() {
	r.closeOnce.Do(func() {
		close(r.closed)
		r.mu.Lock()
		live := make([]*task, 0, len(r.tasks))
		for _, t := range r.tasks {
			if !t.snap.State.Terminal() {
				live = append(live, t)
			}
		}
		r.mu.Unlock()
		for _, t := range live {
			r.Cancel(t.snap.ID)
		}
	})
}
