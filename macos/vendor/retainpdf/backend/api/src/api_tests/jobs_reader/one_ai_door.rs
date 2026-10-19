//! 阅读器自己那套 AI 问答后端删干净了，而首页的 `/ai/ask` 不能被带走。
//!
//! 删之前一共有两套**零共用**的 LLM 栈：
//!
//! - `jobs/reader_ai/`（chunking + retrieval + llm + config，约 1300 行）走
//!   `POST /api/v1/jobs/:id/reader/ai/chat`，只服务阅读器那个 AI 问答面板；
//! - `services/ai/`（gateway + api，代理转发）走 `POST /api/v1/ai/ask`，服务
//!   首页的「问」。
//!
//! 而 `reader/ai/chat` 的路由注册行上自己写着 `deprecated: use POST /api/v1/ai/ask`
//! —— 两条路由服务同一件事，新旧并存。阅读页收成一扇门（终端里的 agent）之后，
//! 前一套整个删了。
//!
//! 这两条断言必须成对：只断言旧路由没了，把整个 AI 路由树删掉也能过。
//!
//! # 为什么用 GET 去探一条只注册过 POST 的路径
//!
//! 第一版写的是「POST 过去拿 404」。它是**假门禁**：把路由原样加回来那条照样
//! 绿 —— 因为 job-1 这个任务本来就不存在，handler 自己也返回 404。「路由没了」
//! 和「任务没了」在那条断言下长得一模一样（反证时实测）。
//!
//! axum 在路径匹配、方法不匹配时给 405。所以 GET 这条路径：
//! - 405 = 路由还在（只是方法不对）
//! - 404 = 路径根本没注册
//! 这个判别不依赖任何任务存不存在。

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::util::ServiceExt;

use crate::api_tests::jobs_common::test_state;
use crate::app::build_app;

async fn status_of(method: &str, uri: &str) -> StatusCode {
    build_app(test_state("one-ai-door"))
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("X-API-Key", "test-key")
                .header("content-type", "application/json")
                .body(Body::from("{}"))
                .expect("request"),
        )
        .await
        .expect("response")
        .status()
}

#[tokio::test]
async fn reader_ai_chat_route_is_gone() {
    let status = status_of("GET", "/api/v1/jobs/job-1/reader/ai/chat").await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "阅读器那条 deprecated 的问答路由还在服务（405 = 路径还注册着，只是方法不对）",
    );
}

/// 上面那条的判别依据本身得成立：同一个探法打在一条**还活着**的阅读器路由上，
/// 必须给 405 而不是 404。否则「GET 拿到 404」什么都不能说明。
#[tokio::test]
async fn the_probe_itself_distinguishes_missing_path_from_wrong_method() {
    assert_eq!(
        status_of("POST", "/api/v1/jobs/job-1/reader/metadata").await,
        StatusCode::METHOD_NOT_ALLOWED,
        "探针失效：路径存在、方法不对时没给 405，上面那条断言就没有判别力",
    );
}

#[tokio::test]
async fn home_ask_route_survives() {
    // 首页的「问」和阅读器那套是两回事：它是代理网关，没有 chunking/retrieval。
    // 这条不断言具体状态码（没有上游时它会失败），只要求**路由存在** ——
    // 404 才说明整棵 AI 路由树被误删了。
    let status = status_of("POST", "/api/v1/ai/ask").await;
    assert_ne!(
        status,
        StatusCode::NOT_FOUND,
        "首页的 /ai/ask 被一起删掉了",
    );
}
