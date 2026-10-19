//! `/jobs/:id/files/…` 的文件名表和文件清单。
//!
//! 任务的文件按"给谁用"分三组（见 docs/ops/planning/api-reorg/20261015-任务与文件接口整理.md）：
//! - `output/`：成品，给用户下载、在浏览器里看；
//! - `pages/`：译文单页预览图，给界面用；
//! - `internal/`：中间产物，给排查用，多用户模式下只给管理员（访问策略在 accounts::access）。
//!
//! 文件名一律是"内容.格式"。这里只把新文件名翻成 [`JobFile`]，找文件还是 `files.rs` 的 `locate`。

use std::path::Path;

use serde::Serialize;

use retainpdf_data::db::Db;
use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::{to_absolute_url, JobFilesQuery};
use retainpdf_core::models::domain::{JobSnapshot, JobStatusKind};
use retainpdf_files::{job_upload_id, list_registry_for_job};
use retainpdf_core::storage_paths::{resolve_job_root, resolve_markdown_path, resolve_output_pdf, resolve_source_pdf};

use crate::files::downloads::files::JobFile;
use crate::summary_loaders::SummaryCache;

/// `internal/` 组：新文件名 ↔ 产物清单里的名字。表在 retainpdf-core，产物清单返回的链接也用它。
use retainpdf_core::models::api::JOB_INTERNAL_FILES as INTERNAL_FILES;

const OCR_IMAGES_PREFIX: &str = "ocr/images/";

fn not_found(group: &str, name: &str) -> AppError {
    AppError::not_found(format!("no such file: {group}/{name}"))
}

/// 地址里的组：`/jobs/:id/files/<组>/<文件名>`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileGroup {
    Output,
    Pages,
    Internal,
}

/// 新地址的 `<组>/<文件名>` → 文件。
pub(crate) fn named_file(group: FileGroup, name: &str, query: &JobFilesQuery) -> Result<JobFile, AppError> {
    match group {
        FileGroup::Output => output_file(name, query),
        FileGroup::Pages => page_file(name, query),
        FileGroup::Internal => internal_file(name),
    }
}

/// `output/<name>` → 文件。
fn output_file(name: &str, query: &JobFilesQuery) -> Result<JobFile, AppError> {
    if let Some(image) = name.strip_prefix(OCR_IMAGES_PREFIX) {
        return Ok(JobFile::OcrImage(image.to_string()));
    }
    Ok(match name {
        "translated.pdf" => JobFile::TranslatedPdf,
        "side-by-side.pdf" => JobFile::SideBySidePdf,
        "translated.docx" => JobFile::translated_docx(&retainpdf_core::models::api::LayoutDocxQuery { dpi: query.dpi }),
        "ocr.md" => JobFile::OcrMarkdown,
        "ocr.zip" => JobFile::OcrMarkdownZip { include_job_dir: false },
        "all.zip" => JobFile::All,
        _ => return Err(not_found("output", name)),
    })
}

/// `pages/<页码>.jpg` → 译文那一页的预览图。原文页在书下面（`/documents/:id/files/pages/…`）。
fn page_file(name: &str, query: &JobFilesQuery) -> Result<JobFile, AppError> {
    let page = name
        .strip_suffix(".jpg")
        .and_then(|page| page.parse::<u32>().ok())
        .filter(|page| *page >= 1)
        .ok_or_else(|| not_found("pages", name))?;
    Ok(JobFile::page(
        page,
        &retainpdf_core::models::api::PagePreviewQuery {
            kind: "translated".to_string(),
            width: query.width,
            dpi: query.dpi,
        },
    ))
}

/// `internal/<name>` → 产物清单里的那一项。
fn internal_file(name: &str) -> Result<JobFile, AppError> {
    INTERNAL_FILES
        .iter()
        .find(|(file_name, _)| *file_name == name)
        .map(|(_, key)| JobFile::Registered((*key).to_string()))
        .ok_or_else(|| not_found("internal", name))
}

#[derive(Debug, Serialize)]
pub struct JobFilesView {
    pub job_id: String,
    pub output: Vec<JobFileEntryView>,
    pub pages: JobPagesView,
    /// 只有管理员（以及单机模式）能看到。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal: Option<Vec<JobFileEntryView>>,
}

