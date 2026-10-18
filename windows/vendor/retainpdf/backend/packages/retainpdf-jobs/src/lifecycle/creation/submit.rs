//! 建新任务的唯一入口 [`submit_job`]，和原地重跑已有任务的 [`relaunch_in_place`]。
//!
//! 所有"建一个新任务并开跑"的地方都走 `submit_job`：`POST /jobs`、`/ocr/jobs`、`/translate/bundle`、
//! 书库的翻译和 OCR、重试、续跑、OCR 歧义恢复。下面每一步只在这里写一次：
//!
//! 1. 翻译类的新提交补开发栈的默认值（OCR 歧义恢复沿用源任务的设置，不补）；
//! 2. 多用户模式换成平台的模型和 OCR——在校验和凭据入库之前，网站账号自带的 key 不进服务器的凭据库；
//! 3. 按 workflow 校验参数、建任务；
//! 4. 明文 key 导入凭据库换成引用，加使用锁，锁到落库之后；
//! 5. 落库（多用户模式按页预扣）、归到书下、发射。
//!
//! 带文件的入口（`/ocr/jobs`、`/translate/bundle`）先把文件存成上传，再把上传记录交给 [`NewJob::with_upload`]。
//! 任务运行时内部派生的 `{id}-ocr` 子任务不经这里，所以不会重复计费。

use serde_json::Value;

use retainpdf_data::db::PipelineDispatchRecord;
use retainpdf_api_base::error::AppError;
use retainpdf_data::job_events::persist_job_with_resources;
use retainpdf_core::models::domain::{JobSnapshot, UploadRecord, WorkflowKind};
use retainpdf_core::models::request::CreateJobInput;
use crate::deps::JobSubmitDeps;
use crate::lifecycle::launcher::{
    apply_platform_models, apply_platform_models_to_input, link_new_job_to_document, JobLaunchDeps,
};
use crate::lifecycle::validation::validate_mineru_upload_limits;

use super::dev_defaults::with_dev_translation_defaults;
use super::job_builders::{build_ocr_job_snapshot, build_translation_job_snapshot};
use super::ocr_credentials::{acquire_job_credential_usage_lock, secure_job_credentials};

/// 要建的新任务。
pub struct NewJob<'a> {
    input: CreateJobInput,
    upload: Option<UploadRecord>,
    derived_from: Option<&'a str>,
    document_id: Option<&'a str>,
    ocr_recovery: Option<OcrRecovery<'a>>,
}

/// OCR 请求结果不确定之后的恢复任务：和"源任务那次 OCR 已处理"写在同一个事务里，
/// 两个请求同时来只有一个能建成。不计费。
struct OcrRecovery<'a> {
    dispatch: &'a PipelineDispatchRecord,
    resolution: &'a str,
    receipt: Option<&'a Value>,
}

impl<'a> NewJob<'a> {
    pub fn new(input: CreateJobInput) -> Self {
        Self {
            input,
            upload: None,
            derived_from: None,
            document_id: None,
            ocr_recovery: None,
        }
    }

    /// 随请求一起传的文件，已经存成上传。
    pub(crate) fn with_upload(mut self, upload: UploadRecord) -> Self {
        self.upload = Some(upload);
        self
    }

    /// 从哪个任务派生出来的（OCR 重试只带 upload_id、不带 artifact_job_id）：
    /// 按上传归不到书时，归属从这个任务继承。
    pub(crate) fn derived_from(mut self, job_id: &'a str) -> Self {
        self.derived_from = Some(job_id);
        self
    }

    /// 书库发起的提交：建完要确认任务确实归到了这本书下。
    pub(crate) fn for_document(mut self, document_id: &'a str) -> Self {
        self.document_id = Some(document_id);
        self
    }

    /// OCR 歧义恢复。`resolution` 是处理方式，`receipt` 是绑定的已有回执。
    pub(crate) fn resolving_ocr_ambiguity(
        mut self,
        dispatch: &'a PipelineDispatchRecord,
        resolution: &'a str,
        receipt: Option<&'a Value>,
    ) -> Self {
        self.ocr_recovery = Some(OcrRecovery {
            dispatch,
            resolution,
            receipt,
        });
        self
    }
}

