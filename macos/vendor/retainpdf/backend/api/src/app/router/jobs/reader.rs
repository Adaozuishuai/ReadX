//! 阅读：阅读页要的东西。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::reader;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/reader/regions", get(reader::get_reader_regions))
        .route("/api/v1/jobs/:job_id/reader/metadata", get(reader::get_reader_metadata))
        .route("/api/v1/jobs/:job_id/reader/markdown", get(reader::get_markdown_document))
        .route("/api/v1/jobs/:job_id/markdown/document", get(reader::get_markdown_document))  // 旧地址
}
