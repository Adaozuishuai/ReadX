//! 文件（出口）：产物清单和打包（`artifacts`）、按需生成的派生产物（`derived_artifacts`）、
//! 同一份产物同时只生成一次（`download_generation`）、下载文件名（`download_names`）。
//! 任务的文件怎么取在 `jobs/files/`，书的文件在 `library/media.rs`，都往下用这里。

mod artifacts;
mod derived_artifacts;
mod download_generation;
mod download_names;

// 门面：包外只能用这里导出的东西，子模块都是私有的（见 BOUNDARIES.md「Domain Facades」）。
pub use artifacts::{
    artifact_is_direct_downloadable, build_artifacts_display, build_bundle_for_job,
    build_markdown_bundle_for_job, display_title, document_titles_for, job_upload_id,
    list_registry_for_job, resolve_registry_artifact, source_file_name, source_url_file_name,
    DocumentTitles,
};
pub use derived_artifacts::{
    document_artifacts_dir, job_artifacts_dir_path, DerivedArtifactDeps,
};
pub use derived_artifacts::pdf::linearized_pdf_or_original;
pub use derived_artifacts::preview::{
    ensure_book_image, ensure_document_book_image, ensure_page_preview, BookImageKind,
};
pub use derived_artifacts::side_by_side::{ensure_side_by_side_pdf, run_supervised};
pub use derived_artifacts::word::{ensure_layout_docx, LayoutDocxOptions};
pub use download_generation::{DownloadGeneration, FileDownload};
pub use download_names::{download_file_name, job_download_file_name, DownloadKind};
