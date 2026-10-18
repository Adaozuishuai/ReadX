//! 进度：跑到哪了。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::progress;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/progress/events", get(progress::get_job_events))
        .route("/api/v1/jobs/:job_id/events", get(progress::get_job_events))  // 旧地址
        .route("/api/v1/jobs/:job_id/progress/stream", get(progress::get_live_translation_events))
        .route("/api/v1/jobs/:job_id/live-events", get(progress::get_live_translation_events))  // 旧地址
        .route("/api/v1/jobs/:job_id/progress/layout", get(progress::get_live_translation_layout))
        .route("/api/v1/jobs/:job_id/live-translation/layout", get(progress::get_live_translation_layout))  // 旧地址
        .route("/api/v1/jobs/:job_id/progress/pages/:page", get(progress::get_live_translation_page))
        .route("/api/v1/jobs/:job_id/live-translation/pages/:page_idx", get(progress::get_live_translation_page))  // 旧地址
}
