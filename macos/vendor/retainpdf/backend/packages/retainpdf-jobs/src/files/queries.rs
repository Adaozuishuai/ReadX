use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::{ArtifactLinksView, JobArtifactManifestView};

use crate::presentation::{
    build_job_artifact_links_view, build_job_artifact_manifest_view,
};
use retainpdf_api_base::job_loading::load_supported_job;
use crate::query::JobQueries;

impl JobQueries<'_> {
    pub fn job_artifacts_view(
        &self,
        base_url: &str,
        job_id: &str,
        ocr_only: bool,
    ) -> Result<ArtifactLinksView, AppError> {
        let job = self.load_supported_job_snapshot(job_id, ocr_only)?;
        Ok(build_job_artifact_links_view(
            self.data_root,
            &job,
            base_url,
        ))
    }

    /// `/jobs/:id/files`：按 output / pages / internal 列出文件。`internal` 只给管理员。
    pub fn job_files_view(
        &self,
        base_url: &str,
        job_id: &str,
        include_internal: bool,
    ) -> Result<crate::JobFilesView, AppError> {
        let job = load_supported_job(self.db, self.data_root, job_id)?;
        crate::files::downloads::job_files_view(self.db, self.data_root, &job, include_internal, base_url)
    }

    pub fn job_artifact_manifest_view(
        &self,
        base_url: &str,
        job_id: &str,
        ocr_only: bool,
    ) -> Result<JobArtifactManifestView, AppError> {
        let job = self.load_supported_job_snapshot(job_id, ocr_only)?;
        build_job_artifact_manifest_view(self.db, self.data_root, &job, base_url)
    }
}
