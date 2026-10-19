//! 一个文件夹的 agent 工作区 —— 让 agent 一次看见一批书，而不是一本。
//!
//! # 为什么需要它
//!
//! 到这一版为止，agent 的工作区**钉死在单个 job 上**（`fx_workspace.py` 的
//! `resolve_job_workspace` → `jobs/<job_id>/ai/`）。批注、阅读路径、概念图、
//! 画板、终端，无一例外。
//!
//! 于是「这 12 篇里哪几篇的实验设置互相矛盾」「把我标过存疑的批注按主题聚起来」
//! 这类问题**在结构上就问不出来** —— 不是模型不行，是它看不见第二本书。
//!
//! 而文献库那层早就建好了：`collections`（带 parent_id，是棵树）、
//! `collection_documents`、`documents.active_job_id`。建好了，agent 够不着。
//! 这个模块就是把它递过去。
//!
//! # 为什么是 Rust 写、Python 读
//!
//! 「这个文件夹里有哪几本书」「这本书该用哪次翻译」只有数据库知道，而 AI 服务
//! （Python）没有数据库访问 —— 这跟重译接力那次撞的是同一堵墙。
//!
//! 所以分工是：**Rust 把清单物化到磁盘，Python 只认一个目录**。Python 那边不需要
//! 知道 collection 是什么，`cd` 进去、读一份 JSON 就够了。
//!
//! # books/ 是符号链接，不是拷贝
//!
//! 一本书的 job 目录有几百 MB（原始 PDF、OCR 中间产物、渲染输出）。拷贝进来
//! 既慢又会让「哪份是真的」变成一个问题。
//!
//! 链接的名字用标题而不是 job id：agent 要 `ls books/` 一眼看出有哪几本，
//! `jobs/20260921092508-fe8d63` 这种名字它得逐个 `jq` 才知道是什么。
//!
//! 建链接失败（Windows 默认需要权限）**不算失败** —— 清单里有相对路径，
//! 那条路照样走得通，只是难读一点。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use retainpdf_data::db::Db;
use retainpdf_api_base::error::AppError;
use retainpdf_core::storage_paths::resolve_job_root;

/// 一次最多纳入多少本。工作区是给模型读的，超过这个数它也摸不完，
/// 而 `ls books/` 刷屏本身就是一种噪音。
const MAX_BOOKS: u32 = 200;

/// 链接名的长度上限。文件系统的上限是 255 字节，中文标题一个字三字节。
const MAX_LINK_NAME_BYTES: usize = 120;

#[derive(Serialize)]
pub struct CollectionWorkspaceBook {
    pub document_id: String,
    pub title: String,
    /// `books/` 下的链接名。建链接失败时为 null，这时只能用 job_root。
    pub dir: Option<String>,
    /// 相对工作区的 job 根目录 —— 链接没建成时的退路。
    pub job_root: String,
    pub job_id: String,
    pub page_count: u32,
}

#[derive(Serialize)]
pub struct CollectionWorkspace {
    pub schema: &'static str,
    pub collection_id: String,
    pub books: Vec<CollectionWorkspaceBook>,
    /// 被跳过的书，以及原因。**要让 agent 看见** —— 不然它会以为文件夹里
    /// 只有这几本，而实际上有几本还没翻译完。
    pub skipped: Vec<CollectionWorkspaceSkip>,
}

#[derive(Serialize)]
pub struct CollectionWorkspaceSkip {
    pub document_id: String,
    pub title: String,
    pub reason: &'static str,
}

/// 工作区的绝对路径：`<data_root>/collections/<id>/ai/`。
///
/// 和 job 工作区同构（`jobs/<id>/ai/`），Python 那边就能用同一套规则。
pub fn collection_workspace_dir(data_root: &Path, collection_id: &str) -> PathBuf {
    data_root
        .join("collections")
        .join(collection_id)
        .join("ai")
}

/// 把标题削成一个能当目录名的东西。
///
/// 只挡路径分隔符和前导点，**不做 ASCII 白名单** —— 中文标题全被削掉之后，
/// `ls books/` 会是一排 `book-1` `book-2`，等于没做。
pub(super) fn link_name(
    title: &str,
    document_id: &str,
    taken: &mut HashSet<String>,
) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' | '\0' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut name = cleaned.trim().trim_start_matches('.').trim().to_string();
    while name.len() > MAX_LINK_NAME_BYTES {
        name.pop();
    }
    if name.is_empty() {
        // 标题全是分隔符或空的时候退回 document_id 前缀，而不是留个空名字。
        name = format!("book-{}", &document_id[..document_id.len().min(8)]);
    }
    // 同名的书（同一篇论文的两个版本）加后缀，否则后一条会盖掉前一条的链接。
    if taken.contains(&name) {
        let mut n = 2;
        while taken.contains(&format!("{name} ({n})")) {
            n += 1;
        }
        name = format!("{name} ({n})");
    }
    taken.insert(name.clone());
    name
}

