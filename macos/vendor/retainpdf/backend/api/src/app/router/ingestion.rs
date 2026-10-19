use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;

use crate::app::AppState;
use crate::routes::{jobs, uploads};

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/ocr/jobs",
            post(jobs::lifecycle::create_ocr_job)
                .get(jobs::lifecycle::list_ocr_jobs)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/api/v1/ocr/jobs/:job_id", get(jobs::lifecycle::get_ocr_job))
        .route(
            "/api/v1/ocr/jobs/:job_id/events",
            get(jobs::progress::get_ocr_job_events),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/artifacts",
            get(jobs::files::get_ocr_job_artifacts),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/artifacts-manifest",
            get(jobs::files::get_ocr_job_artifacts_manifest),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/artifacts/:artifact_key",
            get(jobs::files::download_ocr_artifact_by_key),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/normalized-document",
            get(jobs::files::download_ocr_normalized_document),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/normalization-report",
            get(jobs::files::download_ocr_normalization_report),
        )
        .route(
            "/api/v1/ocr/jobs/:job_id/cancel",
            post(jobs::actions::cancel_ocr_job),
        )
        .route(
            "/api/v1/uploads",
            post(uploads::upload_pdf).layer(DefaultBodyLimit::disable()),
        )
}
