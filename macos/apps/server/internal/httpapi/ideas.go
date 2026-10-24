// ideas.go：S6 想法工作流。
//
// 对应旧版 windows/src/core/idea.ts 的 ResearchIdea：五状态（想法/待实验/实验中/已否定/已采纳），
// 证据四来源（论文原文 / AI 解释 / 研究建议 / 个人笔记）。
//
// 关键取舍（继承自 TS/Swift）：**只有 origin=论文原文 的 evidence 才做逐字摘录校验**——
// AI 解释 / 研究建议 / 个人笔记本来就不是原文，强制逐字摘录只会逼模型编造页码；
// 它们的可信度由 origin 标签本身披露。服务端写入前复用 internal/validate 的同一份判定。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"

	"cbctv2/server/internal/appstate"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"cbctv2/server/internal/safekey"
	"cbctv2/server/internal/validate"
)

// safekeyID 与 pathKey 同一套规则：id 会参与 SQL 条件与日志，进入 handler 前先过校验。
func safekeyID(value string) error {
	if err := safekey.Check(value); err != nil {
		return fmt.Errorf("非法 id: %w", err)
	}
	return nil
}

// IdeaStatuses 与 TS IDEA_STATUSES 一致。
var IdeaStatuses = map[string]string{
	"Idea": "想法", "Planned": "待实验", "Running": "实验中", "Rejected": "已否定", "Adopted": "已采纳",
}

// EvidenceOrigins 与 TS EVIDENCE_ORIGINS 一致。
var EvidenceOrigins = map[string]bool{
	"论文原文": true, "AI 解释": true, "研究建议": true, "个人笔记": true,
}

const (
	maxIdeaField    = 8000
	maxIdeaEvidence = 40
)

// IdeaEvidence 与 validate.IdeaEvidence 同形（JSON tag 一致）。
type IdeaEvidence = validate.IdeaEvidence

