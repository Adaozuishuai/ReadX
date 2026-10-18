//! 合并阅读的虚拟任务：`merged-<文档 id>-<指纹前 16 位>`。
//!
//! 读路径上它和普通任务一样经过 [`super::load_supported_job`]，所以"认出虚拟 id、读出它的任务快照"
//! 放在这一层；生成合并目录、写说明文件的是 `services::library::merge`。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use retainpdf_data::db::Db;
use crate::error::AppError;
use retainpdf_core::models::domain::{JobArtifacts, JobSnapshot, JobStatusKind};
use retainpdf_core::storage_paths::{is_merged_job_id, to_relative_data_path, MergedJobId};

/// 合并目录里的说明文件名。
pub const SIDECAR: &str = "reading.json";

/// 虚拟任务 id 的格式定义在 `storage_paths::MergedJobId`：Python 的 AI 服务也要认它。
pub type VirtualJobId = MergedJobId;

pub fn is_virtual_job_id(job_id: &str) -> bool {
    is_merged_job_id(job_id)
}

/// 合并目录。布局与普通任务目录一致，下游按读普通任务的方式读。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergedTranslation {
    pub root: PathBuf,
}

impl MergedTranslation {
    pub fn output_pdf(&self) -> PathBuf {
        self.root.join("rendered").join("merged.pdf")
    }

    pub fn translations_dir(&self) -> PathBuf {
        self.root.join("translated")
    }

    pub fn normalized_document(&self) -> PathBuf {
        self.root.join("ocr").join("normalized").join("document.v1.json")
    }
}

/// 合并目录里的说明文件：拼任务快照要的、目录本身看不出来的东西。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadingSidecar {
    pub document_id: String,
    /// 最新的参与任务。快照的请求参数、标题这些展示信息取自它。
    pub base_job_id: String,
    pub contributing_job_ids: Vec<String>,
    pub page_count: u32,
    pub source_pdf: String,
}

/// 把虚拟 id 解析成一个任务快照：请求参数、标题取自最新的参与任务，产物全部指向合并目录。
///
/// 产物从 `JobArtifacts::default()` 起步，只填合并目录里真有的东西。不沿用参与任务的
/// 产物字段：那些路径（诊断、日志、OCR 原始包…）属于某一个任务，挂在合并结果上会让
/// 下游读到只覆盖一部分页的数据。
pub fn load_virtual_job(db: &Db, data_root: &Path, job_id: &str) -> Result<JobSnapshot, AppError> {
    let not_found = || AppError::not_found(format!("job not found: {job_id}"));
    let id = VirtualJobId::parse(job_id).ok_or_else(not_found)?;
    let merged = MergedTranslation { root: id.root(data_root) };
    let sidecar: ReadingSidecar = std::fs::read(merged.root.join(SIDECAR))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or_else(not_found)?;
    if sidecar.document_id != id.document_id {
        return Err(not_found());
    }
    let base = db.get_job(&sidecar.base_job_id).map_err(|_| not_found())?;
    let relative = |path: &Path| {
        to_relative_data_path(data_root, path).unwrap_or_else(|_| path.to_string_lossy().into_owned())
    };
    let mut job = base;
    job.job_id = job_id.to_string();
    job.status = JobStatusKind::Succeeded;
    job.request_payload.translation.start_page = 0;
    job.request_payload.translation.end_page = -1;
    job.request_payload.translation.page_ranges = Default::default();
    job.artifacts = Some(JobArtifacts {
        job_root: Some(relative(&merged.root)),
        source_pdf: Some(sidecar.source_pdf.clone()),
        output_pdf: Some(relative(&merged.output_pdf())),
        translations_dir: Some(relative(&merged.translations_dir())),
        normalized_document_json: Some(relative(&merged.normalized_document()))
            .filter(|_| merged.normalized_document().is_file()),
        ocr_page_numbers: (1..=sidecar.page_count).collect(),
        ..JobArtifacts::default()
    });
    Ok(job)
}

/// 参与这份合并的任务 id，按页序首次出现的顺序。给界面说「这本书由哪几次翻译拼成」。
pub fn contributing_jobs(data_root: &Path, job_id: &str) -> Option<Vec<String>> {
    let id = VirtualJobId::parse(job_id)?;
    let bytes = std::fs::read(id.root(data_root).join(SIDECAR)).ok()?;
    let sidecar: ReadingSidecar = serde_json::from_slice(&bytes).ok()?;
    Some(sidecar.contributing_job_ids)
}
