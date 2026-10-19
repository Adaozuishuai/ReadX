//! Library domain services.
//!
//! Everything outside the domain goes through the facade at the bottom of this file; the
//! route-facing view functions live in `api`.

mod api;

mod assets;
mod book_projection;
mod books;
mod collection_workspace;
#[cfg(all(test, unix))]
mod collection_workspace_tests;
mod collections;
mod conversations;
mod documents;
#[cfg(all(test, unix))]
mod jobs_view_parity_tests;
mod media;
mod merge;
mod metadata_suggestions;
mod ocr;
mod reading;
mod search;
mod translate;
mod translate_plan;

// 门面：领域外只能用这里导出的东西，子模块都是私有的（见 BOUNDARIES.md「Domain Facades」）。
pub use api::{
    add_collection_documents_view, append_message_view, apply_document_metadata_suggestion_view,
    collection_agent_workspace, create_collection_view, create_conversation_view,
    create_document_metadata_suggestion_view, delete_collection_view, delete_conversation_view,
    delete_document_view, delete_library_book_view, document_files, document_reading,
    document_translation_coverage, fork_conversation_view, get_conversation_view, get_document,
    get_library_book_view, list_collections_view, list_conversations_view,
    list_document_metadata_suggestions_view, list_documents, list_library_books_view,
    load_asset_view, ocr_document_view, patch_collection_view, patch_conversation_view,
    patch_document, remove_collection_document_view, search_blocks_view, store_asset_view,
    translate_document_view, CollectionWorkspace, Disposition, DocumentReadingView,
    TranslationCoverageView,
};
pub use media::{open_document_file, DocumentFile};
// 只给测试用的。
#[cfg(test)]
pub(crate) use book_projection::{build_library_book_detail_view, build_library_book_list_view};

use std::path::Path;

use retainpdf_core::config::AssetConfig;
use retainpdf_data::db::Db;

use assets::{load_asset, store_asset, AssetDownload};
use books::{delete_library_book, get_library_book, list_library_books};
use collections::{
    add_collection_documents, create_collection, delete_collection, list_collections,
    patch_collection, remove_collection_document,
};
use conversations::{
    append_message, create_conversation, delete_conversation, fork_conversation, get_conversation,
    list_conversations, patch_conversation,
};
use documents::delete_document;
use media::document_files_view;
use metadata_suggestions::{
    apply_metadata_suggestion, create_metadata_suggestion, list_metadata_suggestions,
};
use ocr::ocr_document;
use search::search_blocks;
use translate::translate_document;

pub struct LibraryDeps<'a> {
    pub db: &'a Db,
    pub data_root: &'a Path,
    pub output_root: &'a Path,
    pub downloads_dir: &'a Path,
    /// Used for document cover/thumbnail generation via derived_artifacts.
    pub scripts_dir: &'a Path,
    pub python_bin: &'a str,
    /// 合并阅读（多次范围翻译拼一本）要跑 pipeline 生成合并目录。
    pub pipeline_command: &'a str,
    pub asset_config: &'a AssetConfig,
}
