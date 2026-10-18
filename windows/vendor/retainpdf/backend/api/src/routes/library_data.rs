//! 图书馆数据层的最小 API:documents / 全文检索。
//! 前端图书馆改版前,现有 /api/v1/library/books 投影接口保持不动。
//!
//! All handlers go through library_api (PR2–PR4).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::auth::Principal;
use crate::error::AppError;
use crate::models::api::{
    ApiResponse, JobFilesQuery, ApplyDocumentMetadataSuggestionInput, CreateDocumentMetadataSuggestionInput,
    DocumentDeleteResultView, DocumentJobListView, DocumentListView,
    DocumentMetadataSuggestionApplyView, DocumentMetadataSuggestionListView,
    DocumentMetadataSuggestionView, DocumentRecord, JobSubmissionView, LibraryDeleteQuery,
    ListDocumentJobsQuery, ListDocumentMetadataSuggestionsQuery, ListDocumentsQuery,
    PatchDocumentInput, SearchQuery, SearchResultView,
};
use crate::models::request::CreateJobInput;
use crate::routes::common::{
    build_jobs_route_deps, build_library_route_deps, ok_json, request_base_url, run_job_query_once,
    ApiJson, ApiPath, ApiQuery,
};
use crate::routes::download_response::file_download_response;
use crate::services::library::{
    apply_document_metadata_suggestion_view, create_document_metadata_suggestion_view,
    delete_document_view, document_files, document_reading, document_translation_coverage,
    get_document, list_document_metadata_suggestions_view, list_documents, ocr_document_view,
    open_document_file, patch_document, search_blocks_view, translate_document_view, Disposition,
    DocumentFile, DocumentReadingView, TranslationCoverageView,
};
use crate::AppState;

// --- documents ---

pub async fn list_documents_route(
    State(state): State<AppState>,
    principal: Principal,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<ListDocumentsQuery>,
) -> Result<Json<ApiResponse<DocumentListView>>, AppError> {
    let deps = build_library_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(list_documents(&deps.library, &query, &base_url, principal.owner_filter())?))
}

pub async fn get_document_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Json<ApiResponse<DocumentRecord>>, AppError> {
    let deps = build_library_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(get_document(
        &deps.library,
        &document_id,
        &base_url,
    )?))
}

/// GET /api/v1/documents/:id/reading —— 阅读器该打开哪个任务。
///
/// 一个任务就覆盖了整本：返回它。多次范围翻译（或单个只覆盖一部分的任务）：按需生成
/// 合并目录，返回它的虚拟任务 id。生成要跑子进程，放进阻塞线程。
pub async fn get_document_reading_route(
    State(state): State<AppState>,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Json<ApiResponse<DocumentReadingView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(document_reading(&deps.library, &document_id).await?))
}

/// GET /api/v1/documents/:id/translation-coverage —— 翻译覆盖和任务记录（书籍详情「进度」）。
///
/// 只计算合并计划、不生成合并目录；读每个输出 PDF 的页数，放进阻塞线程。
pub async fn get_document_translation_coverage_route(
    State(state): State<AppState>,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Json<ApiResponse<TranslationCoverageView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(document_translation_coverage(&deps.library, &document_id).await?))
}

async fn document_file(
    state: &AppState,
    headers: &HeaderMap,
    document_id: &str,
    file: DocumentFile,
    disposition: Disposition,
) -> Result<Response, AppError> {
    let deps = build_library_route_deps(state);
    let download =
        open_document_file(&deps.library, &state.download_generation, document_id, file, disposition)
            .await?;
    file_download_response(download, headers).await
}

/// GET /api/v1/documents/:id/files —— 书本身有哪些文件（原文、封面、缩略图、原文页预览）。
pub async fn list_document_files_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Response, AppError> {
    let deps = build_library_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(document_files(&deps.library, &document_id, &base_url)?).into_response())
}

/// GET /api/v1/documents/:id/files/:name —— 默认在浏览器里打开，`?download=1` 直接下载。
pub async fn document_file_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath((document_id, name)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<JobFilesQuery>,
) -> Result<Response, AppError> {
    let disposition = if query.wants_download() { Disposition::Attachment } else { Disposition::Inline };
    document_file(&state, &headers, &document_id, DocumentFile::named(&name)?, disposition).await
}

/// GET /api/v1/documents/:id/files/pages/:page —— 原文那一页的预览图（`3.jpg`）。
pub async fn document_page_file_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath((document_id, page)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<JobFilesQuery>,
) -> Result<Response, AppError> {
    let file = DocumentFile::page(&page, &query)?;
    document_file(&state, &headers, &document_id, file, Disposition::Inline).await
}

