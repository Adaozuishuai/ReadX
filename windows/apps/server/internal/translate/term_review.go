package translate

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	TermReviewPromptVersion = "term-review-v2"
	termReviewBatchSize     = 40
	termReviewWorkers       = 8
)

type termReviewDecision struct {
	Source   string `json:"source"`
	Category string `json:"category"`
	Target   string `json:"target"`
	Annotate bool   `json:"annotate"`
}

type termReviewResponse struct {
	Terms []termReviewDecision `json:"terms"`
}

type timedTermReviewGenerator interface {
	GenerateStructuredWithTimeout(context.Context, string, string, float64, time.Duration, any) (string, error)
}

// ReviewDocumentTerms implements RetainPDF's editorial preparation stage.
// Missing decisions retain the pre-scan lock behavior and make the artifact
// incomplete so a later run retries review instead of freezing a partial base.
func ReviewDocumentTerms(ctx context.Context, generator Generator, items []Item, terms []Term, domain, targetLanguage string) ([]Term, error) {
	reviewItems := collectPrescanSegments(items)
	candidates := make([]Term, 0, len(terms))
	for _, term := range terms {
		if strings.HasPrefix(term.Note, "document_term_prescan:") {
			candidates = append(candidates, term)
		}
	}
	if len(candidates) == 0 {
		return candidates, nil
	}
	termSchema := map[string]any{
		"type": "object", "additionalProperties": false,
		"properties": map[string]any{
			"source":   map[string]string{"type": "string"},
			"category": map[string]any{"type": "string", "enum": []string{"technical", "person", "organization", "publication", "common"}},
			"target":   map[string]string{"type": "string"}, "annotate": map[string]string{"type": "boolean"},
		},
		"required": []string{"source", "category", "target", "annotate"},
	}
	schema := map[string]any{"type": "json_schema", "json_schema": map[string]any{
		"name": "term_review_response", "strict": true,
		"schema": map[string]any{
			"type": "object", "additionalProperties": false,
			"properties": map[string]any{"terms": map[string]any{"type": "array", "items": termSchema}},
			"required":   []string{"terms"},
		},
	}}
	system := `你是学术图书翻译项目的术语专员。预扫已经从原文里抽出一批候选术语和初步译法，你要逐条审定：它属于哪一类、要不要全书锁定译法、首次出现时要不要在译文里括注原文。

每条候选有：source（原文）、target（预扫给的译法）、kind（预扫的粗分类）、frequency（全书出现次数）、context（首次出现处的原文片段）。

分类（category）只能是下面五种之一：
- technical：本学科的专业术语或命名的定理、方法、方程、效应、算法，例如 "harmonic oscillator"、"virial theorem"、"Hartree–Fock method"。
- person：人名（包括只出现在参考文献、致谢、作者列表里的人名）。
- organization：机构、大学、出版社、公司、实验室。
- publication：期刊名、书名、论文题目、会议名及其缩写，例如 "J. Chem. Phys."、"Electron Distributions and the Chemical Bond"。
- common：不需要统一的普通词或泛学术词，例如 "result"、"approach"、"energy level diagram" 这类读者一看就懂、不会译歧的说法也算 common。

判断依据是 context：同一个词出现在参考文献条目里通常是 person 或 publication。章节标题、小节标题里的短语按它的含义归类（"Dipole Moments"、"Molecular Quantum Mechanics" 作标题时是 technical），不要因为首字母大写就判成 publication；只有明确是在引用某本书、某种期刊、某篇论文时才是 publication。拿不准是 technical 还是 common 时，看它在本学科里是否有固定译名、不统一是否会造成误解。

target：
- technical：给本学科通行的规范译名（优先全国科学技术名词审定委员会公布的名词）。预扫译法正确就原样返回；不正确就改正。
- person / organization / publication：原样返回 source（这几类不锁定中文译法）。
- common：原样返回预扫译法。

annotate（首次出现时是否在译文里括注原文，如「位力定理（virial theorem）」）：
- 只有 technical 才可能为 true：读者不熟悉、或中文译名不唯一、或原文缩写后文会用到的专业术语，填 true；基础概念（如 "wave function"、"energy"、"quantum mechanics"）填 false。
- 其余类别一律 false。

每条候选都要返回，source 必须与输入逐字一致。只返回严格 JSON：
{"terms": [{"source": "...", "category": "technical", "target": "...", "annotate": true}]}
不要输出 markdown、代码块或解释。`
	const contextChars = 120
	segments := make([]map[string]any, len(candidates))
	segmentsByID := make(map[string]Item, len(reviewItems))
	for _, item := range reviewItems {
		segmentsByID[item.ItemID] = item
	}
	for i, term := range candidates {
		frequency := term.Frequency
		context := ""
		if item, ok := segmentsByID[term.FirstOccurrenceID]; ok {
			context = termReviewContext(item.Source, term.Source, contextChars)
		}
		if context == "" {
			for _, item := range reviewItems {
				if strings.Contains(strings.ToLower(item.Source), strings.ToLower(term.Source)) {
					context = termReviewContext(item.Source, term.Source, contextChars)
					break
				}
			}
		}
		segments[i] = map[string]any{"source": term.Source, "target": term.Target, "kind": strings.TrimPrefix(term.Note, "document_term_prescan:"), "frequency": frequency, "context": context}
	}
	var batches [][]int
	for start := 0; start < len(candidates); start += termReviewBatchSize {
		end := start + termReviewBatchSize
		if end > len(candidates) {
			end = len(candidates)
		}
		batch := make([]int, end-start)
		for i := range batch {
			batch[i] = start + i
		}
		batches = append(batches, batch)
	}
	type result struct {
		decisions map[string]termReviewDecision
		err       error
	}
	results := make([]result, len(batches))
	semaphore := make(chan struct{}, termReviewWorkers)
	var workers sync.WaitGroup
	for batchIndex, indexes := range batches {
		workers.Add(1)
		go func(batchIndex int, indexes []int) {
			defer workers.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				results[batchIndex].err = ctx.Err()
				return
			}
			batchTerms := make([]map[string]any, 0, len(indexes))
			for _, index := range indexes {
				batchTerms = append(batchTerms, segments[index])
			}
			body, _ := json.Marshal(map[string]any{"domain": domain, "target_language": targetLanguage, "terms": batchTerms})
			var content string
			var generationErr error
			for attempt := 0; attempt < 2; attempt++ {
				if timed, ok := generator.(timedTermReviewGenerator); ok {
					content, generationErr = timed.GenerateStructuredWithTimeout(ctx, system, string(body), 0, 120*time.Second, schema)
				} else if structured, ok := generator.(termPrescanStructuredGenerator); ok {
					content, generationErr = structured.GenerateStructured(ctx, system, string(body), 0, schema)
				} else {
					content, generationErr = generator.Generate(ctx, system, string(body), 0)
				}
				if generationErr == nil {
					break
				}
			}
			if generationErr != nil {
				results[batchIndex].err = generationErr
				return
			}
			var parsed termReviewResponse
			if err := parseStructuredJSON(content, &parsed); err != nil {
				results[batchIndex].err = err
				return
			}
			decisions := make(map[string]termReviewDecision, len(parsed.Terms))
			for _, row := range parsed.Terms {
				row.Source = strings.TrimSpace(row.Source)
				row.Category = strings.ToLower(strings.TrimSpace(row.Category))
				row.Target = strings.TrimSpace(row.Target)
				if row.Source == "" {
					continue
				}
				switch row.Category {
				case "technical", "person", "organization", "publication", "common":
					decisions[strings.ToLower(row.Source)] = row
				}
			}
			results[batchIndex].decisions = decisions
		}(batchIndex, indexes)
	}
	workers.Wait()
	decisions := map[string]termReviewDecision{}
	var firstErr error
	for _, result := range results {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		for key, row := range result.decisions {
			decisions[key] = row
		}
	}
	approved := make([]Term, 0, len(candidates))
	missing := 0
	for _, term := range candidates {
		decision, ok := decisions[strings.ToLower(term.Source)]
		if !ok {
			missing++
			continue
		}
		term.Category = decision.Category
		term.ReviewStatus = "reviewed"
		term.Annotate = decision.Annotate && decision.Category == "technical"
		switch decision.Category {
		case "technical":
			term.Treatment = "lock"
			term.PrescanTarget = term.Target
			if validReviewedTarget(term.Source, decision.Target, targetLanguage) {
				term.Target = cleanPrescanTerm(decision.Target)
			}
		case "publication":
			term.Treatment, term.PrescanTarget, term.Target, term.Level = "keep_original", term.Target, term.Source, "preserve"
		case "person", "organization":
			term.Treatment = "free"
		case "common":
			term.Treatment = "drop"
		}
		approved = append(approved, term)
	}
	if missing > 0 && firstErr == nil {
		firstErr = fmt.Errorf("术语审定未覆盖 %d/%d 条候选", missing, len(candidates))
	}
	if firstErr != nil {
		// RetainPDF applies completed review decisions but leaves unreviewed candidates
		// at the pre-scan lock behavior and marks the artifact incomplete. Preserve
		// that safe fallback for this run; caller will avoid freezing it.
		combined := append(approved, unreviewedPrescanTerms(candidates, decisions)...)
		harmonizeReviewedTerms(combined)
		return combined, firstErr
	}
	harmonizeReviewedTerms(approved)
	return approved, nil
}

