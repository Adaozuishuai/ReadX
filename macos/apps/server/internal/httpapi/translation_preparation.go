package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/translate"
)

type termPrescanArtifact struct {
	Fingerprint  string           `json:"fingerprint"`
	Terms        []translate.Term `json:"terms"`
	ReviewStatus string           `json:"reviewStatus,omitempty"`
}

type styleGuideArtifact struct {
	Fingerprint string `json:"fingerprint"`
	Guidance    string `json:"guidance"`
}

type domainContextArtifact struct {
	Fingerprint string                  `json:"fingerprint"`
	Domain      translate.DomainContext `json:"domain"`
}

const translationPreparationArtifactRevision = "retain-parity-2026-10-18-r4"

type dbTermPrescanStore struct {
	server *Server
	key    string
}

func (store dbTermPrescanStore) LoadBatch(ctx context.Context, batchID, fingerprint string) ([]translate.PrescanTerm, bool, error) {
	var encoded string
	err := store.server.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, store.key+":"+batchID).Scan(&encoded)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var cached struct {
		Fingerprint string                  `json:"fingerprint"`
		Terms       []translate.PrescanTerm `json:"terms"`
	}
	if json.Unmarshal([]byte(encoded), &cached) != nil || cached.Fingerprint != fingerprint {
		return nil, false, nil
	}
	return cached.Terms, true, nil
}

func (store dbTermPrescanStore) SaveBatch(ctx context.Context, batchID, fingerprint string, terms []translate.PrescanTerm) error {
	body, err := json.Marshal(struct {
		Fingerprint string                  `json:"fingerprint"`
		Terms       []translate.PrescanTerm `json:"terms"`
	}{fingerprint, terms})
	if err != nil {
		return err
	}
	_, err = store.server.handle.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, store.key+":"+batchID, string(body), nowStamp())
	return err
}