/// 建一个指向 job 根目录的符号链接。
///
/// **不处理"已存在"** —— 调用方每次都把整个 `books/` 删掉重建，所以进到这里时
/// 链接必然不存在。第一版写了一段"存在就先删"，反证时发现那段永远走不到：
/// 把它改成"存在就跳过"，重译后仍然指向新 job 的那条测试照样绿。
#[cfg(unix)]
fn link_book(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
fn link_book(link: &Path, target: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(target, link)
}

/// 物化（或刷新）一个文件夹的 agent 工作区。
///
/// 每次调用都重建 `books/`：成员和 active_job 都会变，而这个目录是纯派生物，
/// 重建比对账便宜，也不会有「链接指向一个已删除的 job」这种状态。
/// 一本书在工作区里该指向哪里：阅读入口说的那个任务（一个任务覆盖整本就是它；多次范围
/// 翻译就是合并目录，目录结构和普通任务一样）。
pub struct ReadingBook {
    pub job_id: String,
    pub root: std::path::PathBuf,
}

pub fn ensure_collection_workspace(
    db: &Db,
    data_root: &Path,
    collection_id: &str,
    reading_book: &dyn Fn(&retainpdf_core::models::api::DocumentRecord) -> Option<ReadingBook>,
) -> Result<CollectionWorkspace, AppError> {
    let documents = db
        .list_documents(MAX_BOOKS, 0, None, Some(collection_id), None)
        .map_err(|err| AppError::internal(format!("list collection documents: {err}")))?;

    let workspace = collection_workspace_dir(data_root, collection_id);
    let books_dir = workspace.join("books");
    // 整个重建 books/，但**不碰 ai/ 下别的东西** —— agent 的产出在那儿。
    let _ = fs::remove_dir_all(&books_dir);
    fs::create_dir_all(&books_dir)
        .map_err(|err| AppError::internal(format!("create collection workspace: {err}")))?;

    let mut books = Vec::new();
    let mut skipped = Vec::new();
    let mut taken = HashSet::new();

    for document in documents {
        // 多次范围翻译的书：链到合并目录，agent 看到的是整本，不是最后翻的那几页。
        if let Some(book) = reading_book(&document) {
            let name = link_name(&document.title, &document.document_id, &mut taken);
            let dir = link_book(&books_dir.join(&name), &book.root).ok().map(|()| name);
            let relative = retainpdf_core::storage_paths::to_relative_data_path(data_root, &book.root)
                .unwrap_or_else(|_| format!("jobs/{}", book.job_id));
            books.push(CollectionWorkspaceBook {
                document_id: document.document_id,
                title: document.title,
                dir,
                // 三层 ..：ai → <collection_id> → collections → data_root。
                job_root: format!("../../../{relative}"),
                job_id: book.job_id,
                page_count: document.page_count,
            });
            continue;
        }
        let Some(job_id) = document.active_job_id.clone().filter(|id| !id.is_empty()) else {
            skipped.push(CollectionWorkspaceSkip {
                document_id: document.document_id,
                title: document.title,
                reason: "还没有可用的翻译",
            });
            continue;
        };
        let Ok(job) = db.get_job(&job_id) else {
            skipped.push(CollectionWorkspaceSkip {
                document_id: document.document_id,
                title: document.title,
                reason: "active_job 指向一个已经不存在的任务",
            });
            continue;
        };
        let Some(job_root) = resolve_job_root(&job, data_root) else {
            skipped.push(CollectionWorkspaceSkip {
                document_id: document.document_id,
                title: document.title,
                reason: "任务没有产物目录",
            });
            continue;
        };

        let name = link_name(&document.title, &document.document_id, &mut taken);
        let dir = link_book(&books_dir.join(&name), &job_root).ok().map(|()| name);
        books.push(CollectionWorkspaceBook {
            document_id: document.document_id,
            title: document.title,
            dir,
            // 三层 ..：ai → <collection_id> → collections → data_root。
            job_root: format!("../../../jobs/{job_id}"),
            job_id,
            page_count: document.page_count,
        });
    }

    let manifest = CollectionWorkspace {
        schema: "retainpdf_collection_workspace_v1",
        collection_id: collection_id.to_string(),
        books,
        skipped,
    };
    let json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| AppError::internal(format!("encode collection manifest: {err}")))?;
    fs::write(workspace.join("collection.v1.json"), json)
        .map_err(|err| AppError::internal(format!("write collection manifest: {err}")))?;
    Ok(manifest)
}
