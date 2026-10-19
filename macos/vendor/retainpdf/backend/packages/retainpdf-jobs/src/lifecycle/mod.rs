//! 任务：建任务（唯一入口 `submit_job`）、校验、发射、列表和详情，删任务时清理凭据。

pub(crate) mod creation;
pub mod launcher;
pub(crate) mod managed_credential_gc;
pub(crate) mod ocr_artifact_reuse;
mod queries;
pub mod snapshot_factory;
mod submission;
pub mod validation;

pub use creation::with_dev_translation_defaults;
#[cfg(any(test, feature = "test-fixtures"))]
pub use creation::{DevDefaultsGuard, DevTranslationDefaults};
