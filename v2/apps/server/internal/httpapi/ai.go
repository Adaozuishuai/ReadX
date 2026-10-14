package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/safekey"
	"cbctv2/server/internal/validate"
)

// aiConfig 每次请求现读 app/config.json：旧版就是「改完保存即生效」，不重启也一致。
// Key 只在本进程内使用，响应里只回脱敏状态。
func (s *Server) aiConfig() (ai.Config, error) {
	return ai.LoadConfig(legacy.NewPaths(s.cfg.DataRoot).ConfigFile())
}

func (s *Server) handleAIStatus(w http.ResponseWriter, r *http.Request) {
	config, err := s.aiConfig()
	if err != nil {
		writeJSON(w, http.StatusOK, ai.Redacted{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, config.Redact())
}

type chatRequest struct {
	Key      string `json:"key"`
	Mode     string `json:"mode"`
	Question string `json:"question"`
	Scope    string `json:"scope"`
	History  []struct {
		Role string `json:"role"`
		Text string `json:"text"`
	} `json:"history"`
}

// handleAIChat 以 SSE 把上游增量转发给渲染进程。
//
// 这里刻意不做「事实问答」的两种拒绝（无全文缓存 / 该 scope 选不出内容）都在服务端拦下：
// 把空材料交给模型，模型会凭记忆作答，等于绕过 evidence-first 硬约束。
func (s *Server) handleAIChat(w http.ResponseWriter, r *http.Request) {
	var body chatRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求体必须是 {key, mode, question, scope, history}")
		return
	}
	if strings.TrimSpace(body.Question) == "" && strings.TrimSpace(body.Mode) == "" {
		writeError(w, http.StatusBadRequest, "question 与 mode 至少给一个")
		return
	}
	key, err := safeKey(body.Key, "论文键")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	config, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	if !config.Ready() {
		writeError(w, http.StatusServiceUnavailable, "还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
		return
	}
	source, err := s.sourceText(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	material, included, total, err := ai.PrepareMaterial(source, body.Question, body.Scope)
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	history := make([]ai.Message, 0, len(body.History))
	for _, item := range body.History {
		history = append(history, ai.Message{Role: item.Role, Content: item.Text})
	}
	messages := append([]ai.Message{{Role: "system", Content: ai.ChatSystemPrompt(material, body.Mode)}},
		ai.TrimHistory(history, 8)...)
	messages = append(messages, ai.Message{Role: "user", Content: chatUserMessage(body)})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, canFlush := w.(http.Flusher)
	emit := func(payload any) {
		body, err := json.Marshal(payload)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "data: %s\n\n", body)
		if canFlush {
			flusher.Flush()
		}
	}
	emit(map[string]any{"meta": map[string]any{"included": included, "total": total, "scope": body.Scope}})

	client := ai.NewClient(config)
	text, streamErr := client.Stream(r.Context(), messages, 0.2, func(delta string) {
		emit(map[string]any{"delta": delta})
	})
	if streamErr != nil {
		emit(map[string]any{"error": streamErr.Error(), "partial": text})
		return
	}
	emit(map[string]any{"done": true, "text": text})
}

func chatUserMessage(body chatRequest) string {
	if body.Mode == "explain" && strings.TrimSpace(body.Question) != "" {
		return "选中的句子：「" + body.Question + "」\n\n请解释这句话。"
	}
	if strings.TrimSpace(body.Question) != "" {
		return body.Question
	}
	return "请开始。"
}

type generateRequest struct {
	Key  string `json:"key"`
	Kind string `json:"kind"`
}

// handleAIGenerate 跑完整的四层兜底：生成 → 自动修正重试 → 终局降级轮 → 本地修剪 → 未核验保存。
// 结果连同降级清单/未核验原因一起写进 readings，界面据此如实标注。
func (s *Server) handleAIGenerate(w http.ResponseWriter, r *http.Request) {
	var body generateRequest
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求体必须是 {key, kind}")
		return
	}
	if !readingKinds[body.Kind] {
		writeError(w, http.StatusBadRequest, "本接口只负责 experiment / results 的结构化生成")
		return
	}
	key, err := safeKey(body.Key, "论文键")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	config, err := s.aiConfig()
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	source, err := s.sourceText(r.Context(), key)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if strings.TrimSpace(source) == "" {
		writeError(w, http.StatusConflict, "还没有该论文的全文缓存，请先完成 PDF 文本抽取")
		return
	}

	material, _, _, err := ai.PrepareMaterial(source, "", "全文")
	if err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}
	client := ai.NewClient(config)
	outcome, err := ai.GenerateValidated(r.Context(), client, body.Kind, ai.ReadingSystemPrompt(body.Kind, material), source, 2)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	entry := ReadingEntry{Demoted: []string{}, Value: outcome.Value}
	pruned := false
	if outcome.ValidationError != "" {
		if result := validate.PruneGenerated(body.Kind, outcome.Value, source); result != nil {
			entry.Value = result.Value
			entry.Demoted = result.Demoted
			pruned = true
		} else {
			message := outcome.ValidationError
			entry.ValidationError = &message
		}
	}
	entry.UpdatedAt = nowStamp()
	if err := s.saveReadingEntry(r.Context(), key, body.Kind, entry); err != nil {
		writeError(w, http.StatusInternalServerError, "保存精读记录失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"saved": true, "key": key, "kind": body.Kind,
		"pruned": pruned, "demoted": entry.Demoted, "validationError": entry.ValidationError,
		"attempts": outcome.Attempts,
	})
}

// safeKey 复用 safekey 规则：键会拼进文件路径与 SQL 条件，进入任何 handler 前先过一遍。
func safeKey(value, what string) (string, error) {
	if err := safekey.Check(value); err != nil {
		return "", fmt.Errorf("非法%s：%w", what, err)
	}
	return value, nil
}
