package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
	"cbctv2/server/internal/safekey"
	"cbctv2/server/internal/validate"
)

// aiConfig 每次请求现读 app/config.json：旧版就是「改完保存即生效」，不重启也一致。
// Key 只在本进程内使用，响应里只回脱敏状态。
func (s *Server) aiConfig() (ai.Config, error) {
	s.settingsMu.Lock()
	defer s.settingsMu.Unlock()
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
	system, included, total, unit, err := s.chatContext(r.Context(), key, body.Question, body.Scope, body.Mode)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "没有这篇文档")
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return
	}

	history := make([]ai.Message, 0, len(body.History))
	for _, item := range body.History {
		history = append(history, ai.Message{Role: item.Role, Content: item.Text})
	}
	messages := append([]ai.Message{{Role: "system", Content: system}},
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
	emit(map[string]any{"meta": map[string]any{"included": included, "total": total, "scope": body.Scope, "unit": unit, "provider": config.ProviderName(), "model": config.ModelName(), "reasoningEffort": config.ReasoningEffort}})

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
	Key                string                 `json:"key"`
	Kind               string                 `json:"kind"`
	Visuals            []readingVisualContext `json:"visuals"`
	Workflow           string                 `json:"workflow"`
	Fingerprint        string                 `json:"fingerprint"`
	PageCount          int                    `json:"pageCount"`
	UnavailableVisuals []string               `json:"unavailableVisuals"`
}

type readingVisualContext struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	Page          int    `json:"page"`
	Caption       string `json:"caption"`
	SuggestedStep string `json:"suggestedStep"`
	Revision      string `json:"revision"`
	ImagePNG      string `json:"imagePNG,omitempty"`
}

