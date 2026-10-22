// stats.go：书库与阅读统计。
//
// 只报「确定数据」，不报「推算时长」：
//   - 页面停留时长需要前台心跳，目前没有采集，所以这里不出现「读了多久」。
//   - 处理耗时用任务里盖过章的时间戳（JobStage.StartedAt/FinishedAt、JobRun 起止）。
//     老任务没有阶段时间戳 —— 那部分单独计数并在界面写明，不用总耗时去摊派。
//
// 所有口径都写进 basis 一起返回：统计页最容易骗人的地方就是不说清口径。
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// stageStats 是一个阶段的耗时汇总（毫秒）。
type stageStats struct {
	Key        string `json:"key"`
	Label      string `json:"label"`
	Runs       int    `json:"runs"`
	TotalMs    int64  `json:"totalMs"`
	MedianMs   int64  `json:"medianMs"`
	MaxMs      int64  `json:"maxMs"`
	PerPageMs  *int64 `json:"perPageMs,omitempty"`
}

type namedCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	library, err := s.libraryStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	reading, err := s.readingStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	processing, err := s.processingStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	distribution, err := s.distributionStats(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"library":      library,
		"reading":      reading,
		"processing":   processing,
		"distribution": distribution,
		"basis": []string{
			"阅读活跃度按每篇论文最近一次阅读位置的时间归入最近 7 天 / 30 天；数据库只保留最新位置，因此是「最近在读」而不是完整阅读流水。",
			"处理耗时来自任务阶段自己盖的时间戳；转「已完成」时由 setStage 统一盖章。",
			"主题分布按题录关键词聚合，样本不足时只报计数、不下趋势判断。",
		},
	})
}

// libraryStats 统计书库规模与阅读状态。
func (s *Server) libraryStats(ctx context.Context) (map[string]any, error) {
	byStatus := map[string]int{}
	total := 0
	// 状态桶只统计未删除的论文：面板上「正在阅读 N 篇」旁边的分母是「在库 M 篇」，
	// 把回收站里的算进来会让这两个数字对不上（回收站另有单独计数）。
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, err
	}
	err = func() error {
		rows, err := s.handle.QueryContext(ctx, `SELECT id, status FROM documents`)
		if err != nil {
			return fmt.Errorf("统计阅读状态失败: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key, status string
			if err := rows.Scan(&key, &status); err != nil {
				return fmt.Errorf("解析阅读状态失败: %w", err)
			}
			total++
			if meta[key].Deleted {
				continue
			}
			byStatus[status]++
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, err
	}

	favorite, trashed := 0, 0
	for _, item := range meta {
		if item.Deleted {
			trashed++
			continue
		}
		if item.Favorite {
			favorite++
		}
	}
	shelves := 0
	if categories, err := s.loadCategories(ctx); err == nil {
		shelves = len(categories)
	}
	return map[string]any{
		"total":    total,
		"active":   total - trashed,
		"queue":    byStatus["queue"],
		"reading":  byStatus["reading"],
		"done":     byStatus["done"],
		"archive":  byStatus["archive"],
		"favorite": favorite,
		"trashed":  trashed,
		"shelves":  shelves,
	}, nil
}

// readingStats 统计阅读活跃度、批注与精读产出。
func (s *Server) readingStats(ctx context.Context) (map[string]any, error) {
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	weekAgo := now.AddDate(0, 0, -7)
	monthAgo := now.AddDate(0, 0, -30)

	located, activeWeek, activeMonth := 0, 0, 0
	rows, err := s.handle.QueryContext(ctx, `SELECT document_id, updated_at FROM reading_locations`)
	if err != nil {
		return nil, fmt.Errorf("统计阅读位置失败: %w", err)
	}
	func() {
		defer rows.Close()
		for rows.Next() {
			var key, updatedAt string
			if scanErr := rows.Scan(&key, &updatedAt); scanErr != nil {
				continue
			}
			if meta[key].Deleted {
				continue
			}
			located++
			stamp, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(updatedAt))
			if parseErr != nil {
				continue
			}
			if stamp.After(weekAgo) {
				activeWeek++
			}
			if stamp.After(monthAgo) {
				activeMonth++
			}
		}
	}()

	annotations, annotationsMonth := 0, 0
	annotationRows, err := s.handle.QueryContext(ctx, `SELECT document_id, created_at FROM annotations`)
	if err != nil {
		return nil, fmt.Errorf("统计批注失败: %w", err)
	}
	func() {
		defer annotationRows.Close()
		for annotationRows.Next() {
			var key, createdAt string
			if scanErr := annotationRows.Scan(&key, &createdAt); scanErr != nil {
				continue
			}
			if meta[key].Deleted {
				continue
			}
			annotations++
			if stamp, parseErr := time.Parse(time.RFC3339, strings.TrimSpace(createdAt)); parseErr == nil && stamp.After(monthAgo) {
				annotationsMonth++
			}
		}
	}()

	readingNotes := 0
	if err := s.handle.QueryRowContext(ctx, `SELECT COUNT(*) FROM readings`).Scan(&readingNotes); err != nil {
		return nil, fmt.Errorf("统计精读记录失败: %w", err)
	}
	indexedDocuments, indexedPages := 0, 0
	if err := s.handle.QueryRowContext(ctx,
		`SELECT COUNT(DISTINCT document_id), COUNT(*) FROM document_pages WHERE length(text) > 0`).
		Scan(&indexedDocuments, &indexedPages); err != nil {
		return nil, fmt.Errorf("统计正文索引失败: %w", err)
	}

	return map[string]any{
		"located":           located,
		"activeWeek":        activeWeek,
		"activeMonth":       activeMonth,
		"annotations":       annotations,
		"annotationsMonth":  annotationsMonth,
		"readingNotes":      readingNotes,
		"indexedDocuments":  indexedDocuments,
		"indexedPages":      indexedPages,
	}, nil
}

