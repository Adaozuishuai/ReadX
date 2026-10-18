//! 任务的文件：`/jobs/:id/files/…`。
//!
//! 按"给谁用"分三组：`output/` 成品、`pages/` 译文页预览图、`internal/` 中间产物
//! （多用户模式下只给管理员，访问策略在 services::accounts::access）。默认在浏览器里打开，
//! `?download=1` 直接下载。旧地址（`/pdf`、`/artifacts/:key`……）还在，走同一个出口。

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};

use axum::Json;

use crate::auth::Principal;
use crate::error::AppError;
use crate::models::api::{
    ApiResponse, ArtifactDownloadQuery, ArtifactLinksView, JobArtifactManifestView, JobFilesQuery,
    LayoutDocxQuery, MarkdownQuery, PagePreviewQuery,
};
use crate::routes::common::{
    build_jobs_download_route_deps, build_jobs_query_route_deps, ok_json, request_base_url,
    run_job_query_once, ApiPath, ApiQuery,
};
use crate::routes::download_response::{file_download_response, job_file, markdown_response, ocr_job_file};
use crate::services::jobs::{Disposition, FileGroup, JobFile};
use crate::AppState;

/// 有哪些文件。网站账号看不到 `internal` 组。
pub async fn list_job_files(
    State(state): State<AppState>,
    principal: Principal,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let deps = build_jobs_query_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let include_internal = principal.is_admin();
    let view = run_job_query_once(&state, format!("jobs:files:{job_id}:{include_internal}"), move |jobs| {
        jobs.job_files_view(&base_url, &job_id, include_internal)
    })
    .await?;
    Ok(ok_json(view).into_response())
}

async fn named(
    state: &AppState,
    headers: &HeaderMap,
    job_id: &str,
    group: FileGroup,
    name: &str,
    query: &JobFilesQuery,
) -> Result<Response, AppError> {
    let deps = build_jobs_download_route_deps(state);
    let download = deps.downloads.open_named(job_id, group, name, query).await?;
    file_download_response(download, headers).await
}

pub async fn job_output_file(
    State(state): State<AppState>,
    ApiPath((job_id, name)): ApiPath<(String, String)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<JobFilesQuery>,
) -> Result<Response, AppError> {
    named(&state, &headers, &job_id, FileGroup::Output, &name, &query).await
}

pub async fn job_page_file(
    State(state): State<AppState>,
    ApiPath((job_id, page)): ApiPath<(String, String)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<JobFilesQuery>,
) -> Result<Response, AppError> {
    named(&state, &headers, &job_id, FileGroup::Pages, &page, &query).await
}

pub async fn job_internal_file(
    State(state): State<AppState>,
    ApiPath((job_id, name)): ApiPath<(String, String)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<JobFilesQuery>,
) -> Result<Response, AppError> {
    named(&state, &headers, &job_id, FileGroup::Internal, &name, &query).await
}

// ---- 旧地址（`/pdf`、`/docx`、`/artifacts/:key`、`/ocr/jobs/:id/…`……）----
// 只说"要哪个文件、在浏览器里打开还是下载"，怎么找都在 services::jobs 的 `open` 里。
// 各接口的打开方式是旧行为，钉在 docs/file-responses.txt 里。新代码用上面的 `/files/…`。

pub async fn download_pdf(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::TranslatedPdf, Disposition::Inline).await
}

pub async fn download_side_by_side_pdf(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::SideBySidePdf, Disposition::Attachment).await
}

pub async fn download_layout_docx(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<LayoutDocxQuery>,
) -> Result<Response, AppError> {
    let file = JobFile::translated_docx(&query);
    job_file(&state, &headers, &job_id, file, Disposition::Attachment).await
}

pub async fn download_cover(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::Cover, Disposition::Unnamed).await
}

pub async fn download_thumbnail(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::Thumbnail, Disposition::Unnamed).await
}

