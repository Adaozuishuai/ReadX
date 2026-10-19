//! 报告：跑完结果怎么样。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::reports;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/reports/quality", get(reports::quality_summary_route))
        .route("/api/v1/jobs/:job_id/quality-summary", get(reports::quality_summary_route))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/quality/items", get(reports::quality_items_route))
        .route("/api/v1/jobs/:job_id/quality-items", get(reports::quality_items_route))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/translation-qa", get(reports::get_translation_qa))
        .route("/api/v1/jobs/:job_id/translation/qa", get(reports::get_translation_qa))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/translation", get(reports::get_translation_diagnostics))
        .route("/api/v1/jobs/:job_id/translation/diagnostics", get(reports::get_translation_diagnostics))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/layout-fit", get(reports::get_fit_report))
        .route("/api/v1/jobs/:job_id/render/fit-report", get(reports::get_fit_report))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/refine", get(reports::get_refine_report))
        .route("/api/v1/jobs/:job_id/translation/refine-report", get(reports::get_refine_report))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/failure", get(reports::get_job_diagnostics))
        .route("/api/v1/jobs/:job_id/diagnostics", get(reports::get_job_diagnostics))  // 旧地址
        .route("/api/v1/jobs/:job_id/reports/usage", get(reports::job_usage_route))
        .route("/api/v1/jobs/:job_id/usage", get(reports::job_usage_route))  // 旧地址
}