// processingStats 汇总各阶段耗时。
//
// Runs 里是最近 10 次执行摘要、Stages 只保留最近一次任务的阶段时间戳，
// 所以这是「最近这批处理」的画像，不是全部历史。
func (s *Server) processingStats(ctx context.Context) (map[string]any, error) {
	jobs, err := s.loadDocumentJobs(ctx)
	if err != nil {
		return nil, err
	}

	totalRuns, failedRuns, pages := 0, 0, 0
	runDurations := []int64{}
	perStage := map[string][]int64{}
	labels := map[string]string{}
	missingStageTiming := 0
	type slowEntry struct {
		Key   string `json:"key"`
		Title string `json:"title"`
		Stage string `json:"stage"`
		Ms    int64  `json:"ms"`
	}
	slowest := []slowEntry{}
	titles := map[string]string{}
	for _, job := range jobs {
		titles[job.Key] = job.Name
		for _, stage := range job.Stages {
			if stage.StartedAt != "" && stage.FinishedAt == "" {
				missingStageTiming++
				break
			}
		}
		for _, stage := range job.Stages {
			if stage.StartedAt == "" || stage.FinishedAt == "" {
				continue
			}
			ms, ok := stampDeltaMs(stage.StartedAt, stage.FinishedAt)
			if !ok {
				continue
			}
			perStage[stage.Key] = append(perStage[stage.Key], ms)
			labels[stage.Key] = stage.Label
			slowest = append(slowest, slowEntry{Key: job.Key, Title: job.Name, Stage: stage.Key, Ms: ms})
		}
		for _, run := range job.Runs {
			totalRuns++
			pages += run.Pages
			if run.Status == "failed" {
				failedRuns++
			}
			if ms, ok := stampDeltaMs(run.StartedAt, run.FinishedAt); ok {
				runDurations = append(runDurations, ms)
			}
		}
	}

	stages := []stageStats{}
	keys := make([]string, 0, len(perStage))
	for key := range perStage {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		values := perStage[key]
		total := int64(0)
		maxValue := int64(0)
		for _, value := range values {
			total += value
			if value > maxValue {
				maxValue = value
			}
		}
		item := stageStats{
			Key: key, Label: labels[key], Runs: len(values),
			TotalMs: total, MedianMs: medianMs(values), MaxMs: maxValue,
		}
		if pages > 0 {
			perPage := total / int64(pages)
			item.PerPageMs = &perPage
		}
		stages = append(stages, item)
	}

	sort.SliceStable(slowest, func(i, j int) bool { return slowest[i].Ms > slowest[j].Ms })
	if len(slowest) > 5 {
		slowest = slowest[:5]
	}

	return map[string]any{
		"jobs":               len(jobs),
		"runs":               totalRuns,
		"failedRuns":         failedRuns,
		"pages":              pages,
		"stages":             stages,
		"slowest":            slowest,
		"missingStageTiming": missingStageTiming,
		"totalRunMs":         sumMs(runDurations),
		"medianRunMs":        medianMs(runDurations),
	}, nil
}