#[derive(Debug, Serialize)]
pub struct JobFileEntryView {
    pub name: String,
    pub url: String,
    pub content_type: String,
    /// 现在能不能取到。按需生成的文件，这里表示生成它要的东西都在。
    pub ready: bool,
    /// 按需生成：第一次请求时才生成，会慢一些。
    pub on_demand: bool,
    /// 已经在磁盘上的文件才有大小。
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct JobPagesView {
    /// 把 `{page}` 换成页码（从 1 开始）。
    pub url_template: String,
    pub page_count: Option<i64>,
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().filter(|meta| meta.is_file()).map(|meta| meta.len())
}

fn exists(path: Option<std::path::PathBuf>) -> Option<std::path::PathBuf> {
    path.filter(|path| path.is_file())
}

pub fn job_files_view(
    db: &Db,
    data_root: &Path,
    job: &JobSnapshot,
    include_internal: bool,
    base_url: &str,
) -> Result<JobFilesView, AppError> {
    let files_path = format!("/api/v1/jobs/{}/files", job.job_id);
    let entry = |group: &str, name: &str, content_type: &str, ready: bool, on_demand: bool, size: Option<u64>| {
        JobFileEntryView {
            name: name.to_string(),
            url: to_absolute_url(base_url, &format!("{files_path}/{group}/{name}")),
            content_type: content_type.to_string(),
            ready,
            on_demand,
            size_bytes: size,
        }
    };
    let source = exists(resolve_source_pdf(job, data_root));
    let translated = exists(resolve_output_pdf(job, data_root));
    let markdown = exists(resolve_markdown_path(job, data_root));
    let job_root = resolve_job_root(job, data_root);

    let output = vec![
        entry("output", "translated.pdf", "application/pdf", translated.is_some(), false,
            translated.as_deref().and_then(file_size)),
        entry("output", "side-by-side.pdf", "application/pdf",
            source.is_some() && translated.is_some(), true, None),
        entry("output", "translated.docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            source.is_some() && job_root.is_some(), true, None),
        entry("output", "ocr.md", "text/markdown; charset=utf-8", markdown.is_some(), false,
            markdown.as_deref().and_then(file_size)),
        entry("output", "ocr.zip", "application/zip", markdown.is_some(), true, None),
        entry("output", "all.zip", "application/zip",
            matches!(job.status, JobStatusKind::Succeeded), true, None),
    ];

    let upload = job_upload_id(job).and_then(|id| db.get_upload(id).ok());
    let pages = JobPagesView {
        url_template: to_absolute_url(base_url, &format!("{files_path}/pages/{{page}}.jpg")),
        page_count: SummaryCache::default().book_page_count(upload.as_ref(), job, data_root),
    };

    let internal = if include_internal {
        let registry = list_registry_for_job(db, data_root, job)?;
        Some(
            INTERNAL_FILES
                .iter()
                .filter_map(|(name, key)| {
                    let item = registry.iter().find(|item| item.artifact_key == *key)?;
                    Some(entry("internal", name, &item.content_type, item.ready, false, item.size_bytes))
                })
                .collect(),
        )
    } else {
        None
    };

    Ok(JobFilesView {
        job_id: job.job_id.clone(),
        output,
        pages,
        internal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> JobFilesQuery {
        JobFilesQuery::default()
    }

    #[test]
    fn every_internal_name_maps_to_a_distinct_registry_key() {
        let mut keys: Vec<&str> = INTERNAL_FILES.iter().map(|(_, key)| *key).collect();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), INTERNAL_FILES.len());
        assert!(!keys.contains(&"layout_json"), "layout_json 和 provider_result_json 是同一个文件，只列一个");
    }

    #[test]
    fn names_resolve_to_files() {
        assert_eq!(output_file("translated.pdf", &query()).unwrap(), JobFile::TranslatedPdf);
        assert_eq!(
            output_file("ocr/images/page-1/fig.png", &query()).unwrap(),
            JobFile::OcrImage("page-1/fig.png".into())
        );
        assert_eq!(
            internal_file("ocr-provider/result.json").unwrap(),
            JobFile::Registered("provider_result_json".into())
        );
        assert!(page_file("3.jpg", &query()).is_ok());
    }

    #[test]
    fn unknown_names_are_404() {
        for result in [
            output_file("translated.PDF", &query()),
            output_file("../etc/passwd", &query()),
            page_file("3.png", &query()),
            page_file("x.jpg", &query()),
            page_file("0.jpg", &query()),
            internal_file("layout.json"),
        ] {
            assert!(matches!(result, Err(AppError::NotFound(_))));
        }
    }
}
