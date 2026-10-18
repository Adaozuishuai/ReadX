use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::{
    DocumentJobListView, JobDetailView, JobListView, ListDocumentJobsQuery, ListJobsQuery,
};

use crate::presentation::{
    build_document_job_list_view, build_job_detail_view, build_job_list_view,
};
use crate::query::JobQueries;

impl JobQueries<'_> {
    pub fn document_jobs_view(
        &self,
        base_url: &str,
        document_id: &str,
        query: &ListDocumentJobsQuery,
    ) -> Result<DocumentJobListView, AppError> {
        self.db
            .get_document(document_id)
            .map_err(|_| AppError::not_found(format!("document not found: {document_id}")))?;
        build_document_job_list_view(self.db, self.data_root, document_id, query, base_url)
    }

    pub fn list_jobs_view(
        &self,
        base_url: &str,
        query: &ListJobsQuery,
    ) -> Result<JobListView, AppError> {
        build_job_list_view(self.db, self.data_root, query, base_url)
    }

    pub fn job_detail_view(
        &self,
        base_url: &str,
        job_id: &str,
        ocr_only: bool,
    ) -> Result<JobDetailView, AppError> {
        let job = self.load_supported_job_snapshot(job_id, ocr_only)?;
        Ok(build_job_detail_view(
            self.db,
            self.data_root,
            &job,
            base_url,
        ))
    }
}
