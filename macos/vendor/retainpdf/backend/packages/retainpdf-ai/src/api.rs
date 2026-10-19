//! HTTP application facade for the retainpdf-ai reverse proxy.

use axum::body::Body;
use axum::http::{header::HeaderName, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::Value;

use super::AiGateway;
use retainpdf_api_base::error::AppError;

fn forwarded_api_key(headers: &HeaderMap) -> &str {
    headers
        .get("X-API-Key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

/// 用户的凭据在 Rust 这层已经验过；AI 服务再回 401 / 403，只能是 Rust 与 AI 之间的内部凭据配错了。
/// 不能原样转给浏览器：前端把 401 当成「登录失效」，会整页刷新。
fn reject_upstream_auth_failure(upstream: &reqwest::Response) -> Result<(), AppError> {
    let status = upstream.status().as_u16();
    if matches!(status, 401 | 403) {
        tracing::warn!("AI service rejected the internal credential (upstream status {status})");
        return Err(AppError::account(
            StatusCode::BAD_GATEWAY,
            "AI_SERVICE_AUTH_FAILED",
            "AI 服务拒绝了内部凭据，请检查部署配置",
            serde_json::json!({ "upstream_status": status }),
        ));
    }
    Ok(())
}

fn response_metadata(upstream: &reqwest::Response) -> (StatusCode, String) {
    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    (status, content_type)
}

pub async fn ask(
    gateway: &AiGateway,
    headers: &HeaderMap,
    payload: Value,
) -> Result<Response, AppError> {
    let upstream = gateway.ask(forwarded_api_key(headers), &payload).await?;
    reject_upstream_auth_failure(&upstream)?;
    let (status, content_type) = response_metadata(&upstream);
    let idle = gateway.idle_timeout();
    // Body idle is separate from header wait: non-streaming answers may spend
    // their entire model deadline computing before sending response headers.
    let stream =
        futures_util::stream::unfold(Some(upstream.bytes_stream()), move |state| async move {
            let mut upstream = state?;
            match tokio::time::timeout(idle, upstream.next()).await {
                Ok(Some(Ok(bytes))) => Some((Ok(bytes), Some(upstream))),
                Ok(None) => None,
                Ok(Some(Err(error))) => Some((Err(std::io::Error::other(error)), None)),
                Err(_) => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "AI service response body stalled",
                    )),
                    None,
                )),
            }
        });
    let body = Body::from_stream(stream);
    Ok(streamed_ask_response(status, content_type, body))
}

fn streamed_ask_response(status: StatusCode, content_type: String, body: Body) -> Response {
    (
        status,
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::CACHE_CONTROL, "no-cache".to_string()),
            (
                HeaderName::from_static("x-accel-buffering"),
                "no".to_string(),
            ),
        ],
        body,
    )
        .into_response()
}

async fn buffered_runtime_config_response(
    upstream: reqwest::Response,
) -> Result<Response, AppError> {
    reject_upstream_auth_failure(&upstream)?;
    let (status, content_type) = response_metadata(&upstream);
    let body = upstream
        .bytes()
        .await
        .map_err(|error| AppError::bad_gateway(format!("AI service response failed: {error}")))?;
    Ok((
        status,
        [
            (axum::http::header::CONTENT_TYPE, content_type),
            (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
        Body::from(body),
    )
        .into_response())
}

pub async fn get_runtime_config(
    gateway: &AiGateway,
    headers: &HeaderMap,
) -> Result<Response, AppError> {
    let upstream = gateway
        .get_runtime_config(forwarded_api_key(headers))
        .await?;
    buffered_runtime_config_response(upstream).await
}

pub async fn update_runtime_config(
    gateway: &AiGateway,
    headers: &HeaderMap,
    payload: Value,
) -> Result<Response, AppError> {
    let upstream = gateway
        .update_runtime_config(forwarded_api_key(headers), &payload)
        .await?;
    buffered_runtime_config_response(upstream).await
}

#[cfg(test)]
mod tests {
    use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};

    use super::*;

    fn upstream(status: u16) -> reqwest::Response {
        reqwest::Response::from(
            axum::http::Response::builder()
                .status(status)
                .body(r#"{"detail":"invalid api key"}"#)
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn upstream_auth_failures_never_reach_the_browser_as_401() {
        for status in [401, 403] {
            let response = buffered_runtime_config_response(upstream(status))
                .await
                .unwrap_err()
                .into_response();
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY, "{status}");
        }
        let ok = buffered_runtime_config_response(upstream(200)).await.unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
        let not_found = buffered_runtime_config_response(upstream(404)).await.unwrap();
        assert_eq!(not_found.status(), StatusCode::NOT_FOUND, "其他状态照常转发");
    }

    #[test]
    fn streamed_ask_response_disables_reverse_proxy_buffering() {
        let response = streamed_ask_response(
            StatusCode::OK,
            "text/event-stream".to_string(),
            Body::empty(),
        );

        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(response.headers().get("x-accel-buffering").unwrap(), "no");
    }
}
