use std::path::Path;

use retainpdf_core::models::api::BookSummaryView;
use retainpdf_core::models::domain::{JobSnapshot, UploadRecord};
use retainpdf_files::source_file_name;
use retainpdf_jobs::SummaryCache;

// 书名、上传编号、源文件名在 services::files::artifacts，页数在 SummaryCache —— 和任务列表共用
// 同一份规则，这里只拼书架要的摘要。封面地址由调用方按书的编号补上。
pub(super) fn build_book_summary(
    upload: Option<&UploadRecord>,
    summaries: &mut SummaryCache,
    job: &JobSnapshot,
    data_root: &Path,
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
        cover_url: None,
        thumbnail_url: None,
        file_size_bytes: upload.map(|record| record.bytes),
    }
}
