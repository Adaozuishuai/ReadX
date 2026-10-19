> 历史实现记录。当前双端架构与验证入口以 `../../docs/architecture.md` 和 `../README.md` 为准；下文不能作为本次 macOS 验收结果。

# Feature Specification — Figure-aware five-step reading

- **Target:** Improve v2 paper ingestion so malformed paragraph-translation JSON cannot discard a paper, parallelize translation batches, and report any untranslated text. Preserve caption-indexed high-resolution figure/table crops, five-step analysis, LaTeX formulas, Times New Roman app digits, and live generation progress.
- **Inputs:** Imported PDF, existing cached page text, existing five-step reading JSON.
- **Outputs:** On-demand per-session figure catalog and high-resolution source-page crops, recreated from the unchanged imported PDF when the reading panel opens; image crops are trimmed to the content band next to their caption. Structured reading entries reference catalog items and the UI renders them beside the relevant step. The model receives captions, page numbers, and paper text for figure classification; it does not receive image pixels. Formulas render from LaTeX. Generation reports preparation, model, evidence-check, and save stages through SSE.
- **Import translation:** Translate at most three batches concurrently. Retry malformed responses, recursively split structurally invalid batches, and leave a persistent single-paragraph format failure untranslated while importing the source paper and original text pages. Do not save empty translations; show a warning on the import result.
- **Success command:** `npm run build` from `v2`.
- **Base commit:** `87019df4e642c6cb97232d9d4bc450c847c6cc19`.
- **Scope cuts:** No changes to native macOS app; no changes to PDF source pixels; no standalone PDF image-object extraction; no unsupported claim of perfect semantic figure classification; visual classification is caption/text based because supported AI providers do not share a vision-input contract.