// loadDocumentJobs 读出已落盘的任务快照（每篇一份，含 ≤10 次执行摘要）。
// loadDocumentJobs 取用来做统计的任务快照。
//
// 任务有两处落盘，必须都读：
//   - import-job:<任务编号>：任务本体（persistImportJob 写的就是这里）；
//   - import-job-document:<文档key>：文档到任务的**索引**。现代流程写的是任务编号字符串
//     （linkImportJobDocument），旧数据可能是一整个任务对象。
//
// 只读后者会漏掉全部现代任务：字符串解析成结构体必然失败，然后被当成「坏快照」跳过——
// 结果就是统计里一个阶段耗时都没有。同一任务在两处都出现时只算一次（按任务编号去重，
// 先读任务本体，保证以它为准）。
func (s *Server) loadDocumentJobs(ctx context.Context) ([]DocumentJob, error) {
	out := []DocumentJob{}
	seen := map[string]bool{}
	read := func(prefix string) error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT key, value_json FROM app_state WHERE key LIKE ?`, prefix+"%")
		if err != nil {
			return fmt.Errorf("读取处理任务失败: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var key, body string
			if err := rows.Scan(&key, &body); err != nil {
				return fmt.Errorf("解析处理任务失败: %w", err)
			}
			var job DocumentJob
			if err := json.Unmarshal([]byte(body), &job); err != nil {
				// 索引里的任务编号字符串、以及坏掉的快照：都不是任务本体，跳过。
				continue
			}
			identity := job.Key
			if identity == "" {
				identity = strings.TrimPrefix(key, prefix)
			}
			if seen[identity] {
				continue
			}
			seen[identity] = true
			if job.Key == "" {
				job.Key = identity
			}
			out = append(out, job)
		}
		return rows.Err()
	}
	if err := read(jobStatePrefix); err != nil {
		return nil, err
	}
	if err := read(jobDocumentPrefix); err != nil {
		return nil, err
	}
	return out, nil
}

// distributionStats 年份 / 书架 / 标签分布：都是库里的确定字段，不含推断。
func (s *Server) distributionStats(ctx context.Context) (map[string]any, error) {
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		return nil, err
	}
	years := []namedCount{}
	err = func() error {
		rows, err := s.handle.QueryContext(ctx,
			`SELECT year, COUNT(*) FROM documents WHERE year IS NOT NULL AND year > 0 GROUP BY year ORDER BY year DESC`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var year, count int
			if err := rows.Scan(&year, &count); err != nil {
				return err
			}
			years = append(years, namedCount{Name: fmt.Sprintf("%d", year), Count: count})
		}
		return rows.Err()
	}()
	if err != nil {
		return nil, fmt.Errorf("统计年份分布失败: %w", err)
	}

	shelfCount := map[string]int{}
	tagCount := map[string]int{}
	for _, item := range meta {
		if item.Deleted {
			continue
		}
		for _, name := range item.Categories {
			shelfCount[name]++
		}
		for _, tag := range item.Tags {
			tagCount[tag]++
		}
	}
	return map[string]any{
		"years":  years,
		"shelves": topCounts(shelfCount, 12),
		"tags":    topCounts(tagCount, 12),
	}, nil
}

// topCounts 按数量倒序、同数量按名字升序，最多取 limit 项。
func topCounts(source map[string]int, limit int) []namedCount {
	out := make([]namedCount, 0, len(source))
	for name, count := range source {
		out = append(out, namedCount{Name: name, Count: count})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Name < out[j].Name
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

func stampDeltaMs(start, end string) (int64, bool) {
	from, err := time.Parse(time.RFC3339, strings.TrimSpace(start))
	if err != nil {
		return 0, false
	}
	to, err := time.Parse(time.RFC3339, strings.TrimSpace(end))
	if err != nil {
		return 0, false
	}
	delta := to.Sub(from).Milliseconds()
	if delta < 0 {
		return 0, false
	}
	return delta, true
}

func sumMs(values []int64) int64 {
	total := int64(0)
	for _, value := range values {
		total += value
	}
	return total
}

func medianMs(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}