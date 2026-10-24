package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 原先这里是「持 appStateMu 期间元数据操作必须阻塞」的互斥测试；appStateMu
// 删除后，要保的不变量换成了它真正的目的：并发的元数据写互不丢失。
// 原实现（loadAllMeta → 改 → 写回三步）在并发下会整包覆盖、丢失其它写者的
// 更新；saveMeta/mutateAllMeta 的每 key 锁原子化后，这里逐条锁定该行为。
func TestConcurrentMetadataWritesDoNotLoseUpdates(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()

	const writers, each = 6, 8 // 6 个并发写者 × 各写 8 篇不同的论文
	for i := 0; i < writers*each; i++ {
		key := fmt.Sprintf("paper-%02d", i)
		if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES(?,?,?)`, key, key, key); err != nil {
			t.Fatal(err)
		}
	}

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < each; i++ {
				key := fmt.Sprintf("paper-%02d", w*each+i)
				if err := s.saveMeta(context.Background(), key, DocumentMeta{Key: key, Favorite: true, Tags: []string{"t"}}); err != nil {
					t.Errorf("saveMeta(%s): %v", key, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	all, err := s.loadAllMeta(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < writers*each; i++ {
		key := fmt.Sprintf("paper-%02d", i)
		meta, ok := all[key]
		if !ok || !meta.Favorite || len(meta.Tags) != 1 {
			t.Fatalf("并发写丢失：%s -> %+v（存在=%v）", key, meta, ok)
		}
	}
}

// Restore and PATCH must merge their changes to the same document.
func TestRestoreAndPatchConcurrentNoTornState(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES('paper','paper','Paper')`); err != nil {
		t.Fatal(err)
	}
	if err := s.saveMeta(context.Background(), "paper", DocumentMeta{Key: "paper", Deleted: true, Tags: []string{"keep"}}); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if _, err := s.restoreDocumentFromTrash(context.Background(), "paper"); err != nil {
			t.Errorf("restore: %v", err)
		}
	}()
	go func() {
		defer wg.Done()
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"favorite":true}`))
		r.SetPathValue("key", "paper")
		s.handleDocumentMetaPatch(w, r)
		if w.Code != http.StatusOK {
			t.Errorf("patch response: HTTP %d", w.Code)
		}
	}()
	wg.Wait()

	meta, err := s.loadMeta(context.Background(), "paper")
	if err != nil {
		t.Fatal(err)
	}
	// 两个写者各改各的字段：恢复清 Deleted、PATCH 置 Favorite。
	// 同 key 读改写串行 ⇒ 后写者基于最新值合并，两个字段都必须在。
	if meta.Deleted || !meta.Favorite || len(meta.Tags) != 1 || meta.Tags[0] != "keep" {
		t.Fatalf("并发恢复+PATCH 产生撕裂状态: %+v", meta)
	}
}

func TestTrashEmptyCannotDeleteSuccessfullyRestoredDocument(t *testing.T) {
	_, handle, cfg := newTestServer(t, nil)
	s := New(cfg, handle)
	defer s.comparisonJobs.Close()
	for _, viaPatch := range []bool{false, true} {
		for attempt := 0; attempt < 25; attempt++ {
			key := fmt.Sprintf("restore-%t-%d", viaPatch, attempt)
			if _, err := handle.Exec(`INSERT INTO documents(id,key,title) VALUES(?,?,?)`, key, key, key); err != nil {
				t.Fatal(err)
			}
			if err := s.saveMeta(context.Background(), key, DocumentMeta{Key: key, Deleted: true}); err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			restored := make(chan error, 1)
			deleted := make(chan int, 1)
			go func() {
				<-start
				if viaPatch {
					w := httptest.NewRecorder()
					r := httptest.NewRequest(http.MethodPatch, "/", strings.NewReader(`{"deleted":false}`))
					r.SetPathValue("key", key)
					s.handleDocumentMetaPatch(w, r)
					if w.Code == http.StatusOK {
						restored <- nil
					} else if w.Code == http.StatusNotFound {
						restored <- sql.ErrNoRows
					} else {
						restored <- fmt.Errorf("restore PATCH: %d %s", w.Code, w.Body)
					}
					return
				}
				_, err := s.restoreDocumentFromTrash(context.Background(), key)
				restored <- err
			}()
			go func() {
				<-start
				w := httptest.NewRecorder()
				r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(fmt.Sprintf(`{"keys":[%q]}`, key)))
				s.handleTrashEmpty(w, r)
				deleted <- w.Code
			}()
			close(start)
			restoreErr, deleteStatus := <-restored, <-deleted
			if restoreErr == nil {
				if deleteStatus != http.StatusConflict {
					t.Fatalf("successfully restored document was deleted: key=%s HTTP %d", key, deleteStatus)
				}
				if _, err := s.loadDocument(context.Background(), key); err != nil {
					t.Fatalf("restored document disappeared: %v", err)
				}
			} else if !errors.Is(restoreErr, sql.ErrNoRows) || deleteStatus != http.StatusOK {
				t.Fatalf("unexpected restore/delete outcome: %v / HTTP %d", restoreErr, deleteStatus)
			}
		}
	}
}
