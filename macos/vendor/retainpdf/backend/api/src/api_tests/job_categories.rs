//! `/jobs/:job_id` 下按 9 类分前缀的新地址和旧地址：同一个处理函数，返回必须一模一样。
//!
//! 只发不改状态的请求（GET，和一定被拒的 POST），对同一个任务各发一次，比状态码、类型和响应体。
//! 新地址要是注册错了（漏了、挂错处理函数、参数名没归类被多用户中间件拦下），这里会红。

use axum::body::{to_bytes, Body};
use axum::http::{header, Request};
use tower::util::ServiceExt;

use crate::api_tests::jobs_common::test_state;
use crate::api_tests::jobs_retry::common::{seed_translation_result_files, source_job_with_artifacts};
use crate::app::build_app;
use crate::models::{JobArtifacts, JobStatusKind};

const JOB: &str = "job-categories";

/// (方法, 新地址, 旧地址)，相对 `/api/v1/jobs/:job_id`。
const PAIRS: &[(&str, &str, &str)] = &[
    ("GET", "/actions", "/stage-actions"),
    ("GET", "/actions/resume", "/resume-plan"),
    ("GET", "/progress/events", "/events"),
    ("GET", "/progress/layout", "/live-translation/layout"),
    ("GET", "/progress/pages/0", "/live-translation/pages/0"),
    ("GET", "/reports/quality", "/quality-summary"),
    ("GET", "/reports/quality/items?kind=layout", "/quality-items?kind=layout"),
    ("GET", "/reports/translation-qa", "/translation/qa"),
    ("GET", "/reports/translation", "/translation/diagnostics"),
    ("GET", "/reports/layout-fit", "/render/fit-report"),
    ("GET", "/reports/refine", "/translation/refine-report"),
    ("GET", "/reports/failure", "/diagnostics"),
    ("GET", "/reports/usage", "/usage"),
    ("GET", "/reader/markdown", "/markdown/document"),
    ("GET", "/translations", "/translation/items"),
    ("GET", "/translations/p001-b001", "/translation/items/p001-b001"),
    ("GET", "/translations/p001-b001/revisions", "/translation/items/p001-b001/revisions"),
    ("GET", "/ai/reading-path", "/reading-path"),
    ("GET", "/ai/canvas", "/canvas"),
    ("GET", "/ai/board", "/board"),
    ("GET", "/ai/board/missing.html", "/board/missing.html"),
    // 请求体不合法，一定在动任务之前被拒。
    ("POST", "/actions/retry-stage", "/retry-stage"),
    ("POST", "/actions/resolve-ocr-ambiguity", "/ocr/resolve-ambiguity"),
];

/// 500 的响应里带一个每次都不同的错误编号，比之前去掉。
fn comparable(body: &[u8]) -> String {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::from_utf8_lossy(body).into_owned();
    };
    if value.pointer("/error/details/error_id").is_some() {
        value["message"] = serde_json::Value::Null;
        value["error"]["details"]["error_id"] = serde_json::Value::Null;
    }
    value.to_string()
}

async fn send(app: axum::Router, method: &str, uri: &str) -> (u16, String, Vec<u8>) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("X-API-Key", "test-key");
    let body = if method == "POST" {
        request = request.header(header::CONTENT_TYPE, "application/json");
        Body::from(r#"{"not_a_field": true}"#)
    } else {
        Body::empty()
    };
    let response = app.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap().to_vec();
    (status, content_type, body)
}

#[tokio::test]
async fn new_category_paths_answer_exactly_like_their_legacy_paths() {
    let state = test_state("job-categories");
    let mut job = source_job_with_artifacts(
        JOB,
        JobArtifacts {
            job_root: Some(format!("jobs/{JOB}")),
            source_pdf: Some(format!("jobs/{JOB}/source/input.pdf")),
            normalized_document_json: Some(format!("jobs/{JOB}/ocr/document.v1.json")),
            translations_dir: Some(format!("jobs/{JOB}/translated")),
            ..JobArtifacts::default()
        },
    );
    job.status = JobStatusKind::Succeeded;
    seed_translation_result_files(&state, &job);
    state.db.save_job(&job).unwrap();
    let app = build_app(state);

    let mut statuses = Vec::new();
    for (method, new, old) in PAIRS {
        let new_uri = format!("/api/v1/jobs/{JOB}{new}");
        let old_uri = format!("/api/v1/jobs/{JOB}{old}");
        let fresh = send(app.clone(), method, &new_uri).await;
        let legacy = send(app.clone(), method, &old_uri).await;
        assert_eq!(fresh.0, legacy.0, "{method} {new} vs {old}: status");
        assert_eq!(fresh.1, legacy.1, "{method} {new} vs {old}: content-type");
        assert_eq!(comparable(&fresh.2), comparable(&legacy.2), "{method} {new} vs {old}: body");
        assert_ne!(fresh.0, 405, "{method} {new}: not registered for this method");
        statuses.push(fresh.0);
    }
    // 不能全是 404：那说明任务没找到，比的只是两份一样的"找不到"。
    assert!(statuses.iter().filter(|status| **status == 200).count() >= 5, "{statuses:?}");
}
