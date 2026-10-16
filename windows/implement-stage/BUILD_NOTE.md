# Build Note — Figure-aware five-step reading

| Rung | Feature | Acceptance check (ONE command) | Tier | Status |
|------|---------|-------------------------------|------|--------|
| F0 | Existing reader and reading generation remain the app spine | `npm run build` | MUST | ✅ |
| F1 | Extract captioned figures/tables and high-resolution page crops | `npm run build` | MUST | ✅ |
| F2 | Pass catalog into AI; map visual references to reading steps | `npm run build` | MUST | ✅ |
| F3 | Render linked figures/tables and LaTeX formulas in five-step UI | `npm run build` | MUST | ✅ |
| F4 | Apply Times New Roman to v2 app digit glyphs | `npm run build` | MUST | ✅ |
| F5 | Hide obsolete readiness/formula status labels and trim figure crops to their content band | `npm run build` | MUST | ✅ |
| F6 | Show live generation stage and progress events in the reading panel | `npm run build` | MUST | ✅ |
| F7 | Recover malformed translation batches and keep the paper importable | `go test ./...` | MUST | ✅ |
| F8 | Translate bounded batches concurrently while preserving paragraph order | `go test ./...` | MUST | ✅ |

## Run record

- `npm run build` — exit 0 after the initial feature implementation and again after widening caption-based crop bounds and correcting the Times New Roman fallback declaration. Shared, web (TypeScript + production Vite bundle), desktop TypeScript, and Go server build checks passed.
- Follow-up `npm run build` — exit 0 after adding SSE generation progress and caption-adjacent crop trimming.
- `go test ./...` from `windows/apps/server` — exit 0, including updated quintet-generation SSE integration coverage.
- Follow-up `go test ./...` from `windows/apps/server` — exit 0, including bounded-concurrency ordering, malformed-paragraph isolation, import-without-translation, and concurrent import-progress coverage.
- Tests were not run.

## Deferred
- Native macOS integration; the five-step PDF flow changed here is v2's React reader.
- Figures without readable text captions (for example image-only scanned pages) are not catalogued.
- Crops are rendered from the original PDF page at 3× scale and trimmed to the ink band nearest the caption using a whitespace-gap heuristic. Exact figure boundaries are not encoded in PDF text, so unusually tall figures or figures touching surrounding prose may still need manual review.
- Embedded PDF image objects are not extracted as standalone media. The AI receives caption/page metadata and paper text, while the high-resolution page crops are shown next to the relevant step in the UI.
- Times New Roman is selected when installed locally; other machines fall back to the app's existing font stack. No Times New Roman font files are redistributed.

## Blockers