/// 建新任务并开跑。见模块说明。
pub fn submit_job(deps: &JobSubmitDeps<'_>, new: NewJob<'_>) -> Result<JobSnapshot, AppError> {
    let NewJob {
        mut input,
        upload,
        derived_from,
        document_id,
        ocr_recovery,
    } = new;
    let ocr_only = matches!(input.workflow, WorkflowKind::Ocr);
    if !ocr_only && ocr_recovery.is_none() {
        input = with_dev_translation_defaults(&input);
    }
    if let Some(source) = deps.launcher.platform {
        apply_platform_models_to_input(&mut input, &source.resolve()?)?;
    }
    if let Some(upload) = &upload {
        input.source.upload_id = upload.upload_id.clone();
    }

    let job = if ocr_only {
        build_ocr_job_snapshot(&deps.snapshot, &input, upload.as_ref())?
    } else {
        if let Some(upload) = &upload {
            validate_mineru_upload_limits(&input, upload, deps.snapshot.config.provider_limits)?;
        }
        build_translation_job_snapshot(&deps.snapshot, &input)?
    };
    let job = secure_job_credentials(deps, job)?;
    let _credential_guard = acquire_job_credential_usage_lock(deps, &job)?;

    let job = match ocr_recovery {
        None => persist_and_launch(&deps.launcher, job, derived_from)?,
        Some(recovery) => persist_ocr_recovery(&deps.launcher, job, recovery)?,
    };
    if let Some(document_id) = document_id {
        if deps.launcher.db.document_id_for_job(&job.job_id)?.as_deref() != Some(document_id) {
            return Err(AppError::internal(format!(
                "job {} was not bound to document {document_id}",
                job.job_id
            )));
        }
    }
    Ok(job)
}

/// 原地重跑已有任务（续跑出的重渲染、原地重渲染、原地精修）：任务编号不变，重新落库并发射。
/// 新任务一律走 [`submit_job`]，这里不接没落过库的任务。
pub fn relaunch_in_place(deps: &JobLaunchDeps<'_>, job: JobSnapshot) -> Result<JobSnapshot, AppError> {
    if deps.db.get_job(&job.job_id).is_err() {
        return Err(AppError::internal(format!(
            "relaunch_in_place only re-runs an existing job; {} is new — submit it with submit_job",
            job.job_id
        )));
    }
    persist_and_launch(deps, job, None)
}

fn persist_and_launch(
    deps: &JobLaunchDeps<'_>,
    mut job: JobSnapshot,
    derived_from: Option<&str>,
) -> Result<JobSnapshot, AppError> {
    if let Some(source) = deps.platform {
        apply_platform_models(&mut job, &source.resolve()?)?;
    }
    // The new contract must never silently use the legacy Python transport.
    // Worker rollout is a separate, explicit gate while migration is in flight.
    if job.uses_model_executor()
        && (std::env::var("RETAIN_MODEL_EXECUTOR_ENABLED").as_deref() != Ok("1")
            || std::env::var("RETAIN_MODEL_WORKER_ENABLED").as_deref() != Ok("1"))
    {
        return Err(AppError::ServiceUnavailable("Rust model worker rollout is not enabled; execution_connection will not fall back to Python transport".into()));
    }
    // 预扣放在落库之前：余额不够就不留下任务行。原地重跑也经过这里（只重新渲染不计费，
    // 规则见 accounts::page_quota）。
    let reserved = deps.page_quota && retainpdf_accounts::reserve_for_job(deps.db, &job)?;
    if let Err(error) = persist_job_with_resources(deps.db, deps.data_root, deps.output_root, &job) {
        if reserved {
            retainpdf_accounts::release_for_job(deps.db, &job.job_id);
        }
        return Err(error.into());
    }
    link_new_job_to_document(deps.db, &job, derived_from);
    deps.runtime.launch(job.job_id.clone());
    Ok(job)
}

fn persist_ocr_recovery(
    deps: &JobLaunchDeps<'_>,
    job: JobSnapshot,
    recovery: OcrRecovery<'_>,
) -> Result<JobSnapshot, AppError> {
    if !deps
        .db
        .create_ocr_recovery_job_state(recovery.dispatch, &job, recovery.resolution, recovery.receipt)?
    {
        return Err(AppError::conflict(
            "OCR ambiguity was already resolved by another request",
        ));
    }
    // 恢复任务只带 upload_id，upload 没有 content_hash 时按发生歧义的源任务继承归属。
    link_new_job_to_document(deps.db, &job, Some(&recovery.dispatch.job_id));
    deps.runtime.launch(job.job_id.clone());
    Ok(job)
}
