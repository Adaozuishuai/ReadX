package httpapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

// calendar.go：阅读日历。
//
// 数据来源与**诚实边界**：
//   - reading_locations 每篇文档只保留一行（PRIMARY KEY(document_id) + ON CONFLICT DO UPDATE），
//     所以它只能告诉我们「这篇最后一次读到哪、什么时候读的」，**不是完整的阅读流水**。
//   - readings（按 kind 存精读条目）与 annotations 也各带时间戳，同样只有最新状态。
//   - 因此日历的口径是：**一篇论文出现在它最近一次被阅读的那一天**。
//     标题里写清楚这一点，比画一个月度热力图却让人误以为是完整历史要好。
//
// 不新增表、不改迁移：这一版只做聚合，写入侧不动。

// calendarPaper 是某一天里的一篇论文。
type calendarPaper struct {
	Key       string `json:"key"`
	Title     string `json:"title"`
	Format    string `json:"format"`
	Page      int    `json:"page,omitempty"`
	UpdatedAt string `json:"updatedAt"`
	// 该篇在这天是否有精读条目 / 批注，供日历上的小圆点区分"翻过"与"读过"。
	HasReading    bool `json:"hasReading"`
	HasAnnotation bool `json:"hasAnnotation"`
}

// calendarDay 是日历里的一天。
type calendarDay struct {
	Date   string          `json:"date"`
	Count  int             `json:"count"`
	Papers []calendarPaper `json:"papers"`
}

// calendarPayload 是 GET /v1/calendar 的响应。
type calendarPayload struct {
	// Days 只包含有阅读记录的日子（不补零），前端按需铺整个月。
	Days []calendarDay `json:"days"`
	// TotalPapers 是"有阅读位置记录"的论文数，方便前端说明覆盖面。
	TotalPapers int `json:"totalPapers"`
	// Basis 说明口径，直接展示给用户，避免误解为完整历史。
	Basis string `json:"basis"`
}

// dayKey 把 RFC3339 时间戳截成**本地日期**。
//
// 用本地时区而不是 UTC：日历是给人看的，"今天读的"应当按用户所在时区归属，
// 否则晚上读的东西会掉到前一天。
func dayKey(stamp string) string {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(stamp))
	if err != nil {
		return ""
	}
	return t.Local().Format("2006-01-02")
}

func (s *Server) handleCalendar(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	// 阅读位置：每篇一行，含最后阅读时间。
	// 回收站标记不在 documents 表里，而在 app_state('documents.meta') 的 Deleted 字段，
	// 所以先取一份元数据，逐篇过滤。
	meta, err := s.loadAllMeta(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	rows, err := s.handle.QueryContext(ctx, `
		SELECT l.document_id, l.location_json, l.updated_at,
		       d.title, d.format
		FROM reading_locations l
		JOIN documents d ON d.id = l.document_id`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "读取阅读记录失败: "+err.Error())
		return
	}
	defer rows.Close()

	byDay := map[string][]calendarPaper{}
	papers := 0
	for rows.Next() {
		var key, raw, updatedAt, title, format string
		if err := rows.Scan(&key, &raw, &updatedAt, &title, &format); err != nil {
			writeError(w, http.StatusInternalServerError, "解析阅读记录失败: "+err.Error())
			return
		}
		// 回收站里的论文不进日历：它已经不占阅读列表了。
		if meta[key].Deleted {
			continue
		}
		day := dayKey(updatedAt)
		if day == "" {
			continue
		}
		papers++
		page := 0
		var loc struct {
			Kind string `json:"kind"`
			Page int    `json:"page"`
		}
		if jsonErr := json.Unmarshal([]byte(raw), &loc); jsonErr == nil && loc.Kind == "pdf" {
			page = loc.Page
		}
		byDay[day] = append(byDay[day], calendarPaper{
			Key: key, Title: title, Format: format, Page: page, UpdatedAt: updatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusInternalServerError, "遍历阅读记录失败: "+err.Error())
		return
	}

	// 精读条目：readings 表按 document_id 存一份 value_json，取它的 updated_at 作为"读过"的信号。
	readingDays := map[string]bool{}
	if markRows, err := s.handle.QueryContext(ctx,
		`SELECT document_id, updated_at FROM readings`); err == nil {
		for markRows.Next() {
			var key, updatedAt string
			if scanErr := markRows.Scan(&key, &updatedAt); scanErr == nil {
				if day := dayKey(updatedAt); day != "" {
					readingDays[key+"|"+day] = true
				}
			}
		}
		markRows.Close()
	}

	// 批注：annotations.created_at 同样按天标记。
	annotationDays := map[string]bool{}
	if markRows, err := s.handle.QueryContext(ctx,
		`SELECT document_id, created_at FROM annotations`); err == nil {
		for markRows.Next() {
			var key, createdAt string
			if scanErr := markRows.Scan(&key, &createdAt); scanErr == nil {
				if day := dayKey(createdAt); day != "" {
					annotationDays[key+"|"+day] = true
				}
			}
		}
		markRows.Close()
	}

	days := make([]calendarDay, 0, len(byDay))
	for date, list := range byDay {
		sort.SliceStable(list, func(a, b int) bool { return list[a].UpdatedAt > list[b].UpdatedAt })
		for i := range list {
			list[i].HasReading = readingDays[list[i].Key+"|"+date]
			list[i].HasAnnotation = annotationDays[list[i].Key+"|"+date]
		}
		days = append(days, calendarDay{Date: date, Count: len(list), Papers: list})
	}
	sort.Slice(days, func(a, b int) bool { return days[a].Date < days[b].Date })

	writeJSON(w, http.StatusOK, calendarPayload{
		Days:        days,
		TotalPapers: papers,
		Basis:       "按每篇论文最近一次阅读的时间归入当天；数据库只保留最新阅读位置，因此不是完整历史。",
	})
}
