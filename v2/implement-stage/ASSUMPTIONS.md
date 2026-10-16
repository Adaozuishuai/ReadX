# Assumption Ledger — Figure-aware five-step reading
<!-- ASK mode: never -->

| ID | Under-determined by the request | Chosen | Class | Source |
|----|--------------------------------|--------|-------|--------|
| A-001 | How to retain extracted crops across app restarts | Recreate crops from the unchanged source PDF on demand when the five-step reading tab opens; keep the generated image URLs in memory | interface | default |
| A-002 | How to map figures/tables into five steps | Ask the model to return catalog IDs; validate IDs against the extracted catalog; use caption heuristics as fallback when absent | semantic | default |
| A-003 | What “high-definition original image” means for vector and raster PDFs | Render source-page crops at 3× PDF viewport scale, keeping the original PDF untouched | semantic | default |
| A-004 | Whether “all project numbers” includes imported paper pixels | Apply Times New Roman only to digit glyphs in app-rendered text; PDF page pixels remain source material | interface | default |
| A-005 | Formula representation and rendering | Ask the model for raw LaTeX formula strings in a separate optional JSON array and typeset them client-side with KaTeX | interface | default |
