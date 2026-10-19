use std::time::Instant;

use anyhow::{anyhow, Result};
use tokio::time::{sleep, Duration};

use super::super::cancel_registry::should_stop_ocr_child;
use super::super::ProcessRuntimeDeps;

/// 轮询服务商期间要不要停。以前只看子任务自己的 id——父任务被取消时一直轮询到底。
pub(super) async fn should_stop_polling(
    deps: &ProcessRuntimeDeps,
    job_id: &str,
    parent_job_id: Option<&str>,
) -> bool {
    let parent_ids: Vec<String> = parent_job_id.iter().map(|id| id.to_string()).collect();
    should_stop_ocr_child(deps.canceled_jobs.as_ref(), deps.db.as_ref(), job_id, &parent_ids).await
}

pub(super) async fn wait_next_poll_or_timeout<M>(
    started: Instant,
    timeout_secs: u64,
    poll_interval_secs: u64,
    timeout_message: M,
) -> Result<()>
where
    M: FnOnce() -> String,
{
    if started.elapsed().as_secs() > timeout_secs {
        return Err(anyhow!(timeout_message()));
    }
    sleep(Duration::from_secs(poll_interval_secs)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_detects_expired_window() {
        let started = Instant::now() - Duration::from_secs(3);
        let result = futures_like_block_on(wait_next_poll_or_timeout(started, 1, 0, || {
            "timeout".to_string()
        }));
        assert!(result.is_err());
    }

    #[test]
    fn timeout_allows_fresh_window() {
        let started = Instant::now();
        let result = futures_like_block_on(wait_next_poll_or_timeout(started, 1, 0, || {
            "timeout".to_string()
        }));
        assert!(result.is_ok());
    }

    fn futures_like_block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(future)
    }
}
