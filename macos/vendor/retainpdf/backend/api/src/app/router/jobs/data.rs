//! 数据：通用查询。登记表在契约 job-data.v1 里，新的读需求加一条登记，不加接口。

use axum::routing::{get};
use axum::Router;

use crate::app::AppState;
use crate::routes::jobs::data;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jobs/:job_id/data", get(data::job_data_catalog_route))
        .route("/api/v1/jobs/:job_id/data/:dataset", get(data::job_data_route))
}
