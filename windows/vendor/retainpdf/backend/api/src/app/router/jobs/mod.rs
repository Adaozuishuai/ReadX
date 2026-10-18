//! `/jobs` 的路由，按 9 类分文件，和 routes/jobs/ 一一对应（分类见 routes/jobs/mod.rs）。
//!
//! 每个新地址下面紧跟着它的旧地址（行尾标着 `// 旧地址`），指向同一个处理函数，一眼能看出
//! 谁是谁的旧名字。路径都写全：接口清单快照（docs/routes.txt）和路径参数分类的测试直接读这些
//! 字符串。旧地址只为已有调用方留着，不要再加；访问统计（`data/*/diagnostics/route-usage.json`）
//! 确认没人用以后再删。

use axum::Router;

use crate::app::AppState;

mod actions;
mod ai;
mod data;
mod files;
mod lifecycle;
mod progress;
mod reader;
mod reports;
mod translations;

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .merge(lifecycle::routes())
        .merge(actions::routes())
        .merge(progress::routes())
        .merge(files::routes())
        .merge(reports::routes())
        .merge(reader::routes())
        .merge(translations::routes())
        .merge(data::routes())
        .merge(ai::routes())
}
