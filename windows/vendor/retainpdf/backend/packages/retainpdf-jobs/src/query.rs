//! 只读查询的入口 `JobQueries`。各类的查询方法写在各自目录的 `queries.rs` 里；按编号取任务在 `retainpdf_api_base::job_loading`。

use std::path::Path;

use retainpdf_data::db::Db;
use retainpdf_api_base::error::AppError;
use retainpdf_api_base::job_loading::{load_ocr_job_with_supported_layout, load_supported_job};
use retainpdf_core::models::api::ListJobsQuery;
use retainpdf_core::models::domain::JobSnapshot;

/// Read-only job views require only persisted state and its artifacts, never a
/// launcher, upload service, or download/replay configuration.
pub struct JobQueries<'a> {
    pub(crate) db: &'a Db,
    pub(crate) data_root: &'a Path,
}

impl<'a> JobQueries<'a> {
    pub fn new(db: &'a Db, data_root: &'a Path) -> Self {
        Self { db, data_root }
    }

    pub(crate) fn load_supported_job_snapshot(
        &self,
        job_id: &str,
        ocr_only: bool,
    ) -> Result<JobSnapshot, AppError> {
        if ocr_only {
            load_ocr_job_with_supported_layout(self.db, self.data_root, job_id)
        } else {
            load_supported_job(self.db, self.data_root, job_id)
        }
    }
}

pub fn list_jobs_filtered(
    db: &Db,
    query: &ListJobsQuery,
) -> Result<Vec<JobSnapshot>, AppError> {
    Ok(db.select_jobs(
        &retainpdf_data::db::JobListSelection {
            status: query.status.as_ref(),
            workflow: query.workflow.as_ref(),
            provider: query.provider.as_deref(),
            limit: Some(query.limit.clamp(1, retainpdf_core::config::limits::MAX_JOB_LIMIT)),
            offset: query.offset,
            owner: query.owner.as_deref(),
            ..Default::default()
        },
        |_, _| true,
    )?)
}
