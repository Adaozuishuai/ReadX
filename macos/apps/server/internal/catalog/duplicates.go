// Package catalog 的 duplicates.go：移植旧版 windows/src/core/paper.ts 的论文身份识别与去重。
//
// 去重必须索引化（TS 注释）：O(n²) 在数百篇时会让首页渲染卡顿；这里保留索引版本，
// 语义与 sameEntry 完全一致。合并时「已有值优先、缺失才补」，绝不覆盖手工维护的元数据。
package catalog

import (
	"regexp"
	"strings"
	"unicode"
)

var (
	arxivPrefixes   = []string{"https://arxiv.org/abs/", "http://arxiv.org/abs/", "https://arxiv.org/pdf/", "arxiv:"}
	trailingVersion = regexp.MustCompile(`v[0-9]+$`)
	innerSpace      = regexp.MustCompile(`\s+`)
	doiPrefix       = regexp.MustCompile(`(?i)^https?://doi\.org/|^doi:`)
)

// ArxivKey 与 TS arxivKey 逐条对应：去前缀、去 .pdf、去尾部版本号、去内部空白、转小写。
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

// DOIKey 与 TS doiKey 对应：顺序必须是 先 trim 再 replace（TS 就是先 trim），
// 因此 "doi: 10.x" 的键会保留替换后残留的前导空格。
func DOIKey(raw string) string {
	return doiPrefix.ReplaceAllString(strings.TrimSpace(strings.ToLower(raw)), "")
}

// TitleKey 与 TS titleKey 对应：只保留字母数字（Unicode 感知）。
func TitleKey(raw string) string {
	var out strings.Builder
	for _, ch := range strings.ToLower(raw) {
		if unicode.IsLetter(ch) || unicode.IsNumber(ch) {
			out.WriteRune(ch)
		}
	}
	return out.String()
}

// PaperIdentity 是身份识别所需的最小字段集。
type PaperIdentity struct {
	ID      string
	Arxiv   string
	DOI     string
	Title   string
	Authors []string
}

// EntryKey 与 TS entryKey 一致：有 arxiv 用规范化 arxiv，否则用 id。
func EntryKey(p PaperIdentity) string {
	if p.Arxiv != "" {
		return ArxivKey(p.Arxiv)
	}
	return p.ID
}

// SameEntry 与 TS sameEntry 一致：键相等即同一篇；否则继续比 arxiv、doi，
// 或标题（>20 字符）相同且作者有交集。注意 TS 只在键相等时提前返回 true，
// 键不等时**不返回 false** 而是继续后续判据。
func SameEntry(a, b PaperIdentity) bool {
	keyA, keyB := EntryKey(a), EntryKey(b)
	if keyA != "" && keyA == keyB {
		return true
	}
	if a.Arxiv != "" && b.Arxiv != "" && ArxivKey(a.Arxiv) == ArxivKey(b.Arxiv) {
		return true
	}
	if a.DOI != "" && b.DOI != "" && DOIKey(a.DOI) == DOIKey(b.DOI) {
		return true
	}
	title := TitleKey(a.Title)
	if len([]rune(title)) > 20 && title == TitleKey(b.Title) {
		aa := map[string]bool{}
		for _, author := range a.Authors {
			aa[TitleKey(author)] = true
		}
		ba := map[string]bool{}
		for _, author := range b.Authors {
			ba[TitleKey(author)] = true
		}
		if len(aa) == 0 || len(ba) == 0 {
			return false
		}
		for key := range aa {
			if ba[key] {
				return true
			}
		}
	}
	return false
}

// DuplicateGroup 是一组互为重复的论文（以首次出现的下标为准，含全部成员）。
type DuplicateGroup struct {
	// PrimaryIndex 是保留项在原始输入里的下标。
	PrimaryIndex int
	// MemberIndexes 是全部成员（含 primary）在原始输入里的下标。
	MemberIndexes []int
}

// FindDuplicates 与 TS deduplicate 的匹配逻辑一致，但只报告重复组，不改写数据。
// 返回的组按首次出现顺序排列，组内按原顺序排列。
func FindDuplicates(papers []PaperIdentity) []DuplicateGroup {
	// 归一化后的表示：arxiv/doi 去前缀版本号后进索引。
	normalized := make([]PaperIdentity, len(papers))
	for i, p := range papers {
		normalized[i] = p
		if p.Arxiv != "" {
			normalized[i].Arxiv = ArxivKey(p.Arxiv)
		}
		if p.DOI != "" {
			normalized[i].DOI = DOIKey(p.DOI)
		}
	}

	type slot struct {
		primary int
		members []int
	}
	groups := map[int]*slot{}
	keyIndex := map[string]int{}
	arxivIndex := map[string]int{}
	doiIndex := map[string]int{}
	titleIndex := map[string][]int{}
	var order []int

	reindex := func(index int) {
		match, ok := groups[index]
		primary := index
		if ok {
			primary = match.primary
		}
		p := normalized[primary]
		keyIndex[EntryKey(p)] = primary
		if p.Arxiv != "" {
			arxivIndex[p.Arxiv] = primary
		}
		if p.DOI != "" {
			doiIndex[p.DOI] = primary
		}
	}

	for i, p := range normalized {
		if EntryKey(p) == "" {
			continue // 空键条目 TS 也会跳过
		}
		match := -1
		if index, ok := keyIndex[EntryKey(p)]; ok {
			match = index
		}
		if match < 0 && p.Arxiv != "" {
			if index, ok := arxivIndex[p.Arxiv]; ok {
				match = index
			}
		}
		if match < 0 && p.DOI != "" {
			if index, ok := doiIndex[p.DOI]; ok {
				match = index
			}
		}
		if match < 0 {
			title := TitleKey(p.Title)
			if len([]rune(title)) > 20 {
				for _, candidate := range titleIndex[title] {
					if sameAuthors(normalized[candidate].Authors, p.Authors) {
						match = candidate
						break
					}
				}
			}
		}

		if match >= 0 {
			groups[match].members = append(groups[match].members, i)
			reindex(match)
			continue
		}

		title := TitleKey(p.Title)
		if len([]rune(title)) > 20 {
			titleIndex[title] = append(titleIndex[title], i)
		}
		groups[i] = &slot{primary: i, members: []int{i}}
		order = append(order, i)
		reindex(i)
	}

	out := []DuplicateGroup{}
	for _, primary := range order {
		group := groups[primary]
		if len(group.members) < 2 {
			continue
		}
		out = append(out, DuplicateGroup{PrimaryIndex: group.primary, MemberIndexes: group.members})
	}
	return out
}

func sameAuthors(a, b []string) bool {
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	set := map[string]bool{}
	for _, author := range a {
		set[TitleKey(author)] = true
	}
	for _, author := range b {
		if set[TitleKey(author)] {
			return true
		}
	}
	return false
}