// documentTermPrescan keeps the LeePDF preparation mode opt-in (default
// off), freezes a successful artifact per document/configuration, and never
// writes model suggestions into the user's glossary table.
func (s *Server) documentTermPrescan(ctx context.Context, key string, cfg ai.Config, items []translate.Item, domain translate.DomainContext, userEntries ...[]translate.Term) ([]translate.Term, error) {
	if cfg.TranslationPreparation != "terms" && cfg.TranslationPreparation != "terms+style" && cfg.TranslationPreparation != "artifacts_only" && cfg.TranslationPreparation != "editorial" {
		return nil, nil
	}
	locked := make([]translate.Term, 0)
	if len(userEntries) > 0 {
		locked = append(locked, userEntries[0]...)
	}
	seen := map[string]bool{}
	if len(userEntries) == 0 {
		for _, item := range items {
			for _, term := range item.Terms {
				id := strings.ToLower(term.Source) + "\x00" + term.Target + "\x00" + term.Level
				if !seen[id] {
					seen[id] = true
					locked = append(locked, term)
				}
			}
		}
	}
	identity, _ := json.Marshal(struct {
		Schema           string                  `json:"schema"`
		ArtifactRevision string                  `json:"artifactRevision"`
		Prompt           string                  `json:"promptVersion"`
		Segmentation     string                  `json:"segmentationVersion"`
		BatchTokens      int                     `json:"batchMaxTokens"`
		BatchItems       int                     `json:"batchMaxSegments"`
		Provider         string                  `json:"provider"`
		Model            string                  `json:"model"`
		BaseURL          string                  `json:"baseURL"`
		ReasoningEffort  string                  `json:"reasoningEffort"`
		TargetLanguage   string                  `json:"targetLanguage"`
		TermReview       string                  `json:"termReview,omitempty"`
		Domain           translate.DomainContext `json:"domain"`
		Items            []translate.Item        `json:"items"`
		Locked           []translate.Term        `json:"locked"`
	}{"term_base_v1", translationPreparationArtifactRevision, translate.PrescanPromptVersion, translate.PrescanSegmentationVersion, translate.PrescanBatchMaxTokens, translate.PrescanBatchMaxSegments, cfg.ProviderName(), cfg.ModelName(), cfg.PublicBaseURL(), cfg.ReasoningEffort, "zh-CN", func() string {
		if cfg.TranslationPreparation == "editorial" {
			return translate.TermReviewPromptVersion
		}
		return ""
	}(), domain, items, locked})
	sum := sha256.Sum256(identity)
	fingerprint := hex.EncodeToString(sum[:])
	stateKey := "translation-term-base:" + key
	var encoded string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, stateKey).Scan(&encoded)
	if err == nil {
		var artifact termPrescanArtifact
		if json.Unmarshal([]byte(encoded), &artifact) == nil && artifact.Fingerprint == fingerprint && (cfg.TranslationPreparation != "editorial" || artifact.ReviewStatus == "completed") {
			return artifact.Terms, nil
		}
	} else if err != sql.ErrNoRows {
		return nil, fmt.Errorf("读取译前术语库缓存失败: %w", err)
	}
	batchDocument := make([]map[string]any, 0, len(items))
	for _, item := range items {
		batchDocument = append(batchDocument, map[string]any{"itemID": item.ItemID, "pageIndex": item.PageIndex, "source": item.Source, "blockType": item.BlockType, "semanticRole": item.SemanticRole, "structureRole": item.StructureRole, "layoutRole": item.LayoutRole, "policyTranslate": item.PolicyTranslate})
	}
	batchIdentity, _ := json.Marshal(struct {
		Provider, Model, BaseURL, Reasoning string
		Document                            []map[string]any
	}{cfg.ProviderName(), cfg.ModelName(), cfg.PublicBaseURL(), cfg.ReasoningEffort, batchDocument})
	batchSum := sha256.Sum256(batchIdentity)
	requestIdentity := hex.EncodeToString(batchSum[:])
	terms, prescanErr := translate.PrepareDocumentTermsWithStore(ctx, ai.NewClient(cfg), items, locked, "简体中文", domain.Domain, requestIdentity, dbTermPrescanStore{server: s, key: "translation-term-batches:" + key})
	reviewStatus := ""
	if cfg.TranslationPreparation == "editorial" {
		var reviewErr error
		terms, reviewErr = translate.ReviewDocumentTerms(ctx, ai.NewClient(cfg), items, terms, domain.Domain, "简体中文")
		if reviewErr != nil {
			if prescanErr == nil {
				prescanErr = reviewErr
			} else {
				prescanErr = fmt.Errorf("预扫失败: %v；术语审定未完成: %w", prescanErr, reviewErr)
			}
		} else {
			reviewStatus = "completed"
		}
	}
	if prescanErr == nil {
		body, marshalErr := json.Marshal(termPrescanArtifact{Fingerprint: fingerprint, Terms: terms, ReviewStatus: reviewStatus})
		if marshalErr != nil {
			return terms, marshalErr
		}
		if _, err = s.handle.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, stateKey, string(body), nowStamp()); err != nil {
			return terms, fmt.Errorf("保存译前术语库缓存失败: %w", err)
		}
	}
	return terms, prescanErr
}

