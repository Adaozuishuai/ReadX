package httpapi

import (
	"encoding/json"
	"os"
	"path/filepath"

	"cbctv2/server/internal/ai"
	"cbctv2/server/internal/legacy"
)

// Keep only the most recent failed response for each document/step. No source
// prompt, API credentials, authentication files or image payloads are recorded.
func (s *Server) recordReadingFailure(key, kind string, config ai.Config, outcome ai.ValidatedOutcome) {
	dir := filepath.Join(legacy.NewPaths(s.cfg.DataRoot).V2Dir(), "diagnostics")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return
	}
	value := outcome.Value
	truncated := false
	if len(value) > 4<<20 {
		value = value[:4<<20]
		truncated = true
	}
	data, err := json.MarshalIndent(map[string]any{
		"key": key, "kind": kind, "provider": config.ProviderName(), "model": config.ModelName(),
		"reasoningEffort": config.ReasoningEffort, "updatedAt": nowStamp(), "attempts": outcome.Attempts,
		"validationError": outcome.ValidationError, "response": value, "truncated": truncated,
	}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, key+"-"+kind+".json"), data, 0600)
}
