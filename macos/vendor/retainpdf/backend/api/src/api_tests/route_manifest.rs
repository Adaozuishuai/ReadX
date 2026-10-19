//! 接口清单快照：`docs/routes.txt` 列出全部路由（方法、路径、多用户下网站账号的访问策略）。
//!
//! 接口多了、杂了，很大一部分是因为加接口没有门槛——加一条就是加一条，没人注意到总数在涨。
//! 这份快照让每次增删、改策略都出现在提交的 diff 里，要有意识地确认。改了路由之后这里会红，
//! 确认是有意的，就用 `UPDATE_ROUTES=1 cargo test -p retainpdf-api --lib route_manifest` 重新生成。
//!
//! 清单从路由源码里读（和 `services::accounts::access` 的参数分类测试一样），不启动服务。

use std::collections::BTreeMap;
use std::path::Path;

use crate::services::accounts::{route_policy, RoutePolicy};

const METHODS: [&str; 5] = ["get", "post", "put", "patch", "delete"];


/// `.route("<path>", get(a).post(b))` 里的路径和方法。只认路由注册这一种写法；
/// 测试代码（`#[cfg(test)]` 之后）不算。
fn routes_in(source: &str) -> Vec<(String, Vec<&'static str>)> {
    let source = source.split("\n#[cfg(test)]").next().unwrap_or_default();
    let mut found = Vec::new();
    let mut rest = source;
    while let Some(start) = rest.find(".route(") {
        rest = &rest[start + ".route(".len()..];
        let Some(open) = rest.find('"') else { break };
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('"') else { break };
        let path = after_open[..close].to_string();
        // 这次 .route( 调用的实参：到配对的右括号为止。
        let mut depth = 1usize;
        let mut end = 0;
        for (offset, ch) in rest.char_indices() {
            match ch {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = offset;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &rest[open + 1 + close + 1..end];
        let methods = METHODS
            .iter()
            .copied()
            .filter(|method| {
                body.match_indices(&format!("{method}(")).any(|(at, _)| {
                    at == 0 || !body[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_')
                })
            })
            .collect();
        found.push((path, methods));
        rest = &rest[end..];
    }
    found
}

fn policy_label(method: &str, path: &str, public: bool) -> &'static str {
    if public {
        return "public";
    }
    match route_policy(&method.to_ascii_uppercase(), path) {
        RoutePolicy::Signed => "signed",
        RoutePolicy::AdminOnly => "admin",
        RoutePolicy::Closed => "closed",
    }
}

fn manifest() -> String {
    let mut table: BTreeMap<String, Vec<&'static str>> = BTreeMap::new();
    let mut public = std::collections::BTreeSet::new();
    for file in crate::test_support::routes::router_source_files() {
        let source = std::fs::read_to_string(&file).unwrap();
        // router/public.rs 挂在认证之外（健康检查、登录注册）。
        let is_public = file.ends_with("app/router/public.rs");
        for (path, methods) in routes_in(&source) {
            assert!(!methods.is_empty(), "{}: route `{path}` has no recognisable method", file.display());
            if is_public {
                public.insert(path.clone());
            }
            let entry = table.entry(path).or_default();
            entry.extend(methods);
            entry.sort();
            entry.dedup();
        }
    }
    let mut lines = vec![
        "# 全部 HTTP 路由：方法 路径 多用户下网站账号的访问策略（signed 登录可用 / admin 只给管理员 /".to_string(),
        "# closed 关闭 / public 不需要登录）。由 src/api_tests/route_manifest.rs 生成，不要手改：".to_string(),
        "#   UPDATE_ROUTES=1 cargo test -p retainpdf-api --lib route_manifest".to_string(),
    ];
    let count: usize = table.values().map(Vec::len).sum();
    lines.push(format!("# {} 条路径，{count} 个接口", table.len()));
    for (path, methods) in &table {
        for method in methods {
            lines.push(format!("{:<7}{path}  {}", method.to_ascii_uppercase(), policy_label(method, path, public.contains(path))));
        }
    }
    lines.join("\n") + "\n"
}

#[test]
fn route_manifest_matches_snapshot() {
    let snapshot = Path::new(env!("CARGO_MANIFEST_DIR")).join("docs/routes.txt");
    let current = manifest();
    if std::env::var_os("UPDATE_ROUTES").is_some() {
        std::fs::write(&snapshot, &current).unwrap();
        return;
    }
    let saved = std::fs::read_to_string(&snapshot).unwrap_or_default();
    if saved != current {
        let saved_lines: std::collections::BTreeSet<&str> = saved.lines().collect();
        let current_lines: std::collections::BTreeSet<&str> = current.lines().collect();
        let added: Vec<_> = current_lines.difference(&saved_lines).collect();
        let removed: Vec<_> = saved_lines.difference(&current_lines).collect();
        panic!(
            "routes changed (docs/routes.txt is out of date).\n+ {added:#?}\n- {removed:#?}\n\
             If intended: UPDATE_ROUTES=1 cargo test -p retainpdf-api --lib route_manifest"
        );
    }
}

#[test]
fn route_parser_reads_chained_methods() {
    let source = r#"
        Router::new()
            .route("/api/v1/a", get(x::list).post(x::create))
            .route(
                "/api/v1/a/:id",
                axum::routing::get(x::get_one)
                    .put(x::update)
                    .delete(x::remove),
            )
            .route("/api/v1/b", post(x::get_post_route))
#[cfg(test)]
mod tests { fn f() { Router::new().route("/api/v1/test-only", get(h)); } }
    "#;
    assert_eq!(
        routes_in(source),
        vec![
            ("/api/v1/a".to_string(), vec!["get", "post"]),
            ("/api/v1/a/:id".to_string(), vec!["get", "put", "delete"]),
            ("/api/v1/b".to_string(), vec!["post"]),
        ]
    );
}
