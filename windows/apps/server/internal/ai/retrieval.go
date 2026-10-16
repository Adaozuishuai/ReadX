package ai

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"cbctv2/server/internal/validate"
)

// 本文件移植旧版 core/evidence.ts 的材料选择部分：超长论文按相关性选页，
// 并且**如实披露这是子集**（PRD 12.1）——不披露就会让模型凭子集断言「论文没有该内容」。

var figureCaption = regexp.MustCompile(`(?i)^\s*(fig\.?|figure)\s*[0-9]+`)
var sectionHeading = regexp.MustCompile(`(?i)^([0-9]+[. ]+|[a-z][. ]+)?(introduction|related work|background|method|methods|methodology|approach|experiment|experiments|experimental|results|discussion|conclusion|references|bibliography|appendix|supplementary)\b`)
var referencesHeading = regexp.MustCompile(`(?i)^(references|bibliography|[0-9]+[. ]+references)\b`)
var wordSplit = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// ScopedPages 对应旧版 scopedPages：按 scope 只保留相关章节的行。
func ScopedPages(text, scope string) []validate.Page {
	if scope == "Figure" {
		out := []validate.Page{}
		for _, page := range validate.Pages(text) {
			lines := strings.Split(page.Text, "\n")
			captions := []string{}
			for i, line := range lines {
				if figureCaption.MatchString(line) {
					end := i + 5
					if end > len(lines) {
						end = len(lines)
					}
					captions = append(captions, lines[i:end]...)
				}
			}
			if len(captions) > 0 {
				out = append(out, validate.Page{Number: page.Number, Text: strings.Join(captions, "\n")})
			}
		}
		return out
	}

	active := false
	out := []validate.Page{}
	for _, page := range validate.Pages(text) {
		lines := []string{}
		for _, line := range strings.Split(page.Text, "\n") {
			heading := strings.ToLower(strings.TrimSpace(line))
			if sectionHeading.MatchString(heading) {
				// References 对任何 scope 都强制关闭：否则 Method/Experiment 会把参考文献整段吸进证据范围。
				if referencesHeading.MatchString(heading) {
					active = false
					continue
				}
				switch scope {
				case "Method":
					active = strings.Contains(heading, "method") || strings.Contains(heading, "approach")
				case "Experiment":
					active = strings.Contains(heading, "experiment") || strings.Contains(heading, "results")
				case "Appendix":
					active = strings.Contains(heading, "appendix") || strings.Contains(heading, "supplementary")
				default:
					active = false
				}
			}
			if active {
				lines = append(lines, line)
			}
		}
		if len(lines) > 0 {
			out = append(out, validate.Page{Number: page.Number, Text: strings.Join(lines, "\n")})
		}
	}
	return out
}

// SelectResult 对应旧版 SelectResult。
type SelectResult struct {
	Text     string
	Included int
	Total    int
}

var scopeTerms = map[string]string{
	"Method":     "method architecture equation geometry",
	"Experiment": "experiment dataset training results",
	"Appendix":   "appendix supplementary",
	"Figure":     "figure fig caption",
}

// SelectWithMeta 对应旧版 selectWithMeta：按相关性打分选页，直到装满 limit。
func SelectWithMeta(text, query, scope string, limit int) SelectResult {
	all := validate.Pages(text)
	if scope != "全文" {
		all = ScopedPages(text, scope)
	}
	if len(all) == 0 {
		return SelectResult{}
	}
	if len(text) <= limit && scope == "全文" {
		return SelectResult{Text: text, Included: len(all), Total: len(all)}
	}

	terms := strings.ToLower(query + " " + scopeTerms[scope])
	keywords := []string{}
	for _, word := range wordSplit.Split(terms, -1) {
		if len([]rune(word)) > 2 {
			keywords = append(keywords, word)
		}
	}

	type scoredPage struct {
		page  validate.Page
		score int
	}
	scored := make([]scoredPage, 0, len(all))
	for _, page := range all {
		low := strings.ToLower(page.Text)
		score := 0
		for _, term := range keywords {
			if strings.Contains(low, term) {
				score++
			}
		}
		scored = append(scored, scoredPage{page: page, score: score})
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score == scored[j].score {
			return scored[i].page.Number < scored[j].page.Number
		}
		return scored[i].score > scored[j].score
	})

	picked := []validate.Page{}
	used := 0
	for _, item := range scored {
		if used+len(item.page.Text)+30 > limit {
			continue
		}
		picked = append(picked, item.page)
		used += len(item.page.Text) + 30
	}
	sort.Slice(picked, func(i, j int) bool { return picked[i].Number < picked[j].Number })
	blocks := make([]string, 0, len(picked))
	for _, page := range picked {
		blocks = append(blocks, fmt.Sprintf("=== Page %d ===\n%s", page.Number, page.Text))
	}
	return SelectResult{Text: strings.Join(blocks, "\n\n"), Included: len(picked), Total: len(all)}
}

// ScopingNote 对应旧版 scopingNote：included < total 时必须披露材料是子集。
func ScopingNote(r SelectResult) string {
	if r.Text == "" || r.Included >= r.Total {
		return r.Text
	}
	numbers := []string{}
	for _, page := range validate.Pages(r.Text) {
		numbers = append(numbers, strconv.Itoa(page.Number))
	}
	return "【材料范围】以下仅包含按相关性从全文中选取的 " +
		fmt.Sprintf("%d/%d", r.Included, r.Total) + " 页（页码：" + strings.Join(numbers, "、") +
		"）。未包含的页面同样属于论文：涉及这些页面的信息应回答「论文中未找到（当前证据未覆盖，可扩大范围重试）」，" +
		"不得仅凭本子集断言论文没有该内容。\n\n" + r.Text
}

// PrepareMaterial 对应旧版 preparePaperMaterial，含两条「不做事实分析」的硬约束：
// 没有全文缓存就拒绝；该 scope 在本篇选不出任何内容也拒绝——
// 否则会把空材料交给模型，模型凭记忆作答等于绕过硬约束。
func PrepareMaterial(text, question, scope string) (material string, included, total int, err error) {
	if strings.TrimSpace(text) == "" {
		return "", 0, 0, fmt.Errorf("还没有该论文的全文缓存，请先完成 PDF 文本抽取")
	}
	result := SelectWithMeta(text, question, orFull(scope), 50000)
	note := ScopingNote(result)
	if strings.TrimSpace(note) == "" {
		return "", 0, 0, fmt.Errorf("「%s」范围在本篇论文的全文缓存中没有选到任何内容（论文可能没有该章节）。请改用「全文」范围，或先确认 PDF 文本已抽取。", scope)
	}
	return note, result.Included, result.Total, nil
}

func orFull(scope string) string {
	if strings.TrimSpace(scope) == "" {
		return "全文"
	}
	return scope
}
