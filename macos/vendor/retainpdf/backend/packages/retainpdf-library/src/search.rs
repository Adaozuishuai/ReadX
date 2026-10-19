//! Block full-text search.

use retainpdf_core::config::limits::MAX_SEARCH_LIMIT;
use retainpdf_api_base::error::AppError;
use retainpdf_core::models::api::{SearchQuery, SearchResultView};

use super::LibraryDeps;

pub fn search_blocks(
    deps: &LibraryDeps<'_>,
    query: &SearchQuery,
    owner: Option<&str>,
) -> Result<SearchResultView, AppError> {
    let document_id = query.document_id.trim();
    let hits = deps.db.search_blocks_for_owner(
        &query.q,
        query.limit.clamp(1, MAX_SEARCH_LIMIT),
        if document_id.is_empty() {
            None
        } else {
            Some(document_id)
        },
        owner,
    )?;
    Ok(SearchResultView {
        query: query.q.clone(),
        hits,
    })
}