func termReviewContext(text, source string, radius int) string {
	position := strings.Index(strings.ToLower(text), strings.ToLower(source))
	if position < 0 {
		return limitRunes(text, radius*2)
	}
	startRune := utf8.RuneCountInString(text[:position]) - radius
	if startRune < 0 {
		startRune = 0
	}
	endByte := position + len(source)
	if endByte > len(text) {
		endByte = len(text)
	}
	endRune := utf8.RuneCountInString(text[:endByte]) + radius
	runes := []rune(text)
	if endRune > len(runes) {
		endRune = len(runes)
	}
	prefix, suffix := "", ""
	if startRune > 0 {
		prefix = "…"
	}
	if endRune < len(runes) {
		suffix = "…"
	}
	return prefix + string(runes[startRune:endRune]) + suffix
}

func unreviewedPrescanTerms(candidates []Term, decisions map[string]termReviewDecision) []Term {
	out := []Term{}
	for _, term := range candidates {
		if _, ok := decisions[strings.ToLower(term.Source)]; !ok {
			term.ReviewStatus = "unreviewed"
			term.Treatment = "lock"
			// RetainPDF treats missing annotate as true so an unreviewed
			// pre-scan lock retains its first-mention gloss behavior.
			term.Annotate = true
			out = append(out, term)
		}
	}
	return out
}

