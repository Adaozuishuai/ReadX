//! AI：AI 助手写在这本书里的东西。还没生成是正常状态：阅读路径、概念图返回 404，画板返回空列表。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::ai;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/ai/reading-path", get(ai::download_ai_reading_path))
        .route("/api/v1/jobs/:job_id/reading-path", get(ai::download_ai_reading_path))  // 旧地址
        .route("/api/v1/jobs/:job_id/ai/canvas", get(ai::download_ai_canvas))
        .route("/api/v1/jobs/:job_id/canvas", get(ai::download_ai_canvas))  // 旧地址
        .route("/api/v1/jobs/:job_id/ai/board", get(ai::list_ai_board))
        .route("/api/v1/jobs/:job_id/board", get(ai::list_ai_board))  // 旧地址
        .route("/api/v1/jobs/:job_id/ai/board/:name", get(ai::download_ai_board_file))
        .route("/api/v1/jobs/:job_id/board/:name", get(ai::download_ai_board_file))  // 旧地址
}
