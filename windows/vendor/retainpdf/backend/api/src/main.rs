use retainpdf_api::config::{AppConfig, JOB_WORKER_THREAD_STACK_BYTES};
use retainpdf_api::run_servers_with_shutdown;

/// 手建 runtime 而不是 `#[tokio::main]`,只为显式设定 worker 栈大小。
///
/// InProcess 模式下 job 就跑在这个进程的 worker 线程上,与 jobsd 是同一条
/// 调用链,所以同样需要——见 `JOB_WORKER_THREAD_STACK_BYTES`。
fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(JOB_WORKER_THREAD_STACK_BYTES)
        .build()?
        .block_on(run())
}

/// 默认日志过滤。日志目标是写日志那段代码所在的 crate 名，rust_api 是 main.rs 自己。
/// 领域包、运行器里的日志都在各自的 crate 名下，拆出一个包就要在这里加一个，
/// 漏了的话它的 info 日志就看不到（2026-10-17 才补上拆出去的这些）。
const DEFAULT_LOG_FILTER: &str = "rust_api=info,tower_http=info,\
retainpdf_api=info,retainpdf_api_base=info,\
retainpdf_accounts=info,retainpdf_ai=info,retainpdf_files=info,retainpdf_glossaries=info,\
retainpdf_ingest=info,retainpdf_jobs=info,retainpdf_library=info,retainpdf_platform=info,\
retainpdf_providers=info,\
retainpdf_config=info,retainpdf_core=info,retainpdf_data=info,retainpdf_db=info,retainpdf_runner=info,retainpdf_proc=info";

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| DEFAULT_LOG_FILTER.into()),
        )
        .init();

    run_servers_with_shutdown(AppConfig::from_env()?, shutdown_signal()).await
}

/// Resolve process termination to the graceful shutdown path so supervised
/// children (jobsd, ai service, workers) are terminated instead of orphaned.
/// On Windows this covers Ctrl-C / Ctrl-Break / console Close.
///
/// On Unix SIGTERM must be handled too: it is what `docker stop`, systemd and
/// Electron's `ChildProcess.kill()` send, and its default action kills the
/// process on the spot, leaving the supervised process groups orphaned.
#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = terminate.recv() => tracing::info!("received SIGTERM, shutting down"),
            }
        }
        Err(error) => {
            tracing::warn!("failed to install SIGTERM handler: {error}");
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::DEFAULT_LOG_FILTER;

    /// rust_api 依赖的每个 `retainpdf-*` 包都要在默认日志过滤里，否则它的 info 日志看不到。
    #[test]
    fn default_log_filter_covers_every_retainpdf_dependency() {
        let manifest = include_str!("../Cargo.toml");
        let directives: Vec<&str> = DEFAULT_LOG_FILTER.split(',').collect();
        let missing: Vec<String> = manifest
            .lines()
            .filter_map(|line| line.trim().strip_prefix("retainpdf-"))
            .filter_map(|rest| rest.split_whitespace().next())
            .map(|name| format!("retainpdf_{}=info", name.replace('-', "_")))
            .filter(|directive| !directives.contains(&directive.as_str()))
            .collect();
        assert!(missing.is_empty(), "默认日志过滤缺了：{missing:?}");
    }
}