// ResearchIdea 与 TS ResearchIdea 同形。
type ResearchIdea struct {
	ID          string         `json:"id"`
	Question    string         `json:"question"`
	Observation string         `json:"observation"`
	Hypothesis  string         `json:"hypothesis"`
	Method      string         `json:"method"`
	Experiment  string         `json:"experiment"`
	Status      string         `json:"status"`
	Evidence    []IdeaEvidence `json:"evidence"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

// handleIdeaList 返回全部想法（按更新时间倒序）。
func (s *Server) handleIdeaList(w http.ResponseWriter, r *http.Request) {
	ideas, err := s.loadIdeas(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ideas": ideas, "total": len(ideas)})
}

// handleIdeaCreate 新建想法。带 origin=论文原文 的证据在此强制逐字核验。
func (s *Server) handleIdeaCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Question    string         `json:"question"`
		Observation string         `json:"observation"`
		Hypothesis  string         `json:"hypothesis"`
		Method      string         `json:"method"`
		Experiment  string         `json:"experiment"`
		Status      string         `json:"status"`
		Evidence    []IdeaEvidence `json:"evidence"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if err := s.validateIdeaFields(r.Context(), &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	now := nowStamp()
	idea := ResearchIdea{
		ID: newIdeaID(), Question: strings.TrimSpace(body.Question), Observation: strings.TrimSpace(body.Observation),
		Hypothesis: strings.TrimSpace(body.Hypothesis), Method: strings.TrimSpace(body.Method),
		Experiment: strings.TrimSpace(body.Experiment), Status: body.Status,
		Evidence: body.Evidence, CreatedAt: now, UpdatedAt: now,
	}
	if idea.Evidence == nil {
		idea.Evidence = []IdeaEvidence{}
	}
	if err := s.mutateIdeas(r.Context(), func(ideas []ResearchIdea) ([]ResearchIdea, error) {
		return append(ideas, idea), nil
	}); err != nil {
		writeError(w, http.StatusInternalServerError, "保存想法失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, idea)
}

// handleIdeaPatch 更新想法：只改提供的字段，状态必须是五个合法值之一。
// 读-改-写在 mutateIdeas 的每 key 锁内原子完成（原先靠 appStateMu 护住
// load → 改 → replace 三步）。
func (s *Server) handleIdeaPatch(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := safekeyID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Question    *string         `json:"question"`
		Observation *string         `json:"observation"`
		Hypothesis  *string         `json:"hypothesis"`
		Method      *string         `json:"method"`
		Experiment  *string         `json:"experiment"`
		Status      *string         `json:"status"`
		Evidence    *[]IdeaEvidence `json:"evidence"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		return
	}
	if body.Status != nil {
		if _, ok := IdeaStatuses[*body.Status]; !ok {
			writeError(w, http.StatusBadRequest, "status 只能是 Idea / Planned / Running / Rejected / Adopted")
			return
		}
	}
	var updated ResearchIdea
	err := s.mutateIdeas(r.Context(), func(ideas []ResearchIdea) ([]ResearchIdea, error) {
		index := -1
		for i, idea := range ideas {
			if idea.ID == id {
				index = i
				break
			}
		}
		if index < 0 {
			return nil, errIdeaNotFound
		}
		current := ideas[index]
		if body.Status != nil {
			current.Status = *body.Status
		}
		if body.Question != nil {
			current.Question = strings.TrimSpace(*body.Question)
		}
		if body.Observation != nil {
			current.Observation = strings.TrimSpace(*body.Observation)
		}
		if body.Hypothesis != nil {
			current.Hypothesis = strings.TrimSpace(*body.Hypothesis)
		}
		if body.Method != nil {
			current.Method = strings.TrimSpace(*body.Method)
		}
		if body.Experiment != nil {
			current.Experiment = strings.TrimSpace(*body.Experiment)
		}
		if body.Evidence != nil {
			current.Evidence = *body.Evidence
		}
		if err := s.validateIdeaFields(r.Context(), &struct {
			Question    string         `json:"question"`
			Observation string         `json:"observation"`
			Hypothesis  string         `json:"hypothesis"`
			Method      string         `json:"method"`
			Experiment  string         `json:"experiment"`
			Status      string         `json:"status"`
			Evidence    []IdeaEvidence `json:"evidence"`
		}{
			Question: current.Question, Observation: current.Observation, Hypothesis: current.Hypothesis,
			Method: current.Method, Experiment: current.Experiment, Status: current.Status, Evidence: current.Evidence,
		}); err != nil {
			return nil, ideaValidationError{err}
		}
		current.UpdatedAt = nowStamp()
		ideas[index] = current
		updated = current
		return ideas, nil
	})
	switch {
	case errors.Is(err, errIdeaNotFound):
		writeError(w, http.StatusNotFound, errIdeaNotFound.Error())
		return
	case err != nil:
		var validation ideaValidationError
		if errors.As(err, &validation) {
			writeError(w, http.StatusBadRequest, validation.Error())
			return
		}
		writeError(w, http.StatusInternalServerError, "保存想法失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// handleIdeaDelete 删除想法。
func (s *Server) handleIdeaDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := safekeyID(id); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	err := s.mutateIdeas(r.Context(), func(ideas []ResearchIdea) ([]ResearchIdea, error) {
		kept := ideas[:0]
		removed := false
		for _, idea := range ideas {
			if idea.ID == id {
				removed = true
				continue
			}
			kept = append(kept, idea)
		}
		if !removed {
			return nil, errIdeaNotFound
		}
		return kept, nil
	})
	switch {
	case errors.Is(err, errIdeaNotFound):
		writeError(w, http.StatusNotFound, errIdeaNotFound.Error())
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "删除想法失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
}

// validateIdeaFields 跑与 TS 相同的输入校验与证据核验。
func (s *Server) validateIdeaFields(ctx context.Context, body *struct {
	Question    string         `json:"question"`
	Observation string         `json:"observation"`
	Hypothesis  string         `json:"hypothesis"`
	Method      string         `json:"method"`
	Experiment  string         `json:"experiment"`
	Status      string         `json:"status"`
	Evidence    []IdeaEvidence `json:"evidence"`
}) error {
	if body.Status == "" {
		body.Status = "Idea"
	}
	if _, ok := IdeaStatuses[body.Status]; !ok {
		return fmt.Errorf("status 只能是 Idea / Planned / Running / Rejected / Adopted")
	}
	for _, value := range []string{body.Question, body.Observation, body.Hypothesis, body.Method, body.Experiment} {
		if len([]rune(value)) > maxIdeaField {
			return fmt.Errorf("想法字段过长（上限 %d 字）", maxIdeaField)
		}
	}
	if len(body.Evidence) > maxIdeaEvidence {
		return fmt.Errorf("证据数量上限 %d", maxIdeaEvidence)
	}
	for index := range body.Evidence {
		evidence := &body.Evidence[index]
		if !EvidenceOrigins[evidence.Origin] {
			return fmt.Errorf("第 %d 条证据的 origin 非法（只能是 论文原文 / AI 解释 / 研究建议 / 个人笔记）", index+1)
		}
		// 只有「论文原文」需要逐字核验；其余来源直接放行，可信度由 origin 标签披露。
		if evidence.Origin != validate.OriginPaperText {
			continue
		}
		if evidence.PaperKey == "" {
			return fmt.Errorf("第 %d 条原文证据缺少 paperKey", index+1)
		}
		source, err := s.sourceText(ctx, evidence.PaperKey)
		if err != nil {
			return fmt.Errorf("读取 %s 的正文失败: %w", evidence.PaperKey, err)
		}
		if strings.TrimSpace(source) == "" {
			return fmt.Errorf("第 %d 条原文证据指向的论文还没有正文缓存，无法核验摘录", index+1)
		}
		if err := validate.ValidateIdeaEvidence(*evidence, source); err != nil {
			return fmt.Errorf("第 %d 条原文证据未通过核验：%w", index+1, err)
		}
	}
	return nil
}

// ---- 数据访问 ----

// errIdeaNotFound 是 mutateIdeas 闭包里的 404 哨兵：handler 据此映射 404。
var errIdeaNotFound = errors.New("没有这条想法")

// ideaValidationError 包住校验错误：handler 据此映射 400（与原实现一致，
// 存储/解析错误仍为 500）。
type ideaValidationError struct{ error }

// loadIdeas 经 appStateStore 读出（SQL 与 JSON 样板收进 internal/appstate）。
func (s *Server) loadIdeas(ctx context.Context) ([]ResearchIdea, error) {
	ideas, exists, err := appstate.Load[[]ResearchIdea](ctx, s.appStateStore, "ideas")
	if err != nil {
		if exists {
			return nil, fmt.Errorf("想法数据已损坏（app_state.ideas 不是 JSON 数组）: %w", err)
		}
		return nil, fmt.Errorf("读取想法失败: %w", err)
	}
	if !exists {
		return []ResearchIdea{}, nil
	}
	if ideas == nil {
		ideas = []ResearchIdea{}
	}
	for index := range ideas {
		if ideas[index].Evidence == nil {
			ideas[index].Evidence = []IdeaEvidence{}
		}
	}
	return ideas, nil
}

// mutateIdeas 在 "ideas" 键的每 key 锁内做原子读-改-写：fn 拿到的列表一定是
// 最新值，返回 (nil, nil) 表示放弃修改不写回，返回错误同样不写回。
// 取代原先「appStateMu + loadIdeas + replaceIdeas 三步」——锁范围从「全部
// app_state 使用者」收窄到「同一个 ideas 键的写者」。
func (s *Server) mutateIdeas(ctx context.Context, fn func(ideas []ResearchIdea) ([]ResearchIdea, error)) error {
	return s.appStateStore.Update(ctx, "ideas", func(cur []byte, exists bool) ([]byte, error) {
		ideas := []ResearchIdea{}
		if exists {
			if err := json.Unmarshal(cur, &ideas); err != nil {
				return nil, fmt.Errorf("想法数据已损坏（app_state.ideas 不是 JSON 数组）: %w", err)
			}
		}
		for index := range ideas {
			if ideas[index].Evidence == nil {
				ideas[index].Evidence = []IdeaEvidence{}
			}
		}
		next, err := fn(ideas)
		if err != nil || next == nil {
			return nil, err
		}
		return json.Marshal(next)
	})
}

func (s *Server) replaceIdeas(ctx context.Context, ideas []ResearchIdea) error {
	return appstate.Save(ctx, s.appStateStore, "ideas", ideas)
}

func newIdeaID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "idea-" + time.Now().UTC().Format("20060102150405")
	}
	return "idea-" + hex.EncodeToString(buf)
}
