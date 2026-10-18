//! 操作：能对它做什么、去做。

use axum::routing::{get, post};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::actions;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/actions", get(actions::get_stage_actions))
        .route("/api/v1/jobs/:job_id/stage-actions", get(actions::get_stage_actions))  // 旧地址
        // GET 看续跑会从哪里开始，POST 去续跑。
        .route("/api/v1/jobs/:job_id/actions/resume", get(actions::get_resume_plan).post(actions::resume_job))
        .route("/api/v1/jobs/:job_id/resume-plan", get(actions::get_resume_plan))  // 旧地址
        .route("/api/v1/jobs/:job_id/resume", post(actions::resume_job))  // 旧地址
        .route("/api/v1/jobs/:job_id/actions/cancel", post(actions::cancel_job))
        .route("/api/v1/jobs/:job_id/cancel", post(actions::cancel_job))  // 旧地址
        .route("/api/v1/jobs/:job_id/actions/rerun", post(actions::rerun_job))
        .route("/api/v1/jobs/:job_id/rerun", post(actions::rerun_job))  // 旧地址
        .route("/api/v1/jobs/:job_id/actions/retry-stage", post(actions::retry_stage))
        .route("/api/v1/jobs/:job_id/retry-stage", post(actions::retry_stage))  // 旧地址
        .route("/api/v1/jobs/:job_id/actions/resolve-ocr-ambiguity", post(actions::resolve_ocr_ambiguity))
        .route("/api/v1/jobs/:job_id/ocr/resolve-ambiguity", post(actions::resolve_ocr_ambiguity))  // 旧地址
}
