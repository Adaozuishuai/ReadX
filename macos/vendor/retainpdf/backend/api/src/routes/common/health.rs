use crate::app::AppState;
use crate::services::platform::HealthApiDeps;

pub fn build_health_route_deps(state: &AppState) -> HealthApiDeps<'_> {
    HealthApiDeps::new(
        state.db.as_ref(),
        state.config.ai_service.supervise,
        state.config.jobs_service.is_remote() && state.config.jobs_service.supervise,
        crate::runtime::ai_supervisor::ai_service_status(),
        crate::runtime::jobsd_supervisor::jobsd_status(),
    )
}
