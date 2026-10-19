use std::collections::HashSet;

use crate::app::AppState;

pub struct AuthRouteDeps<'a> {
    pub api_keys: &'a HashSet<String>,
}

pub fn build_auth_route_deps(state: &AppState) -> AuthRouteDeps<'_> {
    AuthRouteDeps {
        api_keys: &state.config.api_keys,
    }
}

/// 终端 WebSocket 代理要的东西：一把校验用的 key 集合 + ai_service 的基址。
///
/// 和 AuthRouteDeps 分开，是因为它多要一个上游地址，而那个地址与鉴权无关 ——
/// 合在一起会让每个鉴权点都拖着一个它用不到的字段。
pub struct AiTerminalRouteDeps<'a> {
    pub api_keys: &'a HashSet<String>,
    pub ai_service_base_url: &'a str,
}

pub fn build_ai_terminal_route_deps(state: &AppState) -> AiTerminalRouteDeps<'_> {
    AiTerminalRouteDeps {
        api_keys: &state.config.api_keys,
        ai_service_base_url: state.ai_gateway.base_url(),
    }
}
