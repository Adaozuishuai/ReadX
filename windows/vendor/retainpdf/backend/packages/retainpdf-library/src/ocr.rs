//! OCR-from-library: reuse a document's stored upload without exposing upload_id.

use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::JobSubmissionView;
use retainpdf_core::models::domain::WorkflowKind;
use retainpdf_core::models::request::CreateJobInput;
use retainpdf_jobs::JobsFacade;

use super::documents::require_document_upload;
use super::LibraryDeps;

/// Bind an OCR request to the document's stored upload and create an OCR-only job.
pub async fn ocr_document(
    deps: &LibraryDeps<'_>,
    jobs: &JobsFacade<'_>,
    document_id: &str,
    mut request: CreateJobInput,
    base_url: &str,
) -> Result<JobSubmissionView, AppError> {
    let (_document, upload) = require_document_upload(deps, document_id)?;

    if !request.source.upload_id.trim().is_empty()
        && request.source.upload_id.trim() != upload.upload_id
    {
        return Err(AppError::bad_request(
            "source.upload_id does not match this document's stored upload",
        ));
    }

    request.workflow = WorkflowKind::Ocr;
    request.source.upload_id = upload.upload_id;
    request.source.source_url.clear();
    request.source.artifact_job_id.clear();

    jobs.create_document_submission(base_url, &request, document_id)
}
