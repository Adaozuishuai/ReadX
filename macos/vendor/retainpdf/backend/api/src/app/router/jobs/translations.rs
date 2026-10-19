//! 译文：逐条看、人工改、重翻一条。

use axum::routing::{get, post};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::translations;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/translations", get(translations::list_translation_items))
        .route("/api/v1/jobs/:job_id/translation/items", get(translations::list_translation_items))  // 旧地址
        .route("/api/v1/jobs/:job_id/translations/:item_id", get(translations::get_translation_item).patch(translations::revise_translation_item_route))
        .route("/api/v1/jobs/:job_id/translation/items/:item_id", get(translations::get_translation_item).patch(translations::revise_translation_item_route))  // 旧地址
        .route("/api/v1/jobs/:job_id/translations/:item_id/revisions", get(translations::get_translation_item_revisions))
        .route("/api/v1/jobs/:job_id/translation/items/:item_id/revisions", get(translations::get_translation_item_revisions))  // 旧地址
        .route("/api/v1/jobs/:job_id/translations/:item_id/replay", post(translations::replay_translation_item_route))
        .route("/api/v1/jobs/:job_id/translation/items/:item_id/replay", post(translations::replay_translation_item_route))  // 旧地址
}
