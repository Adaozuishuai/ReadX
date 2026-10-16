package legacy

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Entry 是 queue.json 里的一篇论文。字段全部可选：旧文件里 id / arxiv / published / year
// 都可能出现或缺失，导入器必须容错而不是解包失败。
type Entry struct {
	ID        string   `json:"id"`
	Arxiv     string   `json:"arxiv"`
	DOI       string   `json:"doi"`
	Title     string   `json:"title"`
	Authors   []string `json:"authors"`
	Venue     string   `json:"venue"`
	Published string   `json:"published"`
	Year      string   `json:"year"`
	Abstract  string   `json:"abstract"`
	Why       string   `json:"why"`
	Source    string   `json:"source"`
	PDFURL    string   `json:"pdfUrl"`
	URL       string   `json:"url"`

	// raw 保留原始 JSON，导入时原样写进 documents.raw_json，
	// 这样 v2 后续加字段不必回头再读旧文件。
	raw map[string]any
}

func (e Entry) Raw() map[string]any { return e.raw }

// queueFileShape 兼容两种历史写法：顶层数组，或 {"papers": [...]}。
type queueFileShape struct {
	Papers []map[string]any `json:"papers"`
}

var (
	arxivPrefixes = []string{
		"https://arxiv.org/abs/", "http://arxiv.org/abs/",
		"https://arxiv.org/pdf/", "arxiv:",
	}
	trailingVersion = regexp.MustCompile(`v[0-9]+$`)
	innerSpace      = regexp.MustCompile(`\s+`)
	doiPrefix       = regexp.MustCompile(`(?i)^https?://doi\.org/|^doi:`)
)

// ArxivKey 与旧版 core/paper.ts 的 arxivKey 逐条对应：去前缀、去 .pdf、去尾部版本号、去空白、转小写。
func ArxivKey(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	for _, prefix := range arxivPrefixes {
		if strings.HasPrefix(s, prefix) {
			s = s[len(prefix):]
		}
	}
	s = strings.TrimSuffix(s, ".pdf")
	s = trailingVersion.ReplaceAllString(s, "")
	return innerSpace.ReplaceAllString(s, "")
}

// DOIKey 对应旧版 doiKey。
func DOIKey(raw string) string {
	return strings.TrimSpace(doiPrefix.ReplaceAllString(strings.ToLower(raw), ""))
}

// Key 对应旧版 entryKey：有 arxiv 用规范化 arxiv，否则用 id；两者都没有返回 ""（调用方须拒绝入库）。
func (e Entry) Key() string {
	if e.Arxiv != "" {
		return ArxivKey(e.Arxiv)
	}
	return strings.TrimSpace(e.ID)
}

// ReadQueue 解析 queue.json。文件不存在视为空队列（新机器上 v2 先跑起来再说），
// 但 JSON 损坏必须报错——静默当空队列会让导入器以为「论文全被删了」。
func ReadQueue(path string) ([]Entry, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取 queue.json 失败: %w", err)
	}
	var asObject queueFileShape
	if err := json.Unmarshal(body, &asObject); err == nil && asObject.Papers != nil {
		return toEntries(asObject.Papers)
	}
	var asArray []map[string]any
	if err := json.Unmarshal(body, &asArray); err != nil {
		return nil, fmt.Errorf("queue.json 不是合法的队列 JSON（既不是数组也没有 papers）: %w", err)
	}
	return toEntries(asArray)
}

// toEntries 逐字段宽容取值，而不是让 encoding/json 严格匹配类型：
// 旧文件里 year 既可能是 "2021" 也可能是 2024，authors 既可能是数组也可能是 "X, Y"。
// 严格解码会让整批导入失败，用户看到的只是「库里没有论文」。
func toEntries(rows []map[string]any) ([]Entry, error) {
	out := make([]Entry, 0, len(rows))
	for index, row := range rows {
		if row == nil {
			return nil, fmt.Errorf("第 %d 条队列项不是 JSON 对象", index+1)
		}
		entry := Entry{
			ID:        stringField(row, "id"),
			Arxiv:     stringField(row, "arxiv"),
			DOI:       stringField(row, "doi"),
			Title:     stringField(row, "title"),
			Venue:     stringField(row, "venue"),
			Published: stringField(row, "published"),
			Year:      stringField(row, "year"),
			Abstract:  stringField(row, "abstract"),
			Why:       stringField(row, "why"),
			Source:    stringField(row, "source"),
			PDFURL:    stringField(row, "pdfUrl"),
			URL:       stringField(row, "url"),
			Authors:   stringSliceField(row, "authors"),
			raw:       row,
		}
		out = append(out, entry)
	}
	return out, nil
}

func stringField(row map[string]any, key string) string {
	switch value := row[key].(type) {
	case string:
		return value
	case float64:
		// year 写成数字时按整数还原，避免 "2024" 变成 "2.4e+03"。
		return strconv.FormatInt(int64(value), 10)
	default:
		return ""
	}
}

func stringSliceField(row map[string]any, key string) []string {
	switch value := row[key].(type) {
	case nil:
		return nil
	case []string:
		return value
	case []any:
		out := make([]string, 0, len(value))
		for _, item := range value {
			if text := stringField(map[string]any{"v": item}, "v"); text != "" {
				out = append(out, text)
			}
		}
		return out
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return nil
		}
		parts := strings.Split(trimmed, ",")
		for index, part := range parts {
			parts[index] = strings.TrimSpace(part)
		}
		return parts
	default:
		return nil
	}
}

// ResolvedYear 优先 published 的四位年份，其次 year 字段（旧文件里 year 是字符串）。
func (e Entry) ResolvedYear() int {
	for _, candidate := range []string{e.Published, e.Year} {
		if digits := leadingYear(candidate); digits > 0 {
			return digits
		}
	}
	return 0
}

func leadingYear(value string) int {
	value = strings.TrimSpace(value)
	if len(value) < 4 {
		return 0
	}
	digits := make([]byte, 0, 4)
	for _, r := range value {
		if r < '0' || r > '9' {
			break
		}
		digits = append(digits, byte(r))
		if len(digits) == 4 {
			break
		}
	}
	if len(digits) != 4 {
		return 0
	}
	var year int
	for _, digit := range digits {
		year = year*10 + int(digit-'0')
	}
	return year
}