func (s *Server) documentStyleGuide(ctx context.Context, key string, cfg ai.Config, items []translate.Item, terms []translate.Term, domain translate.DomainContext, userGlossary ...[]translate.Term) (string, error) {
	identity, _ := json.Marshal(struct {
		Prompt           string                  `json:"prompt"`
		ArtifactRevision string                  `json:"artifactRevision"`
		Provider         string                  `json:"provider"`
		Model            string                  `json:"model"`
		BaseURL          string                  `json:"baseURL"`
		Reasoning        string                  `json:"reasoning"`
		Items            []translate.Item        `json:"items"`
		Terms            []translate.Term        `json:"terms"`
		UserGlossary     []translate.Term        `json:"userGlossary,omitempty"`
		Domain           translate.DomainContext `json:"domain"`
	}{translate.StyleGuidePromptVersion, translationPreparationArtifactRevision, cfg.ProviderName(), cfg.ModelName(), cfg.PublicBaseURL(), cfg.ReasoningEffort, items, terms, func() []translate.Term {
		if len(userGlossary) > 0 {
			return userGlossary[0]
		}
		return nil
	}(), domain})
	sum := sha256.Sum256(identity)
	fingerprint := hex.EncodeToString(sum[:])
	stateKey := "translation-style-guide:" + key
	var encoded string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, stateKey).Scan(&encoded)
	if err == nil {
		var artifact styleGuideArtifact
		if json.Unmarshal([]byte(encoded), &artifact) == nil && artifact.Fingerprint == fingerprint {
			return artifact.Guidance, nil
		}
	} else if err != sql.ErrNoRows {
		return "", fmt.Errorf("读取译前风格指南缓存失败: %w", err)
	}
	guidance, generationErr := translate.GenerateDocumentStyle(ctx, ai.NewClient(cfg), items, terms, domain, userGlossary...)
	if generationErr == nil {
		body, marshalErr := json.Marshal(styleGuideArtifact{Fingerprint: fingerprint, Guidance: guidance})
		if marshalErr != nil {
			return guidance, marshalErr
		}
		if _, err = s.handle.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, stateKey, string(body), nowStamp()); err != nil {
			return guidance, fmt.Errorf("保存译前风格指南缓存失败: %w", err)
		}
	}
	return guidance, generationErr
}

func formatOCRPreview(pageTexts []string) string {
	var preview strings.Builder
	limit := len(pageTexts)
	if limit > 2 {
		limit = 2
	}
	for page := 0; page < limit; page++ {
		if text := strings.TrimSpace(pageTexts[page]); text != "" {
			fmt.Fprintf(&preview, "[Page %d]\n%s\n\n", page+1, text)
		}
	}
	return strings.TrimSpace(preview.String())
}

func (s *Server) documentDomainContext(ctx context.Context, key string, cfg ai.Config, previewText string) (translate.DomainContext, error) {
	previewText = strings.TrimSpace(previewText)
	if previewText == "" {
		return translate.DomainContext{}, nil
	}
	identity, _ := json.Marshal(struct{ Prompt, Revision, Provider, Model, BaseURL, Reasoning, Preview string }{translate.DomainContextPromptVersion, translationPreparationArtifactRevision, cfg.ProviderName(), cfg.ModelName(), cfg.PublicBaseURL(), cfg.ReasoningEffort, previewText})
	sum := sha256.Sum256(identity)
	fingerprint := hex.EncodeToString(sum[:])
	stateKey := "translation-domain-context:" + key
	var encoded string
	err := s.handle.QueryRowContext(ctx, `SELECT value_json FROM app_state WHERE key = ?`, stateKey).Scan(&encoded)
	if err == nil {
		var artifact domainContextArtifact
		if json.Unmarshal([]byte(encoded), &artifact) == nil && artifact.Fingerprint == fingerprint {
			return artifact.Domain, nil
		}
	} else if err != sql.ErrNoRows {
		return translate.DomainContext{}, fmt.Errorf("读取领域识别缓存失败: %w", err)
	}
	domain, generationErr := translate.InferDocumentDomain(ctx, ai.NewClient(cfg), previewText)
	if generationErr == nil {
		body, marshalErr := json.Marshal(domainContextArtifact{Fingerprint: fingerprint, Domain: domain})
		if marshalErr != nil {
			return domain, marshalErr
		}
		if _, err = s.handle.ExecContext(ctx, `INSERT INTO app_state(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, stateKey, string(body), nowStamp()); err != nil {
			return domain, fmt.Errorf("保存领域识别缓存失败: %w", err)
		}
	}
	return domain, generationErr
}
