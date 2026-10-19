use crate::app::AppState;
use crate::services::glossaries::GlossaryApiDeps;

pub fn build_glossary_route_deps(state: &AppState) -> GlossaryApiDeps<'_> {
    GlossaryApiDeps::new(state.db.as_ref())
}