/// GET /api/v1/documents/:id/source.pdf —— 旧地址，下载原文。
pub async fn download_document_source_pdf_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Response, AppError> {
    document_file(&state, &headers, &document_id, DocumentFile::SourcePdf, Disposition::Attachment).await
}

/// GET /api/v1/documents/:id/cover —— 旧地址。
pub async fn download_document_cover_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Response, AppError> {
    document_file(&state, &headers, &document_id, DocumentFile::Cover, Disposition::Unnamed).await
}

/// GET /api/v1/documents/:id/thumbnail —— 旧地址。
pub async fn download_document_thumbnail_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Result<Response, AppError> {
    document_file(&state, &headers, &document_id, DocumentFile::Thumbnail, Disposition::Unnamed).await
}

pub async fn patch_document_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    ApiJson(payload): ApiJson<PatchDocumentInput>,
) -> Result<Json<ApiResponse<DocumentRecord>>, AppError> {
    let deps = build_library_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(patch_document(
        &deps.library,
        &document_id,
        &payload,
        &base_url,
    )?))
}

pub async fn create_document_metadata_suggestion_route(
    State(state): State<AppState>,
    ApiPath(document_id): ApiPath<String>,
    ApiJson(input): ApiJson<CreateDocumentMetadataSuggestionInput>,
) -> Result<Json<ApiResponse<DocumentMetadataSuggestionView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(create_document_metadata_suggestion_view(
        &deps.library,
        &document_id,
        &input,
    )?))
}

pub async fn list_document_metadata_suggestions_route(
    State(state): State<AppState>,
    ApiPath(document_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ListDocumentMetadataSuggestionsQuery>,
) -> Result<Json<ApiResponse<DocumentMetadataSuggestionListView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(list_document_metadata_suggestions_view(
        &deps.library,
        &document_id,
        &query,
    )?))
}

pub async fn apply_document_metadata_suggestion_route(
    State(state): State<AppState>,
    ApiPath((document_id, suggestion_id)): ApiPath<(String, String)>,
    ApiJson(input): ApiJson<ApplyDocumentMetadataSuggestionInput>,
) -> Result<Json<ApiResponse<DocumentMetadataSuggestionApplyView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(apply_document_metadata_suggestion_view(
        &deps.library,
        &document_id,
        &suggestion_id,
        &input,
    )?))
}

/// DELETE /api/v1/documents/:id —— 彻底删除文档(行 + jobs + uploads + 文件)。
/// 被收藏引用 → 409;运行中 job 需 ?force=true。
pub async fn delete_document_route(
    State(state): State<AppState>,
    ApiPath(document_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<LibraryDeleteQuery>,
) -> Result<Json<ApiResponse<DocumentDeleteResultView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(delete_document_view(
        &deps.library,
        &document_id,
        query.force,
    )?))
}

// --- translate ---

/// POST /api/v1/documents/:id/translate
/// 复用馆藏文档已存的源 PDF 发起 book 翻译流水线，完成后 lifecycle 会回填 active_job_id。
pub async fn translate_document_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    ApiJson(request): ApiJson<CreateJobInput>,
) -> Result<Json<ApiResponse<JobSubmissionView>>, AppError> {
    let deps = build_library_route_deps(&state);
    let jobs = build_jobs_route_deps(&state).jobs;
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(translate_document_view(
        &deps.library,
        &jobs,
        &document_id,
        request,
        &base_url,
    )?))
}

/// POST /api/v1/documents/:id/ocr
/// Reuse the document's stored source PDF and create an OCR-only job.
pub async fn ocr_document_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    ApiJson(request): ApiJson<CreateJobInput>,
) -> Result<Json<ApiResponse<JobSubmissionView>>, AppError> {
    let deps = build_library_route_deps(&state);
    let jobs = build_jobs_route_deps(&state).jobs;
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    Ok(ok_json(
        ocr_document_view(&deps.library, &jobs, &document_id, request, &base_url).await?,
    ))
}

/// GET /api/v1/documents/:id/jobs
/// Return all OCR/translation runs associated with the document, newest first.
pub async fn list_document_jobs_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<ListDocumentJobsQuery>,
) -> Result<Json<ApiResponse<DocumentJobListView>>, AppError> {
    let deps = build_library_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let view = run_job_query_once(
        &state,
        format!("documents:jobs:{document_id}"),
        move |jobs| jobs.document_jobs_view(&base_url, &document_id, &query),
    )
    .await?;
    Ok(ok_json(view))
}

// --- search ---

pub async fn search_blocks_route(
    State(state): State<AppState>,
    principal: Principal,
    ApiQuery(query): ApiQuery<SearchQuery>,
) -> Result<Json<ApiResponse<SearchResultView>>, AppError> {
    let deps = build_library_route_deps(&state);
    Ok(ok_json(search_blocks_view(&deps.library, &query, principal.owner_filter())?))
}
