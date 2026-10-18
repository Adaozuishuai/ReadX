use std::path::Path;

use retainpdf_data::db::Db;
use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::{
    build_artifact_links, build_artifact_manifest, ArtifactLinksView, JobArtifactManifestView,
    JobDetailView,
};
use retainpdf_core::models::domain::JobSnapshot;
use retainpdf_files::list_registry_for_job;

use crate::job_readiness;
use crate::actions::translation_request_recovery::load_translation_request_recovery_with_db;
use super::detail_projection::{
    build_artifact_projection, build_core_projection, build_failure_projection,
    build_live_projection, build_summary_projection, detail_readiness,
};

pub fn build_job_detail_view(
    db: &Db,
    data_root: &Path,
    job: &JobSnapshot,
    base_url: &str,
) -> JobDetailView {
    let (pdf_ready, markdown_ready, bundle_ready) = detail_readiness(job, data_root);
    let core = build_core_projection(job, base_url, pdf_ready, markdown_ready, bundle_ready);
    let live = build_live_projection(db, job, data_root);
    let artifacts = build_artifact_projection(
        job,
        data_root,
        base_url,
        pdf_ready,
        markdown_ready,
        bundle_ready,
    );
    let failure = build_failure_projection(job);
    let summary = build_summary_projection(db, data_root, job, base_url);

    JobDetailView {
        job_id: job.job_id.clone(),
        workflow: job.workflow.clone(),
        status: job.status.clone(),
        ocr_reused: job.source_job_id().is_some(),
        source_artifact_job_id: job.source_job_id().map(str::to_string),
        request_payload: core.request_payload,
        trace_id: core.trace_id,
        provider_trace_id: core.provider_trace_id,
        completion_note: crate::progress::stage_view::terminal_completion_note(job),
        stage_snapshot: live.stage_snapshot,
        background_snapshots: live.background_snapshots,
        stages: live.stages,
        timestamps: core.timestamps,
        links: core.links,
        actions: core.actions,
        artifacts: artifacts.links,
        artifacts_display: artifacts.display,
        book_summary: summary.book,
        contracts: summary.contracts,
        ocr_job: summary.ocr_job,
        ocr_provider_diagnostics: summary.ocr_provider_diagnostics,
        runtime: core.runtime,
        failure: failure.failure,
        error: failure.error,
        failure_diagnostic: failure.diagnostic,
        normalization_summary: summary.normalization,
        glossary_summary: summary.glossary,
        invocation: summary.invocation,
        translation_request_recovery: load_translation_request_recovery_with_db(db, job, data_root),
        log_tail: failure.log_tail,
    }
}

pub fn build_job_artifact_links_view(
    data_root: &Path,
    job: &JobSnapshot,
    base_url: &str,
) -> ArtifactLinksView {
    let (pdf_ready, markdown_ready, bundle_ready) = job_readiness(job, data_root);
    build_artifact_links(
        job,
        base_url,
        data_root,
        pdf_ready,
        markdown_ready,
        bundle_ready,
    )
}

pub fn build_job_artifact_manifest_view(
    db: &Db,
    data_root: &Path,
    job: &JobSnapshot,
    base_url: &str,
) -> Result<JobArtifactManifestView, AppError> {
    let items = list_registry_for_job(db, data_root, job)?;
    Ok(build_artifact_manifest(job, base_url, &items))
}
