# Build Note — Figure-aware five-step reading

| Rung | Feature | Acceptance check (ONE command) | Tier | Status |
|------|---------|-------------------------------|------|--------|
| F0 | Existing reader and reading generation remain the app spine | `npm run build` | MUST | ✅ |
| F1 | Extract captioned figures/tables and high-resolution page crops | `npm run build` | MUST | ✅ |
| F2 | Pass catalog into AI; map visual references to reading steps | `npm run build` | MUST | ✅ |
| F3 | Render linked figures/tables and LaTeX formulas in five-step UI | `npm run build` | MUST | ✅ |
| F4 | Apply Times New Roman to v2 app digit glyphs | `npm run build` | MUST | ✅ |

## Run record

- `npm run build` — exit 0. Shared, web (TypeScript + production Vite bundle), desktop TypeScript, and Go server builds passed after the feature changes.
- Tests were not run.

## Deferred
- Native macOS integration; the five-step PDF flow changed here is v2's React reader.
- Figures without readable text captions (for example image-only scanned pages) are not catalogued.
- Crops are rendered from the original PDF page at 3× scale and include nearby caption/context; embedded PDF image objects are not extracted as standalone media.

## Blockers