pub async fn download_page_preview(
    State(state): State<AppState>,
    ApiPath((job_id, page)): ApiPath<(String, u32)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<PagePreviewQuery>,
) -> Result<Response, AppError> {
    let file = JobFile::page(page, &query);
    job_file(&state, &headers, &job_id, file, Disposition::Unnamed).await
}

pub async fn download_artifact_by_key(
    State(state): State<AppState>,
    ApiPath((job_id, artifact_key)): ApiPath<(String, String)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<ArtifactDownloadQuery>,
) -> Result<Response, AppError> {
    let file = JobFile::from_artifact_key(&artifact_key, query.include_job_dir);
    job_file(&state, &headers, &job_id, file, Disposition::Attachment).await
}

pub async fn download_ocr_artifact_by_key(
    State(state): State<AppState>,
    ApiPath((job_id, artifact_key)): ApiPath<(String, String)>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<ArtifactDownloadQuery>,
) -> Result<Response, AppError> {
    let file = JobFile::from_artifact_key(&artifact_key, query.include_job_dir);
    ocr_job_file(&state, &headers, &job_id, file, Disposition::Attachment).await
}

pub async fn download_normalized_document(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = JobFile::Registered("normalized_document_json".into());
    job_file(&state, &headers, &job_id, file, Disposition::Unnamed).await
}

pub async fn download_ocr_normalized_document(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = JobFile::Registered("normalized_document_json".into());
    ocr_job_file(&state, &headers, &job_id, file, Disposition::Unnamed).await
}

pub async fn download_normalization_report(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = JobFile::Registered("normalization_report_json".into());
    job_file(&state, &headers, &job_id, file, Disposition::Unnamed).await
}

pub async fn download_ocr_normalization_report(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = JobFile::Registered("normalization_report_json".into());
    ocr_job_file(&state, &headers, &job_id, file, Disposition::Unnamed).await
}

pub async fn download_markdown(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<MarkdownQuery>,
) -> Result<Response, AppError> {
    markdown_response(
        &build_jobs_download_route_deps(&state),
        &headers,
        job_id,
        &query,
    )
    .await
}

pub async fn download_markdown_image(
    State(state): State<AppState>,
    ApiPath((job_id, path)): ApiPath<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::OcrImage(path), Disposition::Unnamed).await
}

pub async fn download_bundle(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    job_file(&state, &headers, &job_id, JobFile::All, Disposition::Attachment).await
}

pub async fn get_job_artifacts(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<ArtifactLinksView>>, AppError> {
    let deps = build_jobs_query_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let view = run_job_query_once(&state, format!("jobs:artifacts:{job_id}"), move |jobs| {
        jobs.job_artifacts_view(&base_url, &job_id, false)
    })
    .await?;
    Ok(ok_json(view))
}

pub async fn get_job_artifacts_manifest(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<JobArtifactManifestView>>, AppError> {
    let deps = build_jobs_query_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let view = run_job_query_once(&state, format!("jobs:manifest:{job_id}"), move |jobs| {
        jobs.job_artifact_manifest_view(&base_url, &job_id, false)
    })
    .await?;
    Ok(ok_json(view))
}

pub async fn get_ocr_job_artifacts(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<ArtifactLinksView>>, AppError> {
    let deps = build_jobs_query_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let view = run_job_query_once(&state, format!("ocr:artifacts:{job_id}"), move |jobs| {
        jobs.job_artifacts_view(&base_url, &job_id, true)
    })
    .await?;
    Ok(ok_json(view))
}

pub async fn get_ocr_job_artifacts_manifest(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Json<ApiResponse<JobArtifactManifestView>>, AppError> {
    let deps = build_jobs_query_route_deps(&state);
    let base_url = request_base_url(&headers, deps.default_port, &deps.bind_host);
    let view = run_job_query_once(&state, format!("ocr:manifest:{job_id}"), move |jobs| {
        jobs.job_artifact_manifest_view(&base_url, &job_id, true)
    })
    .await?;
    Ok(ok_json(view))
}
