//! Application facade for liveness and readiness projections.

use serde::Serialize;

use retainpdf_data::db::Db;
use retainpdf_core::models::domain::{now_iso, JobStatusKind};
use retainpdf_api_base::supervisor::{supervisor_status_label, SUPERVISOR_HEALTHY};
use retainpdf_data::ocr_provider::supported_provider_keys;

pub struct HealthApiDeps<'a> {
    db: &'a Db,
    ai_supervised: bool,
    jobsd_supervised: bool,
    /// 建依赖那一刻两个监督器的状态（`retainpdf_api_base::supervisor`），由调用方从 runtime 读来传进来。
    ai_status: u8,
    jobsd_status: u8,
}

impl<'a> HealthApiDeps<'a> {
    pub fn new(
        db: &'a Db,
        ai_supervised: bool,
        jobsd_supervised: bool,
        ai_status: u8,
        jobsd_status: u8,
    ) -> Self {
        Self {
            db,
            ai_supervised,
            jobsd_supervised,
            ai_status,
            jobsd_status,
        }
    }
}

#[derive(Serialize)]
pub struct HealthView {
    pub status: &'static str,
    pub db: &'static str,
    pub queue_depth: i64,
    pub running_jobs: i64,
    pub provider_backends: Vec<String>,
    pub ai_service: &'static str,
    pub jobsd: &'static str,
    pub time: String,
}

#[derive(Debug, Serialize)]
pub struct ReadinessComponentView {
    pub required: bool,
    pub status: &'static str,
}

#[derive(Debug, Serialize)]
pub struct ReadinessComponentsView {
    pub db: ReadinessComponentView,
    pub ai_service: ReadinessComponentView,
    pub jobsd: ReadinessComponentView,
}

#[derive(Debug, Serialize)]
pub struct ReadinessView {
    pub status: &'static str,
    pub components: ReadinessComponentsView,
    pub reasons: Vec<&'static str>,
    pub time: String,
}

impl ReadinessView {
    pub fn is_ready(&self) -> bool {
        self.reasons.is_empty()
    }
}

pub fn build_health_view(deps: &HealthApiDeps<'_>) -> HealthView {
    let db_ok = deps.db.ping().is_ok();
    let queued = deps
        .db
        .count_jobs_with_status(&JobStatusKind::Queued)
        .unwrap_or(0);
    let running = deps
        .db
        .count_jobs_with_status(&JobStatusKind::Running)
        .unwrap_or(0);
    HealthView {
        status: if db_ok { "up" } else { "degraded" },
        db: if db_ok { "ok" } else { "error" },
        queue_depth: queued,
        running_jobs: running,
        provider_backends: supported_provider_keys(),
        ai_service: supervisor_status_label(deps.ai_status),
        jobsd: supervisor_status_label(deps.jobsd_status),
        time: now_iso(),
    }
}

pub fn build_current_readiness_view(deps: &HealthApiDeps<'_>) -> ReadinessView {
    build_readiness_view(deps, deps.ai_status, deps.jobsd_status)
}

pub fn build_readiness_view(
    deps: &HealthApiDeps<'_>,
    ai_status: u8,
    jobsd_status: u8,
) -> ReadinessView {
    let db_ok = deps.db.ping().is_ok();
    let ai_required = deps.ai_supervised;
    let jobsd_required = deps.jobsd_supervised;
    let ai_ok = !ai_required || ai_status == SUPERVISOR_HEALTHY;
    let jobsd_ok = !jobsd_required || jobsd_status == SUPERVISOR_HEALTHY;

    let mut reasons = Vec::new();
    if !db_ok {
        reasons.push("db_unavailable");
    }
    if !ai_ok {
        reasons.push("ai_service_not_healthy");
    }
    if !jobsd_ok {
        reasons.push("jobsd_not_healthy");
    }

    ReadinessView {
        status: if reasons.is_empty() {
            "ready"
        } else {
            "not_ready"
        },
        components: ReadinessComponentsView {
            db: ReadinessComponentView {
                required: true,
                status: if db_ok { "healthy" } else { "unhealthy" },
            },
            ai_service: ReadinessComponentView {
                required: ai_required,
                status: if ai_required {
                    supervisor_status_label(ai_status)
                } else {
                    "not_required"
                },
            },
            jobsd: ReadinessComponentView {
                required: jobsd_required,
                status: if jobsd_required {
                    supervisor_status_label(jobsd_status)
                } else {
                    "not_required"
                },
            },
        },
        reasons,
        time: now_iso(),
    }
}
