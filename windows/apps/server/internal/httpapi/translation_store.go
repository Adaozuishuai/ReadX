// translation_store.go：译文缓存（按段落哈希）与段落辅助函数。
//
// 旧的「按 PDF 文本层分段 → 翻译接口 → 前端排版」链路已整体移除；现在译文只由
// LeePDF 链路（OCR 段落 → 翻译 → rpr 排版）产生。translations 表仍是段落级缓存，
// 供 OCR 导入与按页渲染复用。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/translate"
)

type translateSegment struct {
	Hash   string `json:"hash"`
	Source string `json:"source"`
	Target string `json:"target"`
}

// paraHash 对段落原文取指纹：去首尾空白后哈希，避免行尾空白差异造成缓存未命中。
func paraHash(source string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(source)))
	return hex.EncodeToString(sum[:16])
}

// translationCacheHash mirrors LeePDF's cache identity: a translation is
// reusable only for the same source/context, engine prompt version, provider,
// model, and endpoint. The legacy paragraph hash remains available to resolve
// already-cached translations when the AI configuration file is absent.
func translationCacheHash(item translate.Item, config *ai.Config) string {
	itemMathMode := strings.ToLower(strings.TrimSpace(item.MathMode))
	if itemMathMode == "" {
		itemMathMode = "direct_typst"
	}
	if config == nil && itemMathMode == "direct_typst" && item.ContinuationGroup == "" && !item.Continuation && len(item.Terms) == 0 && strings.TrimSpace(item.StyleHint) == "" && len(item.LineTexts) <= 1 && len(item.FormulaTexts) == 0 && !item.CrossColumnMergeSuspected && !item.ReadingOrderUnreliable && !item.StructureUnreliable && strings.TrimSpace(item.ContextBefore) == "" && strings.TrimSpace(item.ContextAfter) == "" {
		return paraHash(item.Source)
	}
	before, after := "", ""
	if item.Continuation || !hasSentenceEnd(item.Source) {
		before = strings.TrimSpace(item.ContextBefore)
		after = strings.TrimSpace(item.ContextAfter)
	}
	terms, _ := json.Marshal(item.Terms)
	formulas, _ := json.Marshal(item.FormulaTexts)
	mathMode := itemMathMode
	provider, model, endpoint, reasoning := "", "", "", ""
	if config != nil {
		provider, model, endpoint, reasoning = config.ProviderName(), config.ModelName(), config.PublicBaseURL(), strings.TrimSpace(config.ReasoningEffort)
	}
	identity := strings.Join([]string{
		"readx-translation-v11",
		"retainpdf-prompt-general-sci-direct-math-policy-v10-math-mode-formula-segments",
		provider,
		model,
		endpoint,
		reasoning,
		strings.TrimSpace(item.Source),
		strings.TrimSpace(item.ContinuationGroup),
		strings.TrimSpace(item.ContinuationSignature),
		strings.TrimSpace(item.Role),
		strings.TrimSpace(item.StyleHint),
		string(terms),
		string(formulas),
		mathMode,
		strings.Join(item.LineTexts, "\n"),
		fmt.Sprintf("%t/%t/%t", item.CrossColumnMergeSuspected, item.ReadingOrderUnreliable, item.StructureUnreliable),
		before,
		after,
	}, "\x00")
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:16])
}

// hasSentenceEnd 粗略判断上一段是否已经写完：没写完时，当前段很可能是跨栏/跨页续接，
// 需要把邻段作为消歧上下文。
func hasSentenceEnd(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return true
	}
	runes := []rune(trimmed)
	switch runes[len(runes)-1] {
	case '.', '!', '?', '。', '！', '？', '；', ';', ':', '：', ')', '）', ']', '】', '”', '’', '"', '\'':
		return true
	}
	return false
}

func (s *Server) cachedTranslations(ctx context.Context, key string, hashes []string) (map[string]string, error) {
	out := map[string]string{}
	if len(hashes) == 0 {
		return out, nil
	}
	// 逐条查而不是拼 IN (...) 占位符：段落数在几百量级，参数上限可控且读起来更直白。
	statement, err := s.handle.PrepareContext(ctx, `SELECT target FROM translations WHERE document_id = ? AND para_hash = ?`)
	if err != nil {
		return nil, fmt.Errorf("准备译文查询失败: %w", err)
	}
	defer statement.Close()
	for _, hash := range hashes {
		var target string
		err := statement.QueryRowContext(ctx, key, hash).Scan(&target)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("读取译文失败: %w", err)
		}
		if strings.TrimSpace(target) == "" {
			continue
		}
		out[hash] = target
	}
	return out, nil
}

func (s *Server) saveTranslations(ctx context.Context, key string, hashes, sources, targets []string) error {
	if len(hashes) != len(sources) || len(hashes) != len(targets) {
		return fmt.Errorf("译文数组长度不匹配")
	}
	if len(hashes) == 0 {
		return nil
	}
	tx, err := s.handle.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statement, err := tx.PrepareContext(ctx,
		`INSERT INTO translations(document_id, para_hash, source, target, updated_at) VALUES(?,?,?,?,?)
		 ON CONFLICT(document_id, para_hash) DO UPDATE SET source = excluded.source, target = excluded.target, updated_at = excluded.updated_at`)
	if err != nil {
		return err
	}
	defer statement.Close()
	stamp := nowStamp()
	for index := range hashes {
		if strings.TrimSpace(targets[index]) == "" {
			continue
		}
		if _, err := statement.ExecContext(ctx, key, hashes[index], sources[index], targets[index], stamp); err != nil {
			return err
		}
	}
	return tx.Commit()
}
