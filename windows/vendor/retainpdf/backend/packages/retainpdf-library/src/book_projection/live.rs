use std::path::Path;

use retainpdf_data::db::Db;
use retainpdf_core::models::api::JobProgressView;
use retainpdf_core::models::domain::JobSnapshot;
use retainpdf_jobs::{build_job_stage_view, load_live_stage_snapshot, LiveStageSnapshot};

pub(super) struct BookLiveProjection {
    pub stage: Option<String>,
    pub stage_detail: Option<String>,
    pub progress: JobProgressView,
}

pub(super) fn build_live_projection(
    db: &Db,
    job: &JobSnapshot,
    data_root: &Path,
) -> BookLiveProjection {
    let live_stage = load_live_stage_snapshot(db, job, data_root);
    project_live_stage(job, live_stage.as_ref())
}

pub(super) fn project_live_stage(
    job: &JobSnapshot,
    live_stage: Option<&LiveStageSnapshot>,
) -> BookLiveProjection {
    let stage = build_job_stage_view(job, live_stage);
    BookLiveProjection {
        stage: stage.stage,
        stage_detail: stage.stage_detail,
        progress: stage.progress,
    }
}
