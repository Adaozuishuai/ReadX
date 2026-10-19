//! 任务：有哪些任务、建一个、看一个。

use axum::routing::{get, post};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::lifecycle;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs", post(lifecycle::create_job).get(lifecycle::list_jobs))
        .route("/api/v1/jobs/:job_id", get(lifecycle::get_job))
}
