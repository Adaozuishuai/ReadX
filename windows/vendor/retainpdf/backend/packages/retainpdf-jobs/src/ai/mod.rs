//! AI：AI 助手写在任务目录 `ai/` 下的阅读路径、概念图、画板，只按固定名字读。

mod ai_board;
mod ai_carryover;
#[cfg(all(test, unix))]
mod ai_carryover_tests;
mod documents;
mod downloads;

pub use documents::DocumentDownloadKind;
