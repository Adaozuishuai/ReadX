//! 一本书「该读哪里」相关的三个读接口：阅读入口、翻译覆盖、合集 agent 工作区。
//!
//! 以前这三段直接写在路由里（自己拿 state.db / state.config、全路径调 services::library::merge），
//! 违反了路由只经 application facade 的边界（check_architecture.py）。挪到这里，路由只传
//! LibraryDeps。都要跑子进程或读 PDF 页数，放进阻塞线程。

use std::path::Path;

use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::DocumentRecord;
use super::collection_workspace::{ensure_collection_workspace, CollectionWorkspace, ReadingBook};
use retainpdf_files::DerivedArtifactDeps;
use crate::merge::coverage::{translation_coverage, TranslationCoverageView};
use crate::merge::reading::{resolve_reading_target, DocumentReadingView, ReadingTarget};

use super::documents::get_document;
use super::media::document_source;
use super::LibraryDeps;

/// 阻塞线程里要用的那几样，全部持有所有权。
struct OwnedReadingDeps {
    db: retainpdf_data::db::Db,
    data_root: std::path::PathBuf,
    python_bin: String,
    pipeline_command: String,
}

impl OwnedReadingDeps {
    fn from(deps: &LibraryDeps<'_>) -> Self {
        Self {
            db: deps.db.clone(),
            data_root: deps.data_root.to_path_buf(),
            python_bin: deps.python_bin.to_string(),
            pipeline_command: deps.pipeline_command.to_string(),
        }
    }
}

/// GET /documents/:id/reading：一个任务就覆盖了整本，返回它；多次范围翻译（或只覆盖一部分
/// 的任务）按需生成合并目录，返回虚拟任务 id。
pub async fn document_reading(
    deps: &LibraryDeps<'_>,
    document_id: &str,
) -> Result<DocumentReadingView, AppError> {
    let (_document, source_pdf) = document_source(deps.db, deps.data_root, document_id)?;
    let owned = OwnedReadingDeps::from(deps);
    let document_id = document_id.to_string();
    tokio::task::spawn_blocking(move || {
        let artifact_deps = DerivedArtifactDeps::with_pipeline_command(&owned.python_bin, &owned.pipeline_command);
        resolve_reading_target(&owned.db, &owned.data_root, artifact_deps, &document_id, &source_pdf)
            .map(|target| target.view(&owned.data_root))
    })
    .await
    .map_err(|_| AppError::internal("document reading task failed"))?
}

/// GET /documents/:id/translation-coverage：只算合并计划，不生成合并目录。
pub async fn document_translation_coverage(
    deps: &LibraryDeps<'_>,
    document_id: &str,
) -> Result<TranslationCoverageView, AppError> {
    let page_count = get_document(deps, document_id, "")?.page_count;
    let owned = OwnedReadingDeps::from(deps);
    let document_id = document_id.to_string();
    tokio::task::spawn_blocking(move || translation_coverage(&owned.db, &owned.data_root, &document_id, page_count))
        .await
        .map_err(|_| AppError::internal("translation coverage task failed"))?
}

/// 物化合集的 agent 工作区。多次范围翻译的书链到阅读入口指的合并目录。
pub async fn collection_agent_workspace(
    deps: &LibraryDeps<'_>,
    collection_id: &str,
) -> Result<CollectionWorkspace, AppError> {
    let owned = OwnedReadingDeps::from(deps);
    let collection_id = collection_id.to_string();
    tokio::task::spawn_blocking(move || {
        let artifact_deps = DerivedArtifactDeps::with_pipeline_command(&owned.python_bin, &owned.pipeline_command);
        let reading_book = |document: &DocumentRecord| {
            let upload = owned.db.find_upload_for_document(&document.document_id).ok()??;
            let target = resolve_reading_target(
                &owned.db,
                &owned.data_root,
                artifact_deps,
                &document.document_id,
                Path::new(&upload.stored_path),
            )
            .ok()?;
            match target {
                ReadingTarget::Merged { job_id, merged } => Some(ReadingBook { job_id, root: merged.root }),
                // 单个任务、没有译文：交回原来那套按 active_job 的逻辑。
                _ => None,
            }
        };
        ensure_collection_workspace(&owned.db, &owned.data_root, &collection_id, &reading_book)
    })
    .await
    .map_err(|_| AppError::internal("collection workspace task failed"))?
}
