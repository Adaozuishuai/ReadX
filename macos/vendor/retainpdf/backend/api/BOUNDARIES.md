# Rust API Boundaries

This backend keeps route wiring, job orchestration, query scope checks, and view
projection separate. Keep new code on the narrowest layer that owns the
decision.

## Route Layer

Files under `src/routes/**` should only:

- extract Axum state, headers, path params, query params, and JSON bodies;
- compute HTTP-only context such as `base_url`;
- call domain facades (`crate::services::<domain>`, see "Domain Facades"
  below: `JobsFacade`, the library / glossary / upload view functions, the AI
  proxy, public document operations, and the backend-only Agent APIs) through
  deps builders in `routes/common.rs`;
- wrap results in `ApiResponse` or stream files via `stream_file` /
  `download_response`.

Routes should not read job files, inspect artifacts, merge event streams,
touch `state.db` / `state.config` directly, import internal services (e.g.
`derived_artifacts`), or construct view payloads from DB rows.

Job handlers under `src/routes/jobs/<category>.rs` call `JobsFacade` /
`JobQueries`, compute HTTP-only values such as `base_url`, and wrap typed views
in `ApiResponse`; they stay focused on extraction and delegation (see "Job
Routes" below for the nine categories).

`src/routes/download_response/**` is the file response boundary for job-backed
downloads, markdown documents, previews, covers, and thumbnails. Jobs and
library routes may both use it, but routes should not reach into another route
module to reuse a private download helper.

Create routes are the intentional input-side exception: they parse JSON or
multipart request bodies before delegating to `JobsFacade`, then still return a
typed `ApiResponse`. Library asset upload is the same pattern: multipart stays
in the route; persistence goes through `services::library::store_asset_view`.

AI routes follow the same boundary:

- `routes/ai_proxy.rs` streams ask bytes or buffers runtime config through
  `services::ai` (`ask`, `get_runtime_config`, `update_runtime_config`); it does
  not interpret the AI payload;
- `routes/public_document_operations.rs` delegates browser-safe queries and CAS
  actions to the public document operation functions of `services::ai`;
- `routes/document_operations.rs`, `agent_capabilities.rs`, and
  `agent_runtime_sessions.rs` are internal CLI/host adapters and delegate to
  their corresponding application APIs;
- public routes must never mint Agent capabilities or expose internal operation
  manifests, cursor endpoints, workspace paths, or credentials.

## Job Routes

`/api/v1/jobs/**` is split into nine categories with the same name in the
router (`src/app/router/jobs/<category>.rs`), the handlers
(`src/routes/jobs/<category>.rs`) and the business logic
(`src/services/jobs/<category>/`): `lifecycle`, `actions`, `progress`, `files`,
`reports`, `reader`, `translations`, `data`, `ai` (prefixes
`/jobs/:job_id/actions/…` and so on). A new job endpoint goes into the category that answers its question;
do not add top-level `/jobs/:job_id/<name>` paths.

Each legacy path is registered right below its new path, marked `// 旧地址`,
and points at the same handler, so both return exactly the same thing. Paths
are written out in full: `docs/routes.txt` and the path-parameter
classification test read the router sources. Legacy paths are removed only
after route usage shows no callers.

## Library Facade

Files under `src/services/library/**` implement library-domain use cases.
Routes import library work (books, documents, media, translate-from-library,
favorites, search, assets, conversations, collections) only from the
`services::library` facade; the route-facing view functions live in
`library/api.rs`.

- Routes use `build_library_route_deps` (`LibraryDeps` + `JobsFacade`).
- Translate-from-library binds a document's stored upload, then creates jobs
  only via `JobsFacade::create_document_submission`.
- Cover/thumbnail generation uses `derived_artifacts` inside `library/media`,
  not from routes.
- Library DTOs are re-exported through `models::api`; do not import
  `models::library` from routes or migrated `db/*` modules.

## API Contract Tests

HTTP-level tests under `src/api_tests/**` guard public route contracts:

- `http_contract.rs` owns the JSON envelope contract for success and common
  error responses.
- `jobs_events/**` owns event stream shape, source merging, and `seq` ordering.
- `jobs_reader/**`, `jobs_retry/**`, and translation debug tests own their
  public endpoint contracts.

Service unit tests should cover internal rules. Avoid mixing service fixtures,
HTTP envelope assertions, and frontend-facing event shape checks into one large
test file.

## Jobs Facade

`src/services/jobs/` is split into the same nine category directories as
`routes/jobs/` (`lifecycle`, `actions`, `progress`, `files`, `reports`,
`reader`, `translations`, `data`, `ai`). The root keeps only what every category
shares: `facade.rs` (the `JobsFacade` struct), `deps/`, `presentation/`,
`query.rs` (the `JobQueries` struct and job loading), `runtime_gateway.rs`,
`summary_loaders/` and `support.rs`.

Each use case is an `impl JobsFacade` / `impl JobQueries` block in its category
directory (read methods in `<category>/queries.rs`). They decide which service
operation to run and return typed views or download handles, and may call:

- `crate::job_loading` for loading and scope checks;
- `services/jobs/presentation/**` for public job/list/event view projection;
- the modules of their own category, and of another category where the work
  belongs there (e.g. `reports/failure.rs` uses `actions/resume_plan.rs`).

Callers outside `services/jobs/**` should not call presentation internals.

## Job Creation

Every new job goes through one entry point,
`submit_job(deps, NewJob)` (`src/services/jobs/lifecycle/creation/submit.rs`): `POST /jobs`,
`/ocr/jobs`, `/translate/bundle`, library translate/OCR, stage retry, rerun and
OCR-ambiguity recovery. The steps are written once, in this order: dev-stack
translation defaults, platform models (multi-user, before validation and before
any key reaches the credential vault), validation and snapshot by workflow,
credential import and usage lock, then persist (with the page-quota
reservation), link to the document, and launch.

`NewJob` carries what differs between callers: a file stored with the request
(`with_upload`), the job a retry derives ownership from (`derived_from`), the
document a library submission must land on (`for_document`), or the OCR
dispatch an ambiguity recovery resolves (`resolving_ocr_ambiguity`, persisted in
one transaction with that resolution and never charged).

Re-running an existing job in place (rerender, in-place render retry, refine)
uses `relaunch_in_place`, which refuses jobs that were never persisted.
`check_architecture.py` (`check_job_entry_ownership`) rejects any other module
that persists or launches a job. Internal `{id}-ocr` child jobs are created by
the job runtime, not here.

The outcome of every entry is pinned in `docs/submissions.txt`
(`src/api_tests/submissions.rs`).

## Job File Downloads

Every job file download goes through one entry point,
`JobDownloads::open(job_id, JobScope, JobFile, Disposition)`
(`src/services/jobs/files/downloads/files.rs`):

- `JobFile` names the file (translated PDF, side-by-side PDF, Word, OCR
  Markdown, cover, page preview, bundle, or any other registry key). Where to
  find it, its content type and its user-facing download name are written once,
  in `locate`.
- `JobScope::OcrOnly` is for the `/ocr/jobs/*` legacy aliases.
- `Disposition` says whether the browser opens the file (`Inline`), downloads it
  (`Attachment`), or gets no `Content-Disposition` (`Unnamed`, legacy endpoints
  only).

Routes only pick those three values; they do not resolve paths. Adding a file
means adding a `JobFile` variant and a `locate` branch, not another download
function. AI-written files under `<job>/ai/` (reading path, canvas, board) stay
outside `open` because that directory is agent-writable and only fixed names may
be read.

The response contract for all download endpoints is pinned in
`docs/file-responses.txt` (`src/api_tests/file_responses.rs`).

## Query Scope

`job_loading` in the `retainpdf-api-base` crate
(`backend/packages/retainpdf-api-base`, re-exported as `crate::job_loading`)
owns job loading and compatibility checks:

- missing job -> `404`;
- OCR-only scope checks;
- legacy layout rejection;
- merged-reading virtual job ids (`merged-<document>-<fingerprint>`), read-only.

It sits below `services` (jobs, files, library and merge all call it). Being a
separate crate, it cannot see `services`, `routes` or `AppState`. `AppError`
(`crate::error`) lives in the same crate. List filtering before presentation
stays in `src/services/jobs/query.rs`.

Do not put these checks in presentation code. Presentation should receive a job
that has already passed the route/facade scope.

## Domain Facades

`src/services/` holds exactly nine domain directories, one per future crate
(see `docs/ops/planning/api-reorg/20261015-模块化单体拆包规划.md`):
`accounts`, `providers`, `ingest`, `files`, `jobs`, `library`, `glossaries`,
`ai`, `platform`. A new module goes inside one of them;
`check_service_domains` rejects anything else at the top level.

Each domain's `mod.rs` is its only facade. Submodules are private (`mod x;`),
so the compiler rejects `crate::services::<domain>::<submodule>::…` from
outside the domain; what other domains, routes and app assembly need is
re-exported with `pub(crate) use` in one block marked `// 门面`. Items only tests
use sit under `#[cfg(test)]` in the same block. `check_domain_facades` rejects a
`pub mod` in a domain's `mod.rs`. Inside a domain, code may use any path.

A domain that has been split into its own crate is listed in
`EXTRACTED_DOMAINS` (so far: `accounts` → `backend/packages/retainpdf-accounts`, `ai` → `backend/packages/retainpdf-ai`, `files` → `backend/packages/retainpdf-files`, `glossaries` → `backend/packages/retainpdf-glossaries`, `ingest` → `backend/packages/retainpdf-ingest`, `jobs` → `backend/packages/retainpdf-jobs`, `library` → `backend/packages/retainpdf-library`, `platform` →
`backend/packages/retainpdf-platform`, `providers` → `backend/packages/retainpdf-providers`).
Its `lib.rs` is the facade, `services/mod.rs` re-exports it as
`services::<domain>` (`pub(crate) use retainpdf_glossaries as glossaries;`),
and nothing for it stays under `services/`. Exports only rust_api tests use sit
under `#[cfg(any(test, feature = "test-fixtures"))]`; rust_api turns the feature on in
`[dev-dependencies]` (`#[cfg(test)]` is not visible across crates), so production
builds never see them. It depends only on the base
crates (`retainpdf-api-base`, `retainpdf-core`, `retainpdf-data`; `retainpdf-ai` also
uses `retainpdf-proc` to stop operation workers; `retainpdf-jobs` also uses
`retainpdf-proc` and the job runtime `retainpdf-runner` behind `runtime_gateway`) and on
the crates of extracted domains below it (`retainpdf-accounts` uses
`retainpdf-providers`, `retainpdf-ingest` uses `retainpdf-accounts`, `retainpdf-jobs` uses
accounts, files, glossaries, ingest and providers, `retainpdf-library` uses files and jobs). Such a use is written with the crate name
(`retainpdf_providers::…`); `check_domain_dependency_direction` counts it as a
domain edge just like `crate::services::providers::…`.

Domains depend downward only. The allowed edges are listed in
`ALLOWED_DOMAIN_DEPENDENCIES` (`check_domain_dependency_direction` rejects a
new edge and an edge nothing uses any more):

```
library ─▶ jobs ─▶ ingest ─▶ accounts ─▶ providers
   │        ├────────────────▶ accounts
   │        ├────────────────────────────▶ providers
   │        ├─▶ glossaries
   └────────┴─▶ files
```

`accounts → providers` exists because platform settings (in `accounts`) test
provider connectivity. `check_service_dependency_cycles` also stays on, now at
domain level. `library::merge` (merged reading) depends on `files` and `jobs`,
never the other way: building the merged directory lives in
`services/library/merge/build.rs`, and reading a virtual job lives in
`job_loading`. `FileDownload` is defined in `files::download_generation`
(re-exported by `services::jobs`).

## Job Request Questions

Code that needs something from a job's submitted request asks the job:
`job.source_job_id()`, `job.uses_model_executor()`, `job.credential_refs()`
and the other methods in retainpdf-core `models/job/questions.rs`. Do not reach
into `job.request_payload.<field>`; add a method there instead. Only the
modules that build or rewrite the request (credential handling at creation,
rerun, retry-stage, the merged-reading virtual job) touch fields directly; they
are listed in `KNOWN_REQUEST_PAYLOAD_WRITERS` and the list only shrinks
(`check_request_payload_access`). Passing the whole request on (redaction,
public projection, snapshots) is fine.

## Presentation

`src/services/jobs/presentation/**` owns view construction for job detail, job
list, events, artifact links, and contracts.

Presentation should not become a general shared utility bucket. Shared data
loading that is needed outside presentation belongs in a sibling module under
`services/jobs/**`.

## Shared Job Projection Helpers

These modules are shared inside the jobs service and, where needed, by sibling
service projections such as `library::book_projection`:

- `src/services/jobs/progress/live_stage.rs`: combined event loading, canonical event
  projection, and live progress snapshots.
- `src/services/jobs/summary_loaders.rs`: normalized/translation summary file
  readers, plus `SummaryCache::book_page_count` (the one page-count rule for
  job lists, job detail and the bookshelf).

They are intentionally outside `presentation` so library/book projections do not
depend on job view internals.

Shared artifact display belongs to `src/artifacts/presentation.rs` in the
`retainpdf-files` crate, exposed only through `services::files::build_artifacts_display`. It consumes
`ArtifactLinksView` without loading jobs, files, or database records. Both book
and job views may depend on it; jobs must not import `book_projection` back.

The book title / upload id / source file name rules live once in
`src/artifacts/titles.rs` of the `retainpdf-files` crate (`display_title`, `job_upload_id`,
`source_file_name`); job and book projections call them instead of keeping
their own copies.

## Runner leaf dependencies

`ocr_flow/bundle_events`, `render_flow_artifacts`, and
`translation_flow_artifacts` consume only `JobPersistDeps` (database and data/output
roots). Orchestrators pass `&deps.persist`, not the full `ProcessRuntimeDeps`.
Architecture checks protect these modules and any nested modules from acquiring
global configuration or execution control capabilities again.

## Persistence

`../../database/retainpdf-db/src/db/**` should stay focused on SQLite rows and records.
It should not know about HTTP view contracts, route URLs, or frontend display
decisions.

## Models

`../packages/retainpdf-core/src/models/**` contains serializable input, job records, and
public view types. Model helpers can build plain data structures, but service
decisions such as file readiness, route scope, and event-source merging should
remain in services.
