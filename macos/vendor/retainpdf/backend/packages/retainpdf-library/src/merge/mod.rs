//! 同一本书的多个范围翻译任务合成一本。
//!
//! - `plan`：纯函数，每个文档页取哪个任务的哪一页
//! - `sources`：从任务读出排序、页号和产物路径（唯一读磁盘的一层）
//! - `build`：拿计划和产物路径调 Python 生成合并目录（缓存、原子发布）
//! - `reading`：这本书该打开哪个任务；虚拟任务 id 的读取在 `retainpdf_api_base::job_loading`
//!
//! 依赖方向：`merge` → `derived_artifacts`（子进程、缓存目录），不反过来。

pub(crate) mod build;
pub(crate) mod coverage;
pub(crate) mod plan;
pub(crate) mod reading;
pub(crate) mod sources;
