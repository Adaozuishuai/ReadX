//! AI：AI 助手写在这本书里的东西（`/jobs/:id/ai/…`）。阅读路径、概念图、画板。
//!
//! 这些文件在任务目录的 `ai/` 下，AI 能随便写这个目录，所以只读固定的几个文件名，
//! 不并进 `files` 的出口（见 services/jobs/downloads/ai_board.rs）。

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::error::AppError;
use crate::models::api::ApiResponse;
use crate::routes::common::{build_jobs_download_route_deps, ApiPath};
use crate::routes::download_response::{ai_board_file_response, ai_document_response};
use crate::services::jobs::DocumentDownloadKind;
use crate::AppState;

pub async fn download_ai_reading_path(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let deps = build_jobs_download_route_deps(&state);
    ai_document_response(&deps, &headers, &job_id, DocumentDownloadKind::AiReadingPath).await
}

pub async fn download_ai_canvas(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let deps = build_jobs_download_route_deps(&state);
    ai_document_response(&deps, &headers, &job_id, DocumentDownloadKind::AiCanvas).await
}

/// agent 画板里有什么。目录不存在返回空列表，不是 404 —— 画板是叠加层，
/// 「还没往里放过」是正常状态。
///
/// 返回 `Response` 而不写出 `Json<ApiResponse<AiBoardListing>>`：路由只能经 facade 用服务，
/// 写出类型名就得从 services::jobs 导入这个 DTO、再给它开架构白名单。响应体完全一样。
pub async fn list_ai_board(
    State(state): State<AppState>,
    ApiPath(job_id): ApiPath<String>,
) -> Result<Response, AppError> {
    let deps = build_jobs_download_route_deps(&state);
    Ok(Json(ApiResponse::ok(deps.downloads.ai_board_listing(&job_id)?)).into_response())
}

/// 取画板里的一个文件。**这是唯一接受调用方文件名的 agent 产物端点**，
/// 防护（单层名、拒符号链接、解析后仍在目录内）在 services 那边，见
/// `services/jobs/downloads/ai_board.rs`。
pub async fn download_ai_board_file(
    State(state): State<AppState>,
    ApiPath((job_id, name)): ApiPath<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    ai_board_file_response(&build_jobs_download_route_deps(&state), &headers, &job_id, &name).await
}
