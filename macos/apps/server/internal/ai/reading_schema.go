package ai

import (
	"context"
	"encoding/json"
	"time"
)

// Constrain the actual model response, including LaTeX escaping and nullable
// evidence fields. Prompt-only JSON instructions do not enforce serialization.
func readingOutputSchema(kind string) json.RawMessage {
	if kind != "method" && kind != "motivation" {
		return nil
	}
	text := func() map[string]any { return map[string]any{"type": "string"} }
	object := func(properties map[string]any, required ...string) map[string]any {
		return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
	}
	page := map[string]any{"type": []string{"integer", "null"}}
	excerpt := map[string]any{"type": []string{"string", "null"}}
	reference := map[string]any{"type": []string{"string", "null"}}
	field := object(map[string]any{"k": text(), "v": text(), "page": page, "excerpt": excerpt, "evidenceID": reference}, "k", "v", "page", "excerpt", "evidenceID")
	section := object(map[string]any{"title": text(), "fields": map[string]any{"type": "array", "items": field, "minItems": 1, "maxItems": 6}}, "title", "fields")
	properties := map[string]any{"sections": map[string]any{"type": "array", "items": section, "minItems": 4, "maxItems": 4}}
	required := []string{"sections"}
	if kind == "method" {
		latex := map[string]any{"type": "string", "pattern": `^[^\u0000-\u001F]+$`}
		formula := object(map[string]any{"latex": latex, "explanation": text(), "page": page, "excerpt": excerpt, "evidenceID": reference}, "latex", "explanation", "page", "excerpt", "evidenceID")
		properties["formulas"] = map[string]any{"type": "array", "items": formula}
		required = append(required, "formulas")
	}
	encoded, _ := json.Marshal(object(properties, required...))
	return encoded
}

func (c *Client) generateReadingWithTimeout(ctx context.Context, kind, system, user string, temperature float64, timeout time.Duration) (string, error) {
	schema := readingOutputSchema(kind)
	if c.cfg.ProviderName() != "codex" || len(schema) == 0 {
		return c.GenerateWithTimeout(ctx, system, user, temperature, timeout)
	}
	if timeout <= 0 {
		timeout = RequestTimeout
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.operationTimeout(timeout))
	defer cancel()
	return c.streamCLIWithImages(requestCtx, []Message{{Role: "system", Content: system}, {Role: "user", Content: user}}, nil, nil, schema)
}
