# Assumption Ledger — Figure-aware five-step reading
<!-- ASK mode: never -->

| ID | Under-determined by the request | Chosen | Class | Source |
|----|--------------------------------|--------|-------|--------|
| A-001 | How to retain extracted crops across app restarts | Recreate crops from the unchanged source PDF on demand when the five-step reading tab opens; keep the generated image URLs in memory; persist only model-returned catalog IDs in reading records | interface | default |
| A-002 | How to map figures/tables into five steps | Ask the model to return catalog IDs; validate IDs against the extracted catalog; use caption heuristics as fallback when absent | semantic | default |
| A-003 | What “high-definition original image” means for vector and raster PDFs | Render source-page crops at 3× PDF viewport scale, keeping the original PDF untouched | semantic | default |
| A-004 | Whether “all project numbers” includes imported paper pixels and machines without Times New Roman | App-rendered digit glyphs use locally installed Times New Roman where available; otherwise they use the existing app font stack. Imported PDF page pixels remain source material | interface | default |
| A-005 | Formula representation and rendering | Ask the model for raw LaTeX formula strings in a separate optional JSON array and typeset them client-side with KaTeX | interface | default |
| A-006 | Whether image crops are sent to the AI provider | Show the high-resolution crop beside the relevant analysis step and send caption/page metadata plus paper text to the model; do not send pixels because the configured providers do not share a vision-input contract | semantic | Source sweep |
| A-007 | How to avoid clipping figures whose extent is not encoded in caption text | Infer page half from the caption's horizontal position, but use a larger vertical context (up to 55% of page height) around it; full-width captions use the whole page width | semantic | Source sweep |
