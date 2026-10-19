//! 文件：产出了哪些文件、取一个。按"给谁用"分三组：output 成品 / pages 译文页预览 /
//! internal 中间产物（只给管理员）。旧地址和新文件名不是一一对应，单列在后面，
//! 对照表见 docs/api/07-产物下载/01-下载总览.md。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::files;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/files", get(files::list_job_files))
        .route("/api/v1/jobs/:job_id/files/output/*name", get(files::job_output_file))
        .route("/api/v1/jobs/:job_id/files/pages/:page", get(files::job_page_file))
        .route("/api/v1/jobs/:job_id/files/internal/*name", get(files::job_internal_file))
        .route("/api/v1/jobs/:job_id/pdf", get(files::download_pdf))  // 旧地址
        .route("/api/v1/jobs/:job_id/pdf/side-by-side", get(files::download_side_by_side_pdf))  // 旧地址
        .route("/api/v1/jobs/:job_id/docx", get(files::download_layout_docx))  // 旧地址
        .route("/api/v1/jobs/:job_id/markdown", get(files::download_markdown))  // 旧地址
        .route("/api/v1/jobs/:job_id/markdown/images/*path", get(files::download_markdown_image))  // 旧地址
        .route("/api/v1/jobs/:job_id/download", get(files::download_bundle))  // 旧地址
        .route("/api/v1/jobs/:job_id/preview/pages/:page", get(files::download_page_preview))  // 旧地址
        .route("/api/v1/jobs/:job_id/cover", get(files::download_cover))  // 旧地址
        .route("/api/v1/jobs/:job_id/thumbnail", get(files::download_thumbnail))  // 旧地址
        .route("/api/v1/jobs/:job_id/normalized-document", get(files::download_normalized_document))  // 旧地址
        .route("/api/v1/jobs/:job_id/normalization-report", get(files::download_normalization_report))  // 旧地址
        .route("/api/v1/jobs/:job_id/artifacts", get(files::get_job_artifacts))  // 旧地址
        .route("/api/v1/jobs/:job_id/artifacts-manifest", get(files::get_job_artifacts_manifest))  // 旧地址
        .route("/api/v1/jobs/:job_id/artifacts/:artifact_key", get(files::download_artifact_by_key))  // 旧地址
}
