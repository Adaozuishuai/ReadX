use crate::app::AppState;
use crate::services::platform::BackupApiDeps;

pub fn build_backup_route_deps(state: &AppState) -> BackupApiDeps {
    BackupApiDeps::new(state.backup.clone())
}
