# Feature Specification — Figure-aware five-step reading

- **Target:** Extend v2's five-step paper analysis with extracted, high-resolution figures/tables, caption-aware placement and analysis, render formulas as LaTeX, and use Times New Roman for project digits.
- **Inputs:** Imported PDF, existing cached page text, existing five-step reading JSON.
- **Outputs:** On-demand per-session figure catalog and high-resolution source-page crops, recreated from the unchanged imported PDF when the reading panel opens; structured reading entries reference catalog items and the UI renders them beside the relevant step. The model receives captions, page numbers, and paper text for figure classification; it does not receive image pixels. Formulas render from LaTeX.
- **Success command:** `npm run build` from `v2`.
- **Base commit:** `87019df4e642c6cb97232d9d4bc450c847c6cc19`.
- **Scope cuts:** No changes to native macOS app; no changes to PDF source pixels; no standalone PDF image-object extraction; no unsupported claim of perfect semantic figure classification; visual classification is caption/text based because supported AI providers do not share a vision-input contract.
