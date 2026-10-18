use std::path::Path;

use crate::summary_loaders::SummaryCache;
use retainpdf_core::models::api::{
    to_absolute_url, BookSummaryView, JobFailureDiagnosticView,
    OcrJobSummaryView,
};
use retainpdf_core::models::domain::{JobFailureInfo, JobSnapshot, UploadRecord};
use retainpdf_files::source_file_name;
use retainpdf_core::storage_paths::resolve_source_pdf;

pub(super) fn build_book_summary(
    upload: Option<&UploadRecord>,
    summaries: &mut SummaryCache,
    job: &JobSnapshot,
    data_root: &Path,
    base_url: &str,
    display_name: &str,
) -> BookSummaryView {
    BookSummaryView {
        title: display_name.to_string(),
        authors: None,
        page_count: summaries.book_page_count(upload, job, data_root),
        source_language: Some(job.ocr_language().to_string())
            .filter(|value| !value.trim().is_empty()),
        target_language: None,
        source_file_name: source_file_name(upload, job),
        cover_url: cover_url(job, data_root, base_url),
        thumbnail_url: thumbnail_url(job, data_root, base_url),
        file_size_bytes: upload.map(|record| record.bytes),
    }
}

pub(super) fn cover_url(job: &JobSnapshot, data_root: &Path, base_url: &str) -> Option<String> {
    resolve_source_pdf(job, data_root).map(|_| job_image_url(job, base_url, "cover"))
}

pub(super) fn thumbnail_url(job: &JobSnapshot, data_root: &Path, base_url: &str) -> Option<String> {
    resolve_source_pdf(job, data_root).map(|_| job_image_url(job, base_url, "thumbnail"))
}

fn job_image_url(job: &JobSnapshot, base_url: &str, kind: &str) -> String {
    to_absolute_url(
        base_url,
        &format!("{}/{}/{}", job.workflow.job_api_prefix(), job.job_id, kind),
    )
}

pub(super) fn job_path_prefix(job: &JobSnapshot) -> &'static str {
    job.workflow.job_api_prefix()
}

/// OCR 摘要**不带失败简报**，这是个判断不是遗漏。
///
/// 这里能拿到的 `job` 是**外层那个任务**（通常是翻译任务），而 `artifacts` 里只有
/// `ocr_job_id / ocr_status / ocr_trace_id / ocr_provider_trace_id` —— 没有 OCR 任务
/// 自己的 failure。所以在这里填 `job.failure` 会把翻译任务的失败挂在 OCR 的 job_id
/// 下面，是错数据。要拿 OCR 自己的失败得按 ocr_job_id 回查一次库。
///
/// 而且没人需要：书籍详情页的 OCR 段吃的是 document jobs 列表里的 JobListItemView
/// （经 selectDocumentOcrStatusJob），和翻译段同一个来源；全仓搜 `ocr_job` 只有
/// domain/job/normalize.ts 原样转发一处，没人读 `ocr_job.failure`。
pub(super) fn build_ocr_job_summary(
    job: &JobSnapshot,
    base_url: &str,
) -> Option<OcrJobSummaryView> {
    let artifacts = job.artifacts.as_ref()?;
    let ocr_job_id = artifacts.ocr_job_id.as_ref()?;
    let detail_path = format!("/api/v1/jobs/{ocr_job_id}");
    Some(OcrJobSummaryView {
        job_id: ocr_job_id.clone(),
        status: artifacts.ocr_status.clone(),
        trace_id: artifacts.ocr_trace_id.clone(),
        provider_trace_id: artifacts.ocr_provider_trace_id.clone(),
        detail_path: detail_path.clone(),
        detail_url: to_absolute_url(base_url, &detail_path),
    })
}

pub(super) fn job_failure_to_legacy_view(failure: &JobFailureInfo) -> JobFailureDiagnosticView {
    let failure = failure.clone().with_formal_fields();
    JobFailureDiagnosticView {
        failed_stage: failure.failed_stage_value().to_string(),
        error_kind: failure.failure_code_value().to_string(),
        summary: failure.summary.clone(),
        root_cause: failure.root_cause.clone(),
        retryable: failure.retryable,
        upstream_host: failure.upstream_host.clone(),
        suggestion: failure.suggestion.clone(),
        last_log_line: failure.last_log_line.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use retainpdf_core::models::domain::{CreateJobInput, JobArtifacts};
    use retainpdf_files::{display_title, source_url_file_name};

    #[test]
    fn optional_upload_metadata_keeps_display_and_page_count_precedence() {
        let root = std::env::temp_dir().join(format!("retain-page-metadata-{}", fastrand::u64(..)));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("normalization.json"),
            r#"{"normalization":{"defaults":{"pages_seen":9}}}"#,
        )
        .unwrap();
        let mut job = JobSnapshot::new("job-fallback".into(), CreateJobInput::default(), vec![]);
        job.request_payload.source.source_url = "https://example.test/source.pdf?dl=1".into();
        job.artifacts = Some(JobArtifacts {
            pages_processed: Some(5),
            normalization_report_json: Some("normalization.json".into()),
            ..Default::default()
        });
        let mut upload = UploadRecord {
            upload_id: "upload".into(),
            filename: " upload.pdf ".into(),
            stored_path: root.join("upload.pdf").to_string_lossy().into_owned(),
            bytes: 20,
            page_count: 0,
            uploaded_at: "now".into(),
            developer_mode: false,
            content_hash: String::new(),
        };
        let mut summaries = SummaryCache::default();
        assert_eq!(display_title(Some(&upload), &job, &Default::default()), "upload.pdf");
        // A stored zero is still metadata, not a signal to substitute artifacts.
        assert_eq!(
            summaries.book_page_count(Some(&upload), &job, &root),
            Some(0)
        );
        assert_eq!(
            summaries.book_page_count(None, &job, &root),
            Some(5)
        );
        job.artifacts.as_mut().unwrap().pages_processed = None;
        assert_eq!(
            summaries.book_page_count(None, &job, &root),
            Some(9)
        );
        upload.filename = " ".into();
        assert_eq!(display_title(Some(&upload), &job, &Default::default()), "source.pdf");
        assert_eq!(source_file_name(None, &job), Some("source.pdf".into()));
        job.request_payload.source.source_url.clear();
        assert_eq!(display_title(None, &job, &Default::default()), "job-fallback");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_url_file_name_extracts_tail() {
        assert_eq!(
            source_url_file_name("https://example.com/files/paper.pdf?download=1#top"),
            Some("paper.pdf".to_string())
        );
    }

    #[test]
    fn source_url_file_name_rejects_empty_tail() {
        assert_eq!(source_url_file_name("https://example.com/files/"), None);
    }
}
