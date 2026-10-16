// translate.go：S5 段落级双语对照。
//
// 分工与 S1 的 PDF 文本抽取一致：分段（段落还原）是渲染层的职责——中栏正文怎么排版，
// 译文就按同一份分段贴回去。所以客户端把「当前这篇的段落文本数组」发上来，
// 服务端只做两件事：按段哈希查缓存、缺的才调模型翻。
//
// 缓存键是段落原文的哈希：译过一次的段落再读零成本，且原文改动后哈希随之变化，
// 不会把旧译文贴到新文字上。译文只作阅读辅助，不写进 readings，也不参与证据校验。
package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
)

// maxTranslateBody 覆盖常见论文整篇的段落集合；超过说明客户端传错了东西。
const maxTranslateBody = 4 << 20

// maxTranslateSegments 单次请求的段落数上限，挡住畸形请求把模型额度打光。
const maxTranslateSegments = 2000

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

// handleTranslate 是「翻译这篇论文的这些段落」：命中缓存的直接回，缺的调模型补，全部落库。
//
// 返回条目与请求段落一一对应（同序、同数量），客户端据此把译文贴回原文；
// 任何一段失败都整体报错，不做部分成功——半篇对照比明确失败更难排查。
func (s *Server) handleTranslate(w http.ResponseWriter, r *http.Request) {
	key, ok := pathKey(w, r)
	if !ok {
		return
	}
	var body struct {
		Segments   []string `json:"segments"`
		CachedOnly bool     `json:"cachedOnly"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTranslateBody)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "请求体超过 4 MiB 上限")
			return
		}
		writeError(w, http.StatusBadRequest, "请求体必须是 {\"segments\": [\"段落\", ...]}")
		return
	}
	if len(body.Segments) == 0 {
		writeError(w, http.StatusBadRequest, "segments 为空")
		return
	}
	if len(body.Segments) > maxTranslateSegments {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("单次最多翻译 %d 段，请按页分批", maxTranslateSegments))
		return
	}
	if _, err := s.loadDocument(r.Context(), key); errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "没有这篇文档")
		return
	} else if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// 逐段去空白并去重：同一页里重复出现的段落只翻一次，命中同一缓存键。
	sources := make([]string, len(body.Segments))
	hashes := make([]string, len(body.Segments))
	uniqueOrder := []string{}
	uniqueSource := map[string]string{}
	for index, raw := range body.Segments {
		source := strings.TrimSpace(raw)
		hash := paraHash(source)
		sources[index] = source
		hashes[index] = hash
		if _, seen := uniqueSource[hash]; !seen {
			uniqueSource[hash] = source
			uniqueOrder = append(uniqueOrder, hash)
		}
	}

	cached, err := s.cachedTranslations(r.Context(), key, uniqueOrder)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	missing := []string{}
	for _, hash := range uniqueOrder {
		if _, found := cached[hash]; !found {
			missing = append(missing, hash)
		}
	}

	if body.CachedOnly && len(missing) > 0 {
		writeJSON(w, http.StatusOK, map[string]any{"items": []translateSegment{}, "complete": false})
		return
	}
	if len(missing) > 0 {
		config, err := s.aiConfig()
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, err.Error())
			return
		}
		if !config.Ready() {
			writeError(w, http.StatusServiceUnavailable, "还没配置 AI 助教的 API Key：编辑 app/config.json 填入 Key，保存即生效。")
			return
		}
		inputs := make([]string, len(missing))
		for index, hash := range missing {
			inputs[index] = uniqueSource[hash]
		}
		batchCount := int(math.Ceil(float64(len(inputs)) / 24))
		budget := time.Duration(batchCount) * 3 * time.Minute
		if budget > 30*time.Minute {
			budget = 30 * time.Minute
		}
		ctx, cancel := context.WithTimeout(r.Context(), budget)
		targets, err := ai.TranslateParagraphs(ctx, ai.NewClient(config), inputs)
		cancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				writeError(w, http.StatusGatewayTimeout, "翻译超过本次总时限，未保存；请缩小范围后重试。")
				return
			}
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		inputsByHash := make([]string, len(missing))
		for index, hash := range missing {
			inputsByHash[index] = uniqueSource[hash]
		}
		if err := s.saveTranslations(r.Context(), key, missing, inputsByHash, targets); err != nil {
			writeError(w, http.StatusInternalServerError, "保存译文失败: "+err.Error())
			return
		}
		for index, hash := range missing {
			cached[hash] = targets[index]
		}
	}

	items := make([]translateSegment, len(sources))
	for index := range sources {
		items[index] = translateSegment{Hash: hashes[index], Source: sources[index], Target: cached[hashes[index]]}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"key":      key,
		"complete": true,
		"items":    items,
		"total":    len(items),
		"cached":   len(uniqueOrder) - len(missing),
		"newly":    len(missing),
		"distinct": len(uniqueOrder),
	})
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
	stamp := time.Now().UTC().Format(time.RFC3339)
	for index := range hashes {
		if _, err := statement.ExecContext(ctx, key, hashes[index], sources[index], targets[index], stamp); err != nil {
			return err
		}
	}
	return tx.Commit()
}
