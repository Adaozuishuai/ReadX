package booksources

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type Task struct {
	ID            string `json:"id"`
	LeaseID       string `json:"leaseId,omitempty"`
	ProviderID    string `json:"providerId"`
	BookID        string `json:"bookId"`
	Format        string `json:"format"`
	State         string `json:"state"`
	ReceivedBytes int64  `json:"receivedBytes"`
	TotalBytes    int64  `json:"totalBytes,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	Message       string `json:"message,omitempty"`
	FileName      string `json:"fileName,omitempty"`
	ContentType   string `json:"contentType,omitempty"`
	SHA256        string `json:"sha256,omitempty"`
}
type taskRuntime struct {
	Task
	cancel  context.CancelFunc
	file    string
	touched time.Time
	leases  map[string]bool
}
type Registry struct {
	providers   []Provider
	mu          sync.Mutex
	tasks       map[string]*taskRuntime
	folder      string
	slots       chan struct{}
	lastCleanup time.Time
}

func New(folder string, providers ...Provider) *Registry {
	return &Registry{providers: providers, tasks: map[string]*taskRuntime{}, folder: folder, slots: make(chan struct{}, 2)}
}
func (s *Registry) Sources() []Source {
	out := []Source{}
	for _, p := range s.providers {
		out = append(out, p.Info())
	}
	return out
}
func (s *Registry) provider(id string) (Provider, error) {
	for _, p := range s.providers {
		if p.Info().ProviderID == id {
			if !p.Info().Enabled {
				return nil, Fail("NOT_CONFIGURED", p.Info().Reason, 503)
			}
			return p, nil
		}
	}
	return nil, Fail("SOURCE_NOT_SUPPORTED", "未知书源", 404)
}
func (s *Registry) Search(ctx context.Context, id, q, cursor string) (SearchResult, error) {
	p, e := s.provider(id)
	if e != nil {
		return SearchResult{}, e
	}
	q = strings.TrimSpace(q)
	if q == "" || len([]rune(q)) > 120 {
		return SearchResult{}, Fail("SOURCE_NOT_SUPPORTED", "请输入 1 到 120 个字符的书名或作者", 400)
	}
	if !p.Info().Capabilities.Search {
		return SearchResult{}, Fail("SOURCE_NOT_SUPPORTED", p.Info().Reason, 400)
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return p.Search(ctx, q, cursor)
}
func (s *Registry) Detail(ctx context.Context, id, bookID string) (Book, error) {
	p, e := s.provider(id)
	if e != nil {
		return Book{}, e
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return p.Detail(ctx, bookID)
}
func (s *Registry) Start(ctx context.Context, id, bookID, format string) (Task, error) {
	return s.StartAuthorized(ctx, id, bookID, format, false)
}
func (s *Registry) StartAuthorized(ctx context.Context, id, bookID, format string, userAuthorized bool) (Task, error) {
	p, err := s.provider(id)
	if err != nil {
		return Task{}, err
	}
	if !p.Info().Capabilities.Download {
		return Task{}, Fail("SOURCE_NOT_SUPPORTED", "该书源不提供在线下载", 400)
	}
	if format != "epub" && format != "txt" {
		return Task{}, Fail("INVALID_FORMAT", "摸鱼书架支持 EPUB/TXT；PDF 请从科研书库导入", 400)
	}
	book, err := s.Detail(ctx, id, bookID)
	if err != nil {
		return Task{}, err
	}
	if err := ctx.Err(); err != nil {
		return Task{}, err
	}
	confirmed := id == "zlibrary" && book.RequiresRightsConfirmation && book.Rights.Access == "unknown" && userAuthorized
	if !book.Rights.AllowsDownload() && !confirmed {
		return Task{}, Fail("NO_PERMISSION", book.Rights.Reason, 403)
	}
	supported := false
	for _, f := range book.Formats {
		if f == format {
			supported = true
		}
	}
	if !supported {
		return Task{}, Fail("INVALID_FORMAT", "该书籍不提供所选格式", 400)
	}
	var leaseSeed [16]byte
	if _, err := rand.Read(leaseSeed[:]); err != nil {
		return Task{}, err
	}
	leaseID := hex.EncodeToString(leaseSeed[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	for _, task := range s.tasks {
		if task.ProviderID == id && task.BookID == bookID && task.Format == format && (task.State == "queued" || task.State == "running" || task.State == "ready") {
			task.leases[leaseID] = true
			out := task.Task
			out.LeaseID = leaseID
			return out, nil
		}
	}
	if len(s.tasks) >= 32 {
		// Terminal tasks can be evicted; a burst of successful imports must not
		// block new downloads for the entire expiry interval.
		var oldest *taskRuntime
		for _, t := range s.tasks {
			if t.State != "queued" && t.State != "running" && (oldest == nil || t.touched.Before(oldest.touched)) {
				oldest = t
			}
		}
		if oldest == nil {
			return Task{}, Fail("RATE_LIMITED", "下载任务较多，请稍后重试", 429)
		}
		if oldest.file != "" {
			_ = os.Remove(oldest.file)
		}
		delete(s.tasks, oldest.ID)
	}
	var seed [16]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return Task{}, err
	}
	taskID := hex.EncodeToString(seed[:])
	runCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	if confirmed {
		runCtx = context.WithValue(runCtx, zLibraryGrantKey{}, bookID)
	}
	task := &taskRuntime{Task: Task{ID: taskID, ProviderID: id, BookID: bookID, Format: format, State: "queued"}, cancel: cancel, touched: time.Now(), leases: map[string]bool{leaseID: true}}
	s.tasks[taskID] = task
	log.Printf("book-download task=%s provider=%s book=%s format=%s state=queued", taskID, id, bookID, format)
	go s.run(runCtx, p, taskID, bookID, format)
	out := task.Task
	out.LeaseID = leaseID
	return out, nil
}
func (s *Registry) run(ctx context.Context, p Provider, id, bookID, format string) {
	s.mu.Lock()
	task := s.tasks[id]
	s.mu.Unlock()
	defer task.cancel()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-ctx.Done():
		s.finish(id, Artifact{}, ctx.Err())
		return
	}
	s.mu.Lock()
	if task.State == "cancelled" {
		s.mu.Unlock()
		return
	}
	task.State = "running"
	s.mu.Unlock()
	artifact, err := p.Download(ctx, bookID, format, func(n, total int64) {
		s.mu.Lock()
		if task.State == "running" {
			task.ReceivedBytes = n
			if total > 0 {
				task.TotalBytes = total
			}
		}
		s.mu.Unlock()
	})
	if err == nil {
		err = ctx.Err()
	}
	s.finish(id, artifact, err)
}
func (s *Registry) finish(id string, a Artifact, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	task := s.tasks[id]
	if task == nil || task.State == "cancelled" {
		return
	}
	task.touched = time.Now()
	if err == nil {
		err = os.MkdirAll(s.folder, 0700)
		if err == nil {
			task.file = filepath.Join(s.folder, id+".book")
			err = os.WriteFile(task.file, a.Data, 0600)
		}
	}
	if err != nil {
		if task.file != "" {
			_ = os.Remove(task.file)
		}
		e := PublicError(err)
		task.State = "failed"
		task.ErrorCode = e.Code
		task.Message = e.Message
		log.Printf("book-download task=%s provider=%s state=failed code=%s", id, task.ProviderID, e.Code)
		return
	}
	task.State = "ready"
	task.FileName = a.FileName
	task.ContentType = a.ContentType
	task.SHA256 = a.SHA256
	task.ReceivedBytes = int64(len(a.Data))
	task.TotalBytes = task.ReceivedBytes
	log.Printf("book-download task=%s provider=%s state=ready bytes=%d", id, task.ProviderID, task.ReceivedBytes)
}

var cacheFileName = regexp.MustCompile(`^[0-9a-f]{32}\.book$`)

func (s *Registry) cleanupLocked() {
	for id, t := range s.tasks {
		if t.State != "running" && t.State != "queued" && time.Since(t.touched) > 10*time.Minute {
			if t.file != "" {
				_ = os.Remove(t.file)
			}
			delete(s.tasks, id)
		}
	}
	if time.Since(s.lastCleanup) < time.Minute {
		return
	}
	s.lastCleanup = time.Now()
	// Only remove expired files created by this component, including leftovers
	// after a process exit. Do not recurse or touch other cache files.
	entries, _ := os.ReadDir(s.folder)
	for _, entry := range entries {
		if entry.IsDir() || !cacheFileName.MatchString(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err == nil && time.Since(info.ModTime()) > 10*time.Minute {
			_ = os.Remove(filepath.Join(s.folder, entry.Name()))
		}
	}
}
func (s *Registry) Status(id string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	t := s.tasks[id]
	if t == nil {
		return Task{}, Fail("NOT_CONFIGURED", "任务已过期或服务已重启，请重新下载", 404)
	}
	return t.Task, nil
}
func (s *Registry) File(id string) (Task, *os.File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked()
	t := s.tasks[id]
	if t == nil || t.State != "ready" {
		return Task{}, nil, Fail("DOWNLOAD_FAILED", "下载尚未完成或已经清理", 409)
	}
	f, err := os.Open(t.file)
	if err != nil {
		return Task{}, nil, err
	}
	return t.Task, f, nil
}
func (s *Registry) Cancel(id string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.tasks[id]
	if t == nil {
		return Task{}, Fail("NOT_CONFIGURED", "下载任务不存在", 404)
	}
	return s.cancelLocked(t), nil
}

// Release ends one caller's interest. Repeated cleanup by the same window is
// idempotent; the shared transfer/file lives until the last caller releases it.
func (s *Registry) Release(id, leaseID string) (Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.tasks[id]
	if t == nil {
		return Task{}, Fail("NOT_CONFIGURED", "下载任务不存在", 404)
	}
	active, exists := t.leases[leaseID]
	if !exists {
		return Task{}, Fail("NO_PERMISSION", "下载任务引用凭据无效", 403)
	}
	if !active {
		return t.Task, nil
	}
	t.leases[leaseID] = false
	for _, held := range t.leases {
		if held {
			return t.Task, nil
		}
	}
	return s.cancelLocked(t), nil
}

func (s *Registry) cancelLocked(t *taskRuntime) Task {
	t.cancel()
	if t.file != "" {
		_ = os.Remove(t.file)
	}
	t.State = "cancelled"
	t.ErrorCode = "CANCELLED"
	t.Message = "已取消并清理下载"
	t.touched = time.Now()
	log.Printf("book-download task=%s provider=%s state=cancelled", t.ID, t.ProviderID)
	return t.Task
}

func (s *Registry) CancelProvider(providerID string) {
	s.mu.Lock()
	ids := []string{}
	for id, t := range s.tasks {
		if t.ProviderID == providerID {
			ids = append(ids, id)
		}
	}
	s.mu.Unlock()
	for _, id := range ids {
		_, _ = s.Cancel(id)
	}
}