func validReviewedTarget(source, target, language string) bool {
	source = cleanPrescanTerm(source)
	target = cleanPrescanTerm(target)
	if target == "" || len([]rune(target)) > 40 || strings.ContainsAny(target, "，。；！？!?;") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(source), target) {
		return true
	}
	if strings.HasPrefix(strings.ToLower(language), "zh") && !preScanCJK.MatchString(target) {
		return false
	}
	return true
}

func harmonizeReviewedTerms(terms []Term) {
	words := func(source string) []string {
		parts := strings.Fields(strings.NewReplacer("-", " ", "‐", " ", "–", " ").Replace(strings.ToLower(source)))
		if len(parts) > 0 && len(parts[len(parts)-1]) > 3 && strings.HasSuffix(parts[len(parts)-1], "s") && !strings.HasSuffix(parts[len(parts)-1], "ss") {
			parts[len(parts)-1] = strings.TrimSuffix(parts[len(parts)-1], "s")
		}
		return parts
	}
	groups := map[string][]int{}
	for i, term := range terms {
		if term.Treatment != "lock" {
			continue
		}
		key := strings.Join(words(term.Source), " ")
		groups[key] = append(groups[key], i)
	}
	for _, indexes := range groups {
		if len(indexes) < 2 {
			continue
		}
		counts := map[string]int{}
		for _, index := range indexes {
			weight := terms[index].Votes
			if weight < 1 {
				weight = 1
			}
			counts[terms[index].Target] += weight
			for _, alternative := range terms[index].ConflictCandidates {
				if alternative.Target != "" {
					altWeight := alternative.Votes
					if altWeight < 1 {
						altWeight = 1
					}
					counts[alternative.Target] += altWeight
				}
			}
		}
		winner := ""
		for target, count := range counts {
			if count > counts[winner] || count == counts[winner] && (winner == "" || target < winner) {
				winner = target
			}
		}
		for _, index := range indexes {
			terms[index].Target = winner
		}
	}
	order := make([]int, len(terms))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool { return len(words(terms[order[i]].Source)) < len(words(terms[order[j]].Source)) })
	for _, li := range order {
		if terms[li].Treatment != "lock" {
			continue
		}
		long := words(terms[li].Source)
		for _, si := range order {
			if terms[si].Treatment != "lock" {
				continue
			}
			short := words(terms[si].Source)
			if len(short) == 0 || len(short) >= len(long) || strings.Contains(terms[li].Target, terms[si].Target) {
				continue
			}
			for start := 0; start+len(short) <= len(long); start++ {
				match := true
				for k := range short {
					if long[start+k] != short[k] {
						match = false
						break
					}
				}
				if match {
					alternatives := make([]string, 0, len(terms[si].ConflictCandidates)+1)
					for _, alternative := range terms[si].ConflictCandidates {
						alternatives = append(alternatives, alternative.Target)
					}
					if terms[si].PrescanTarget != "" {
						alternatives = append(alternatives, terms[si].PrescanTarget)
					}
					for _, alternative := range alternatives {
						if alternative != "" && strings.Contains(terms[li].Target, alternative) {
							terms[li].Target = strings.Replace(terms[li].Target, alternative, terms[si].Target, 1)
							break
						}
					}
					break
				}
			}
		}
	}
}
