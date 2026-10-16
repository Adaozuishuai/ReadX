# Feature Specification — Figure-aware five-step reading

- **Target:** Extend v2's five-step paper analysis with extracted, high-resolution figures/tables, caption-aware placement and analysis, render formulas as LaTeX, and use Times New Roman for project digits.
- **Inputs:** Imported PDF, existing cached page text, existing five-step reading JSON.
- **Outputs:** Persisted per-paper figure catalog and crops; structured reading entries can reference catalog items and UI renders them beside relevant analysis; formulas render from LaTeX.
- **Success command:** `npm run build` from `v2`.
- **Base commit:** `87019df4e642c6cb97232d9d4bc450c847c6cc19`.
- **Scope cuts:** No changes to native macOS app; no changes to PDF source pixels; no unsupported claim of perfect semantic figure classification.
