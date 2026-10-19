use std::sync::Arc;

use axum::body::to_bytes;

use crate::app::build_state;
use crate::test_support::config::TestDirs;

// 一页、指定尺寸的最小 PDF 在底座包里（书库包的测试也用），这里转一下，原有写法不变。
pub(crate) use retainpdf_api_base::test_fixtures::minimal_pdf_bytes;

pub(crate) fn test_state(test_name: &str) -> crate::AppState {
    let dirs = TestDirs::create(&format!(
        "rust-api-query-routes-{test_name}-{}",
        fastrand::u64(..)
    ));
    build_state(Arc::new(dirs.config())).expect("build state")
}

pub(crate) async fn read_json(response: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read body"),
    )
    .expect("parse json")
}

