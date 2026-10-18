//! Durable control plane for AI-invokable document workspaces.
//!
//! The first production executor interprets a closed page-program schema. The
//! control plane never executes model-generated Python, shell, binaries, paths,
//! packages, or environment selections on the host.

mod contracts;
mod control;
mod executor;
mod facade;
mod program;
mod workspace;

pub use contracts::{
    CancelDocumentOperationInput, CommitDocumentOperationInput, CreateDocumentOperationInput,
    DocumentOperationView, RunDocumentOperationInput, DOCUMENT_OPERATION_CANCEL_INPUT_SCHEMA,
    DOCUMENT_OPERATION_COMMIT_INPUT_SCHEMA, DOCUMENT_OPERATION_RUN_INPUT_SCHEMA,
};
pub use control::DocumentOperationControl;
pub use executor::{
    ControlPlanePreviewExecutor, DocumentOperationExecutor, RestrictedPageProgramExecutor,
    CONTROL_PLANE_PREVIEW_PROFILE, RESTRICTED_PAGE_PROGRAM_PROFILE,
};
#[cfg(test)]
pub use executor::ExecutorObservation;
pub use facade::{
    cancel_document_operation, commit_document_operation, create_document_operation,
    get_document_operation_view, run_document_operation,
};
#[cfg(any(test, feature = "test-fixtures"))]
pub use program::canonical_program_sha256;
pub use program::{RetainPdfPageProgram, RetainPdfPageProgramStep};
pub use workspace::OperationWorkspacePaths;

#[cfg(test)]
pub(crate) use executor::DeterministicExecutor;

#[cfg(test)]
mod tests;
