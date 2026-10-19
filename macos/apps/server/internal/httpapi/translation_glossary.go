package httpapi

import (
	"context"
	"fmt"
	"strings"

	"cbctv2/server/internal/translate"
)

func (s *Server) translationGlossary(ctx context.Context) ([]translate.Term, error) {
	rows, err := s.handle.QueryContext(ctx, `SELECT source, target, level, note, match_mode, context FROM glossary_terms ORDER BY length(source) DESC, source COLLATE NOCASE`)
	if err != nil {
		return nil, fmt.Errorf("读取术语表失败: %w", err)
	}
	defer rows.Close()
	terms := make([]translate.Term, 0)
	for rows.Next() {
		var term translate.Term
		if err := rows.Scan(&term.Source, &term.Target, &term.Level, &term.Note, &term.MatchMode, &term.Context); err != nil {
			return nil, fmt.Errorf("读取术语表条目失败: %w", err)
		}
		term.Source = strings.TrimSpace(term.Source)
		term.Target = strings.TrimSpace(term.Target)
		if term.Source != "" && term.Target != "" {
			terms = append(terms, term)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return terms, nil
}

func attachTranslationTerms(ctx context.Context, server *Server, items []translate.Item) error {
	terms, err := server.translationGlossary(ctx)
	if err != nil {
		return err
	}
	for index := range items {
		items[index].Terms = translate.MatchTerms(items[index].Source, terms)
	}
	return nil
}
