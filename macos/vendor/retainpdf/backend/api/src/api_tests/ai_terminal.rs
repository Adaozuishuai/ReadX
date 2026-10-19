//! `/api/v1/ai/terminal` 的鉴权边界与上游 URL 构造。
//!
//! 不起真 WebSocket：这里要守的是「谁能进」和「往哪连」，两者都在握手之前就
//! 定下来了。真正的双向转发由 ai_service 侧的端到端测试覆盖。

use crate::api_tests::jobs_common::test_state;
use crate::routes::ai_terminal::{terminal_key_is_valid, upstream_terminal_url, TerminalQuery};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use std::collections::HashSet;
use std::time::Duration;
use tower::ServiceExt;

fn keys(values: &[&str]) -> HashSet<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn query(api_key: &str) -> TerminalQuery {
    TerminalQuery {
        api_key: api_key.to_string(),
        session: String::new(),
        cols: None,
        rows: None,
    }
}

#[test]
fn a_key_from_either_the_header_or_the_query_opens_the_handshake() {
    // 查询参数这条是给浏览器用的：WebSocket 构造函数设不了请求头。
    let allowed = keys(&["k"]);
    assert!(terminal_key_is_valid(&allowed, Some("k"), ""));
    assert!(terminal_key_is_valid(&allowed, None, "k"));
    assert!(terminal_key_is_valid(&allowed, Some("  k  "), ""));
}

#[test]
fn a_wrong_or_missing_key_is_rejected() {
    let allowed = keys(&["k"]);
    assert!(!terminal_key_is_valid(&allowed, Some("nope"), "nope"));
    assert!(!terminal_key_is_valid(&allowed, None, ""));
    assert!(!terminal_key_is_valid(&allowed, Some("   "), "   "));
}

#[test]
fn an_empty_key_set_admits_nobody() {
    // 没配 key 不等于谁都能进 —— 和 HTTP 那侧同一个立场。
    //
    // 这条守的是**行为**，不是某段代码：现在它由「空集合的 contains 返回
    // false」自然成立，将来谁要是加一条「没配 key 就放行」的开发便利分支，
    // 这里会红。
    assert!(!terminal_key_is_valid(&HashSet::new(), Some("k"), "k"));
}

#[test]
fn the_upstream_url_keeps_tls() {
    // https 掉成 ws 就是明文。这条如果错了，本机跑看不出来，
    // 一旦 ai_service 走 TLS 就静默降级。
    let url = upstream_terminal_url("https://ai.example", &query("k"), "k").unwrap();
    assert!(url.starts_with("wss://"), "{url}");

    let url = upstream_terminal_url("http://127.0.0.1:41100", &query("k"), "k").unwrap();
    assert!(url.starts_with("ws://"), "{url}");
}

#[test]
fn the_upstream_url_points_at_the_ai_service_terminal_path() {
    let mut request = query("browser-key");
    request.session = "job-7".to_string();
    request.cols = Some(120);
    request.rows = Some(40);
    let url = upstream_terminal_url("http://127.0.0.1:41100", &request, "browser-key").unwrap();
    assert!(url.contains("/v1/fx/terminal"), "{url}");
    assert!(url.contains("session=job-7"), "{url}");
    assert!(url.contains("cols=120"), "{url}");
    assert!(url.contains("rows=40"), "{url}");
    // 转发的是浏览器那把 key，和 /ai/ask 一样。
    assert!(url.contains("api_key=browser-key"), "{url}");
}

#[test]
fn the_upstream_url_carries_exactly_one_api_key() {
    // 基址上已经带了参数时不能叠出第二个 api_key —— 上游会按第一个解析，
    // 可能是个过期的。
    let url =
        upstream_terminal_url("http://127.0.0.1:41100/?api_key=stale", &query("k"), "k").unwrap();
    assert_eq!(url.matches("api_key=").count(), 1, "{url}");
    assert!(url.contains("api_key=k"), "{url}");
}

#[tokio::test]
async fn the_route_is_not_behind_the_header_only_middleware() {
    // 这条是这个文件里最重要的一条。全局的 require_api_key 只读请求头；如果
    // 有人把终端路由合回 authenticated_api_routes，浏览器带查询参数的握手会
    // 被中间件挡在 401，而本地用 curl 带 header 测又一切正常 —— 正是那种
    // 「开发机上好好的，浏览器里连不上」的故障。
    let state = test_state("ai-terminal-auth-boundary");
    let app = crate::app::build_app(state);

    // 不带任何 key：必须 401。
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/ai/terminal")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 带查询参数的 key：**不能**是 401。这不是真的 WebSocket 握手（没有
    // upgrade 头），所以 axum 会回 426/400 —— 那说明请求已经走到 handler，
    // 鉴权过了。
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/ai/terminal?api_key=test-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_ne!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "查询参数里的 key 被拒了 —— 终端路由多半被挂回了只读 header 的中间件",
    );
}

// ---------------------------------------------------------------- 帧转发

/// 起一个假的 ai_service：把收到的文本原样回吐，并主动先发一条。
/// 用真 WebSocket，因为要验的就是帧在两条真连接之间的搬运。
async fn start_fake_upstream() -> (String, tokio::task::JoinHandle<()>) {
    use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
    use axum::routing::get;

    let app = axum::Router::new().route(
        "/v1/fx/terminal",
        get(|upgrade: WebSocketUpgrade| async move {
            upgrade.on_upgrade(|mut socket| async move {
                let _ = socket
                    .send(WsMessage::Text(r#"{"type":"ready","pid":1}"#.into()))
                    .await;
                while let Some(Ok(message)) = socket.recv().await {
                    if let WsMessage::Text(text) = message {
                        let echo = format!(r#"{{"type":"output","data":{text}}}"#);
                        if socket.send(WsMessage::Text(echo)).await.is_err() {
                            break;
                        }
                    }
                }
            })
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, task)
}

#[tokio::test]
async fn frames_flow_in_both_directions_through_the_proxy() {
    // 这条守的是 pump()：上面那些单测只覆盖了「连不连得上」和「往哪连」，
    // 帧的搬运一个字节都没验过。
    let (upstream_base, upstream_task) = start_fake_upstream().await;
    let mut state = test_state("ai-terminal-pump");
    state.ai_gateway = std::sync::Arc::new(
        crate::services::ai::AiGateway::new(
            &crate::config::AiProxyConfig::default(),
            upstream_base,
            || crate::runtime::ai_supervisor::AI_STATUS_HEALTHY,
        )
        .unwrap(),
    );
    let app = crate::app::build_app(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_addr = listener.local_addr().unwrap();
    let proxy_task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let url = format!("ws://{proxy_addr}/api/v1/ai/terminal?api_key=test-key&session=s");
    let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // 上游主动发的第一帧要原样到达浏览器侧。
    let first = socket.next().await.unwrap().unwrap();
    assert!(
        matches!(&first, Message::Text(text) if text.contains("\"ready\"")),
        "没收到上游的首帧: {first:?}",
    );

    // 浏览器 → 上游 → 浏览器，中文要完整往返（帧不能被按字节切坏）。
    socket
        .send(Message::Text(r#""终端双向""#.into()))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("回程帧超时")
        .unwrap()
        .unwrap();
    match echoed {
        Message::Text(text) => {
            assert!(text.contains("终端双向"), "{text}");
            assert!(text.contains("\"output\""), "{text}");
        }
        other => panic!("期望文本帧，收到 {other:?}"),
    }

    upstream_task.abort();
    proxy_task.abort();
}
