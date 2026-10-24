package appstate

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"
)

type memKV struct {
	mu   sync.RWMutex
	data map[string][]byte
}

func newMemKV() *memKV { return &memKV{data: make(map[string][]byte)} }

func (m *memKV) Get(_ context.Context, key string) ([]byte, bool, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	v, ok := m.data[key]
	return v, ok, nil
}

func (m *memKV) Put(_ context.Context, key string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.data[key] = data
	return nil
}

type counterDoc struct{ N int }

// 本包存在的理由：原先按 key 各自记忆的锁（citation_network 干脆没有），
// 换成 Update 后并发读改写不允许丢失任何一次。
func TestConcurrentUpdateNoLostWrites(t *testing.T) {
	s := New(newMemKV())
	const workers, each = 8, 200
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < each; i++ {
				err := s.Update(context.Background(), "counter", func(cur []byte, exists bool) ([]byte, error) {
					doc := counterDoc{}
					if exists {
						if err := json.Unmarshal(cur, &doc); err != nil {
							return nil, err
						}
					}
					doc.N++
					return json.Marshal(doc)
				})
				if err != nil {
					t.Errorf("Update: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
	got, ok, err := Load[counterDoc](context.Background(), s, "counter")
	if err != nil || !ok {
		t.Fatalf("Load: ok=%v err=%v", ok, err)
	}
	if want := workers * each; got.N != want {
		t.Fatalf("并发更新丢失: got %d, want %d", got.N, want)
	}
}

func TestMissingKeyAndNilNextSemantics(t *testing.T) {
	s := New(newMemKV())
	ctx := context.Background()
	var sawExists bool
	var sawCur []byte
	if err := s.Update(ctx, "absent", func(cur []byte, exists bool) ([]byte, error) {
		sawCur, sawExists = cur, exists
		return []byte(`{"n":1}`), nil
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if sawExists || sawCur != nil {
		t.Fatalf("不存在键的 cur 应为 nil: cur=%q exists=%v", sawCur, sawExists)
	}
	if err := s.Update(ctx, "keep", func([]byte, bool) ([]byte, error) { return nil, nil }); err != nil {
		t.Fatalf("nil 返回应保持原值: %v", err)
	}
	if _, ok, _ := Load[counterDoc](ctx, s, "keep"); ok {
		t.Fatal("nil 返回不应写入")
	}
}

// 每 key 一把锁的意义：慢 key 不阻塞无关 key。
func TestDifferentKeysRunInParallel(t *testing.T) {
	s := New(newMemKV())
	ctx := context.Background()
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 2)
	go func() {
		done <- s.Update(ctx, "slow", func([]byte, bool) ([]byte, error) {
			entered <- struct{}{}
			<-release
			return []byte("1"), nil
		})
	}()
	<-entered
	other := make(chan error, 1)
	go func() {
		other <- s.Update(ctx, "fast", func([]byte, bool) ([]byte, error) { return []byte("2"), nil })
	}()
	select {
	case err := <-other:
		if err != nil {
			t.Fatalf("fast Update: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("不同 key 不应被同一把大锁串行阻塞")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("slow Update: %v", err)
	}
}
