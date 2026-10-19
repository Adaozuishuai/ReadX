mod bundle;
mod presentation;
mod registry;
mod response;
mod titles;

pub use bundle::{build_bundle_for_job, build_markdown_bundle_for_job};
pub use presentation::build_artifacts_display;
pub use registry::{list_registry_for_job, resolve_registry_artifact};
pub use response::artifact_is_direct_downloadable;
pub use titles::{
    display_title, document_titles_for, job_display_title, job_upload_id, source_file_name,
    source_url_file_name, DocumentTitles,
};

#[cfg(test)]
mod tests;