// The workbook requests paper-reader: page observations -> durable Markdown ->
// local revision -> optional structured index. Legacy clients retain the strict
// JSON/evidence path below without making it a gate for the new narrative.
func (s *Server) handleAIGenerate(w http.ResponseWriter, r *http.Request) {
	var body generateRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "精读请求无效或超过 64 MiB；请减少单篇附件体积后重试")
		return
	}
	if !readingKinds[body.Kind] && body.Kind != "visuals" {
		writeError(w, http.StatusBadRequest, "不支持的精读生成类型")
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
	if strings.TrimSpace(source) == "" && !(body.Workflow == "paper-reader" && body.PageCount > 0 && body.Fingerprint != "") {
		writeError(w, http.StatusConflict, "还没有该论文的全文缓存，请先完成 PDF 文本抽取")
		return
	}

	material := source
	if body.Workflow != "paper-reader" {
		material, _, _, err = ai.PrepareMaterial(source, "", "全文")
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
	}
	client := ai.NewClient(config)
	images, err := prepareReadingVisuals(body.Visuals)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher, canFlush := w.(http.Flusher)
	var writeMu sync.Mutex
	emit := func(payload any) {
		encoded, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		fmt.Fprintf(w, "data: %s\n\n", encoded)
		if canFlush {
			flusher.Flush()
		}
	}
	var stateMu sync.Mutex
	currentProgress := map[string]any{"percent": 8, "message": "论文全文与图表目录已准备，开始解析"}
	updateProgress := func(percent int, message string) {
		stateMu.Lock()
		currentProgress = map[string]any{"percent": percent, "message": message}
		stateMu.Unlock()
		emit(map[string]any{"progress": currentProgress})
	}
	updateProgress(8, "论文全文与图表目录已准备，开始解析")
	stopHeartbeat := make(chan struct{})
	heartbeatDone := make(chan struct{})
	defer func() { close(stopHeartbeat); <-heartbeatDone }()
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopHeartbeat:
				return
			case <-r.Context().Done():
				return
			case <-ticker.C:
				stateMu.Lock()
				message := currentProgress["message"]
				percent := currentProgress["percent"]
				stateMu.Unlock()
				emit(map[string]any{"progress": map[string]any{"percent": percent, "message": message, "heartbeat": true}})
			}
		}
	}()
	if body.Workflow == "paper-reader" {
		updateProgress(38, "逐页阅读已准备，开始串联图文分析")
		s.generatePaperReading(r.Context(), key, body, source, config, client, images, updateProgress, emit)
		return
	}
	var visualAnalysis []readingVisualAnalysis
	if len(body.Visuals) > 0 || body.Kind == "visuals" {
		visualAnalysis, err = s.analyzeReadingVisuals(r.Context(), key, source, material, config, client, body.Visuals, images, body.Kind == "visuals", updateProgress)
		if err != nil {
			emit(map[string]any{"error": err.Error()})
			return
		}
	}
	if body.Kind == "visuals" {
		updateProgress(100, "图表已分析并分配到五重奏")
		emit(map[string]any{"result": map[string]any{"saved": true, "kind": "visuals", "demoted": []string{}, "attempts": 1}, "done": true})
		return
	}
	system := ai.ReadingSystemPrompt(body.Kind, material)
	if len(visualAnalysis) > 0 {
		catalog, _ := json.Marshal(visualAnalysis)
		system += "\n【已观察图片的统一分析目录】\n" + string(catalog) + "\n沿用上述归属，不重新分配图表。针对当前步骤结合这些图表解释机制、实验或结果，并与原文证据联系。图像观察和AI解释不是逐字证据；事实字段仍必须有原文摘录，不从图像分析补造数字。motivation/method 的 sections.title 使用图表目录中对应的小节名，以便将图表嵌入解释。"
	}
	outcome, err := ai.GenerateValidatedWithProgress(r.Context(), client, body.Kind, system, source, 2, func(stage string, attempt, maxAttempts int) {
		base := 44 + (attempt-1)*11
		percent := base
		message := fmt.Sprintf("AI 正在生成分析内容（第 %d/%d 轮）", attempt, maxAttempts)
		switch stage {
		case "formatting":
			message = fmt.Sprintf("正在自动修复 JSON 格式（第 %d/%d 轮）", attempt, maxAttempts)
		case "repairing":
			message = fmt.Sprintf("AI 正在根据证据校验结果修订（第 %d/%d 轮）", attempt, maxAttempts)
		case "validating":
			percent = base + 15
			message = fmt.Sprintf("正在逐页核对摘录与事实（第 %d 轮）", attempt)
		case "downgrading":
			percent = 82
			message = "正在整理无法核验的字段，避免保留无证据结论"
		}
		if percent > 88 {
			percent = 88
		}
		updateProgress(percent, message)
	})
	if err != nil {
		emit(map[string]any{"error": err.Error()})
		return
	}
	if r.Context().Err() != nil {
		return
	}

	updateProgress(92, "正在整理并保存精读结果")
	entry := ReadingEntry{Demoted: []string{}, Value: outcome.Value, Provider: config.ProviderName(), Model: config.ModelName(), ReasoningEffort: config.ReasoningEffort, Visuals: visualAnalysis, VisualSourceHash: visualSourceHash(source, config)}
	pruned := false
	if outcome.ValidationError != "" {
		if result := validate.PruneGenerated(body.Kind, outcome.Value, source); result != nil {
			entry.Value = result.Value
			entry.Demoted = result.Demoted
			pruned = true
		} else {
			// A failed regeneration must never replace a previously useful record.
			s.recordReadingFailure(key, body.Kind, config, outcome)
			emit(map[string]any{"result": map[string]any{"saved": false, "kind": body.Kind, "pruned": false, "demoted": []string{}, "validationError": outcome.ValidationError, "attempts": outcome.Attempts}, "done": true})
			return
		}
	}
	entry.UpdatedAt = nowStamp()
	if err := s.saveReadingEntry(r.Context(), key, body.Kind, entry); err != nil {
		emit(map[string]any{"error": "保存精读记录失败: " + err.Error()})
		return
	}
	result := map[string]any{
		"saved": true, "key": key, "kind": body.Kind,
		"pruned": pruned, "demoted": entry.Demoted, "validationError": entry.ValidationError,
		"attempts": outcome.Attempts,
	}
	updateProgress(100, "精读结果已保存")
	emit(map[string]any{"result": result, "done": true})
}

// safeKey 复用 safekey 规则：键会拼进文件路径与 SQL 条件，进入任何 handler 前先过一遍。
func safeKey(value, what string) (string, error) {
	if err := safekey.Check(value); err != nil {
		return "", fmt.Errorf("非法%s：%w", what, err)
	}
	return value, nil
}
