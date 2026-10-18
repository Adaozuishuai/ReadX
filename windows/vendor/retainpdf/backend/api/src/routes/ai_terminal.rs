//! `/api/v1/ai/terminal`：fx 终端的 WebSocket 代理。
//!
//! 浏览器 → rust_api → ai_service。中间这一跳不是多余的：ai_service 只监听
//! 回环，前端从不直连它（`/ai/ask` 也是这么走的），浏览器只认 rust_api 一个
//! 地址和一把凭据。
//!
//! ## 为什么这条路由不在 authenticated_api_routes 里
//!
//! 全局鉴权只读 `x-api-key` 请求头，而**浏览器的 WebSocket 构造函数设不了
//! 请求头**（W3C 规范的限制，不是我们偷懒）。所以这里自己做鉴权，同时接受
//! 查询参数。
//!
//! 只在这一条路由上接受 —— 放宽全局鉴权会把 key 写进每一条访问日志和
//! Referer，代价远大于收益。

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

use crate::app::AppState;
use crate::error::AppError;
use crate::routes::common::{build_ai_terminal_route_deps, ApiQuery};
use axum::response::IntoResponse;

/// ai_service 那一侧的路径。rust_api 只换地址，不改协议 —— 帧原样转发。
const UPSTREAM_PATH: &str = "/v1/fx/terminal";

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub cols: Option<u16>,
    #[serde(default)]
    pub rows: Option<u16>,
}

/// 握手鉴权：请求头或查询参数，任一命中即可。
///
/// 抽成纯函数是为了能直接测，不用起一个真的 WebSocket。
pub(crate) fn terminal_key_is_valid(
    api_keys: &std::collections::HashSet<String>,
    header_key: Option<&str>,
    query_key: &str,
) -> bool {
    // 没配 key 时一律拒：空集合上的 contains 本来就是 false，所以这里不需要
    // 单独判一次（写过一版，反证里发现它什么都不守，删了）。
    // 行为本身由 an_empty_key_set_admits_nobody 守着。
    let header_hit = header_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| api_keys.contains(value))
        .unwrap_or(false);
    header_hit || (!query_key.trim().is_empty() && api_keys.contains(query_key.trim()))
}

/// 把 ai_service 的 HTTP 基址换成 WebSocket 基址，并拼上查询参数。
///
/// 单独抽出来是因为 `http`→`ws` 的映射必须保住 TLS：`https` 要变 `wss`，
/// 掉成 `ws` 就是明文。
///
/// 转发的是浏览器那把 key —— 和 `/ai/ask` 一样（见 api.rs 的
/// `forwarded_api_key`），rust_api 与 ai_service 共用同一个 key 集合。
pub(crate) fn upstream_terminal_url(
    base_url: &str,
    query: &TerminalQuery,
    forwarded_key: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(base_url.trim_end_matches('/'))
        .map_err(|error| format!("invalid AI service base url: {error}"))?;
    let scheme = match url.scheme() {
        "https" | "wss" => "wss",
        _ => "ws",
    };
    url.set_scheme(scheme)
        .map_err(|_| "cannot switch AI service base url to a websocket scheme".to_string())?;
    url.set_path(UPSTREAM_PATH);
    // 基址上可能自带查询参数（配置里写全了地址的情况）。不清掉的话
    // append_pair 会叠出第二个 api_key，而上游按第一个解析 —— 可能是个过期的。
    url.set_query(None);
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("api_key", forwarded_key);
        if !query.session.is_empty() {
            pairs.append_pair("session", &query.session);
        }
        if let Some(cols) = query.cols {
            pairs.append_pair("cols", &cols.to_string());
        }
        if let Some(rows) = query.rows {
            pairs.append_pair("rows", &rows.to_string());
        }
    }
    Ok(url.into())
}

pub async fn terminal_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<TerminalQuery>,
    // Option 而不是直接提取：WebSocketUpgrade 的提取失败会在 handler 体执行
    // **之前**就回 400，于是没带 upgrade 头的未鉴权请求拿到的是 400 而不是
    // 401。鉴权结论不该取决于对方有没有发 upgrade 头。
    upgrade: Option<WebSocketUpgrade>,
) -> Response {
    let deps = build_ai_terminal_route_deps(&state);
    let header_key = headers.get("x-api-key").and_then(|value| value.to_str().ok());
    if !terminal_key_is_valid(deps.api_keys, header_key, &query.api_key) {
        // 升级前就拒：不要先握手成功再关，那样前端拿到的是「连上了又断」，
        // 分不清是鉴权失败还是终端挂了。
        return AppError::unauthorized("missing or invalid API key").into_response();
    }
    let forwarded_key = header_key
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| query.api_key.trim());
    let Some(upgrade) = upgrade else {
        return AppError::bad_request("terminal endpoint requires a websocket upgrade")
            .into_response();
    };
    let url = match upstream_terminal_url(deps.ai_service_base_url, &query, forwarded_key) {
        Ok(url) => url,
        Err(reason) => return AppError::bad_gateway(reason).into_response(),
    };
    upgrade.on_upgrade(move |socket| async move {
        if let Err(reason) = pump(socket, url).await {
            tracing::debug!(target: "ai_terminal", "terminal proxy ended: {reason}");
        }
    })
}

async fn pump(browser: WebSocket, url: String) -> Result<(), String> {
    let (upstream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|error| format!("AI service terminal unreachable: {error}"))?;
    let (mut browser_tx, mut browser_rx) = browser.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();

    // 两个方向各一个循环，任一方向结束就整体收摊 —— 单向关掉会留下一个只能
    // 收不能发的终端，用户看着像卡住了。
    let to_upstream = async {
        while let Some(Ok(message)) = browser_rx.next().await {
            let forwarded = match message {
                Message::Text(text) => UpstreamMessage::Text(text),
                Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
                Message::Ping(bytes) => UpstreamMessage::Ping(bytes),
                Message::Pong(bytes) => UpstreamMessage::Pong(bytes),
                Message::Close(_) => break,
            };
            if upstream_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let to_browser = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let forwarded = match message {
                UpstreamMessage::Text(text) => Message::Text(text),
                UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                UpstreamMessage::Ping(bytes) => Message::Ping(bytes),
                UpstreamMessage::Pong(bytes) => Message::Pong(bytes),
                UpstreamMessage::Close(_) => break,
                // tungstenite 的 Frame 是它内部的分片表示，不该透出去。
                UpstreamMessage::Frame(_) => continue,
            };
            if browser_tx.send(forwarded).await.is_err() {
                break;
            }
        }
        let _ = browser_tx.close().await;
    };
    tokio::select! {
        _ = to_upstream => {}
        _ = to_browser => {}
    }
    Ok(())
}
