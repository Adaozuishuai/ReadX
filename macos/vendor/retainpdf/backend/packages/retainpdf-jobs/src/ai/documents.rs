//! AI 助手写在 `<job>/ai/` 里的阅读路径和概念图。
//!
//! 流水线产出的文件都走 `files.rs` 的 `open`；这两个不是流水线产物，可能不存在、可能是
//! AI 上一次写坏的，所以 404 是正常状态，前端当"还没有"处理。`ai/` 是 AI 可写的目录，
//! 只认这两个固定的文件名。

use retainpdf_api_base::error::AppError;
use retainpdf_core::models::domain::JobSnapshot;
use retainpdf_core::storage_paths::{resolve_ai_canvas, resolve_ai_reading_path};

use crate::ai::ai_carryover::carry_over_ai_workspace;
use crate::files::downloads::{DownloadJobsDeps, FileDownload};

#[derive(Clone, Copy)]
pub enum DocumentDownloadKind {
    /// Agent 在 `<job>/ai/` 里写的阅读路径。
    AiReadingPath,
    /// Agent 在 `<job>/ai/` 里画的概念图。
    AiCanvas,
}

impl DocumentDownloadKind {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::AiReadingPath => "reading-path",
            Self::AiCanvas => "canvas",
        }
    }

    fn not_ready_label(self) -> &'static str {
        match self {
            Self::AiReadingPath => "reading path not generated yet",
            Self::AiCanvas => "canvas not generated yet",
        }
    }

    fn resolve_path(
        self,
        job: &JobSnapshot,
        data_root: &std::path::Path,
    ) -> Option<std::path::PathBuf> {
        match self {
            Self::AiReadingPath => resolve_ai_reading_path(job, data_root),
            Self::AiCanvas => resolve_ai_canvas(job, data_root),
        }
    }
}

pub(super) fn document_download(
    deps: &DownloadJobsDeps<'_>,
    job: &JobSnapshot,
    kind: DocumentDownloadKind,
) -> Result<FileDownload, AppError> {
    // 解析路径**之前**接力：这两个端点在阅读页首屏就会被打，接力发生在用户看到空面板之前。
    carry_over_ai_workspace(deps.db, deps.data_root, job);
    let path = kind.resolve_path(job, deps.data_root).ok_or_else(|| {
        AppError::not_found(format!("{}: {}", kind.not_ready_label(), job.job_id))
    })?;
    Ok(FileDownload::new(path, "application/json", None))
}

#[cfg(test)]
mod schema_backed_artifact_gate {
    /// 加第三种带 schema 的 agent 产物之前，先读这段。
    ///
    /// 这条门禁不检查行为，它**拦一个决定**：仓库里跨 ≥3 层的提交只占 3.1%，
    /// 而那一小撮里几乎全是「给 agent 加一种产物」。每加一种要走完 Python 写
    /// AGENTS.md → Rust 加 resolver、端点、接力 → TS 加渲染器 → CSS 加样式，
    /// 实测约 20 个文件、4 种语言。
    ///
    /// `board/` 就是为了掐断这条链：后缀白名单覆盖图片 / markdown / json /
    /// 文本，agent 用 shell 画好丢进去就显示，**新增一种可视化零行代码**。
    #[test]
    fn schema_backed_agent_artifacts_stay_at_two() {
        let source = include_str!("documents.rs");
        let body = source
            .split_once("pub enum DocumentDownloadKind {")
            .expect("没找到枚举定义 —— 这条门禁靠读源码工作，改了枚举名要同步改这里")
            .1
            .split_once("\n}")
            .expect("没找到枚举结尾")
            .0;
        let variants: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("Ai") && line.ends_with(','))
            .map(|line| line.trim_end_matches(','))
            .collect();

        assert_eq!(
            variants,
            ["AiReadingPath", "AiCanvas"],
            "\n\n\
             要加第三种带 schema 的 agent 产物了 —— 先确认 board/ 真的不够。\n\n\
             现有这两种留着，是因为它们各有 board/ 做不到的锚定语义：\n\
             reading-path 点一步跳到论文的真实位置、canvas 的节点带连线。\n\
             （AI 批注 notes.v1.json 曾是第三种，因为 15 本书 61 个 job 里产物\n\
             为 0 而整条删掉了 —— 加新产物前先想想它会不会是同样的下场。）**如果你要加的东西只是「把一组数据画\n\
             出来给人看」，它属于 board/** —— agent 写个 python3 画成 PNG 丢\n\
             进去就显示，这边一行代码都不用改。\n\n\
             确实需要锚定语义，就改这里的期望值，并在提交信息里写清楚 board/\n\
             为什么不够。这条门禁拦的是「没想过就照着抄一遍」。\n"
        );
    }
}
