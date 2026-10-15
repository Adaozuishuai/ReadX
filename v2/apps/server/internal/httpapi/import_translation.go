package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"cbctv2/server/internal/ai"
)

type publicationPageHint struct {
	Page     int      `json:"page"`
	Text     string   `json:"text"`
	Segments []string `json:"segments"`
}

// All model calls finish before the library transaction begins. A failed/cancelled
// translation cannot leave an entry that looks completely imported.
func (s *Server) prepareImportTranslations(ctx context.Context, data []byte, pages []publicationPageHint, metadata *recognizedPaperMetadata, progress ...func(completed, total, start, end, cached int)) error {
	if len(pages) == 0 {
		return nil
	}
	if len(pages) > 2000 {
		return fmt.Errorf("PDF 超过 2000 页，请拆分后导入")
	}
	sources, hashes := []string{}, []string{}
	unique := map[string]string{}
	chars := 0
	for index, page := range pages {
		if page.Page != index+1 {
			return fmt.Errorf("PDF 页码必须从 1 连续排列")
		}
		chars += len([]rune(page.Text))
		for _, segment := range page.Segments {
			source := strings.TrimSpace(segment)
			chars += len([]rune(source))
			if chars > 2000000 {
				return fmt.Errorf("论文文本过长，请拆分后导入")
			}
			hash := paraHash(source)
			if source != "" {
				if _, ok := unique[hash]; !ok {
					unique[hash] = source
					sources = append(sources, source)
					hashes = append(hashes, hash)
				}
			}
		}
	}
	if len(sources) > 10000 || chars > 2000000 {
		return fmt.Errorf("论文文本过长，请拆分后导入")
	}
	sum := sha256.Sum256(data)
	key := "doc-" + hex.EncodeToString(sum[:16])
	cached, err := s.cachedTranslations(ctx, key, hashes)
	if err != nil {
		return err
	}
	missing := []string{}
	for i, hash := range hashes {
		if _, ok := cached[hash]; !ok {
			missing = append(missing, sources[i])
		}
	}
	cachedCount := len(sources) - len(missing)
	report := func(completed, total, start, end int) {
		for _, callback := range progress {
			if callback != nil {
				callback(completed+cachedCount, len(sources), start, end, cachedCount)
			}
		}
	}
	report(0, len(missing), 0, 0)
	if len(missing) > 0 {
		cfg, err := s.aiConfig()
		if err != nil {
			return err
		}
		translationCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		targets, err := ai.TranslateParagraphs(translationCtx, ai.NewClient(cfg), missing, report)
		cancel()
		if err != nil {
			return fmt.Errorf("全文翻译失败，尚未导入：%w", err)
		}
		for i, source := range missing {
			cached[paraHash(source)] = targets[i]
		}
	}
	metadata.Pages = pages
	for i, hash := range hashes {
		metadata.Translations = append(metadata.Translations, translateSegment{Hash: hash, Source: sources[i], Target: cached[hash]})
	}
	return nil
}

func saveImportText(ctx context.Context, tx *sql.Tx, key, stamp string, metadata recognizedPaperMetadata) error {
	for _, page := range metadata.Pages {
		sum := sha256.Sum256([]byte(page.Text))
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO document_pages(document_id,page,text,hash,updated_at) VALUES(?,?,?,?,?)`, key, page.Page, page.Text, hex.EncodeToString(sum[:]), stamp); err != nil {
			return err
		}
	}
	for _, segment := range metadata.Translations {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO translations(document_id,para_hash,source,target,updated_at) VALUES(?,?,?,?,?)`, key, segment.Hash, segment.Source, segment.Target, stamp); err != nil {
			return err
		}
	}
	return nil
}
