//! 重译同一本书时，把上一次的 agent 工作区接力到新 job 上。
//!
//! # 为什么需要它
//!
//! `<job>/ai/` 下的四类产物 —— 阅读路径、概念图、页面批注、画板文件 —— 全部
//! **挂在 job 上，不是挂在书上**。于是重新翻译一本书（换 provider、调参数、
//! 上一次渲染坏了重跑）就会开一个新 job，新 job 的 `ai/` 是空的，用户在这本书
//! 上积累的全部 agent 工作**一声不响地留在旧 job 里**。
//!
//! 界面上没有任何提示：面板就是空的，和「还没让 agent 干过活」长得一模一样。
//!
//! 这和之前修的前端批注存储键是同一类 bug（键挂在 jobId 上，重译就丢）。那次
//! 只修了前端，没想到后端产物有同样的问题。
//!
//! # 为什么是复制而不是共享
//!
//! 共享（让两个 job 指向同一个 `ai/`）会让 agent 在新 job 里的改动倒灌回旧
//! job，而旧 job 的阅读页还在用它。复制之后两边各自演进 —— 一次翻译一套批注，
//! 这也更符合「重译产生一个新版本」的直觉。
//!
//! # 为什么挂在读取路径上，而不是建 job 的时候
//!
//! `document_id` 是 `link_job_to_document` 在**建完 job 之后**补写的（还可能靠
//! 回填补上），建 job 那一刻未必知道归属。而且建 job 时接力只覆盖「先有旧 job
//! 的产出、后重译」，覆盖不了「两个 job 早就都在，之后才在其中一个上干活」。
//!
//! 放在读取路径上则两种都覆盖：打开阅读页必然会打 `ai-notes`（它在 reader data
//! port 的首屏加载里），所以**人还没看到空面板之前接力就发生了**。
//!
//! # 绝不让接力失败影响请求
//!
//! 整个过程任何一步出错都只记一条日志。接力不成功的后果是面板空着 —— 和修这个
//! bug 之前一样；让下载请求 500 才是真的把功能弄坏了。

use std::fs;
use std::path::Path;

use retainpdf_data::db::Db;
use retainpdf_core::models::domain::JobSnapshot;
use retainpdf_core::storage_paths::resolve_ai_dir;

/// 接力完成后留下的标记，内容是来源 job_id。
///
/// 以点开头：`ai_board.rs` 的 `safe_board_name` 拒绝前导点，所以它不可能被当成
/// 画板文件读出去。同时它也是排查现场时唯一能回答「这些批注是从哪搬来的」的
/// 东西。
const CARRY_MARKER_FILE_NAME: &str = ".carried-from";

/// Python 每次起终端都会按当前模板重新生成这份说明，属于**生成物不是产出**。
/// 搬一份旧的过去，模板改过之后就有一份过期说明躺在新 job 里。
const GENERATED_INSTRUCTIONS_FILE_NAME: &str = "AGENTS.md";

/// 往回找多少个同书 job。按 `updated_at DESC` 排，越靠前越可能是刚才在用的那个。
const MAX_CANDIDATE_JOBS: u32 = 20;

/// 递归深度上限。`board/` 只有一层，留 3 层是给 agent 自己建的子目录。
const MAX_COPY_DEPTH: usize = 3;

/// 文件数和总字节上限。`ai/` 是 agent 可写目录，它可能往里灌任意多东西，
/// 而这段代码跑在一个下载请求的线程上。
const MAX_COPY_FILES: usize = 500;
const MAX_COPY_BYTES: u64 = 64 * 1024 * 1024;

/// 把上一次的 agent 工作区接力到这个 job。失败只记日志。
pub(super) fn carry_over_ai_workspace(db: &Db, data_root: &Path, job: &JobSnapshot) {
    let Some(dest) = resolve_ai_dir(job, data_root) else {
        return;
    };
    if !needs_carry_over(&dest) {
        return;
    }
    let Some(source) = find_source_workspace(db, data_root, job) else {
        return;
    };
    if let Err(err) = carry_over(&source.dir, &dest, &source.job_id) {
        tracing::warn!(
            job_id = %job.job_id,
            from_job_id = %source.job_id,
            error = %err,
            "ai workspace carry-over failed"
        );
    }
}

/// 这个工作区还需不需要接力。
///
/// 真正拦住「覆盖用户产出」的是 `has_agent_output` 这一条：agent 已经在这个
/// job 上干过活了就绝不能再往里灌东西。
///
/// 标记那一条**只是省一次数据库往返**，不是闸 —— 真正挡住重复接力的是
/// `carry_over` 里那次 `create_new`（实测：把这一条去掉，接力仍然只发生一次）。
/// 写在这里是因为这几个端点会被轮询，没它的话每一轮都要为「从没用过 agent 的
/// 书」查两次库、读一次目录。
fn needs_carry_over(dir: &Path) -> bool {
    !dir.join(CARRY_MARKER_FILE_NAME).exists() && !has_agent_output(dir)
}

/// 目录里有没有 agent 的产出。
///
/// 判据是「除了生成的 AGENTS.md 之外还有别的东西」，而不是列举那三个 JSON ——
/// agent 写个脚本、往 `board/` 丢张图，都算它在这个 job 上干过活。
fn has_agent_output(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        name != GENERATED_INSTRUCTIONS_FILE_NAME && name != CARRY_MARKER_FILE_NAME
    })
}

struct SourceWorkspace {
    job_id: String,
    dir: std::path::PathBuf,
}

/// 同一本书里，最近一个真干过活的工作区。
///
/// 候选是这本书的其它任务（按 `updated_at` 新到旧，取第一个有产出的），外加**合并书的
/// 文档级工作区** `documents/<书>/ai/`：多次范围翻译的书以合并结果打开，agent 在那里干活。
/// 两者都有产出时，取最近改动过的那个 —— 用户在合并书上整理了一下午的概念图，之后单独
/// 打开某一次翻译时不该看到更早的旧版本。
fn find_source_workspace(
    db: &Db,
    data_root: &Path,
    job: &JobSnapshot,
) -> Option<SourceWorkspace> {
    // 合并结果的虚拟 id 不在 jobs 表里，但 id 本身写着它属于哪本书。
    let merged = retainpdf_core::storage_paths::MergedJobId::parse(&job.job_id);
    let document_id = match &merged {
        Some(merged) => merged.document_id.clone(),
        None => db.document_id_for_job(&job.job_id).ok()??,
    };
    let candidates = db
        .list_jobs_for_document(&document_id, MAX_CANDIDATE_JOBS, 0)
        .ok()?;
    let from_jobs = candidates
        .into_iter()
        .filter(|candidate| candidate.job_id != job.job_id)
        .find_map(|candidate| {
            let dir = resolve_ai_dir(&candidate, data_root)?;
            has_agent_output(&dir).then(|| SourceWorkspace {
                job_id: candidate.job_id.clone(),
                dir,
            })
        });
    // 合并书自己的工作区就是文档级的那个，不从自己接。
    if merged.is_some() {
        return from_jobs;
    }
    let document_dir = data_root.join("documents").join(&document_id).join("ai");
    if !has_agent_output(&document_dir) {
        return from_jobs;
    }
    let from_document = SourceWorkspace {
        job_id: format!("document:{document_id}"),
        dir: document_dir,
    };
    match from_jobs {
        Some(job_workspace) if latest_change(&job_workspace.dir) >= latest_change(&from_document.dir) => {
            Some(job_workspace)
        }
        _ => Some(from_document),
    }
}

/// 工作区最近一次改动：下面两层**文件**里最新的修改时间（`board/` 只有一层）。
///
/// 不算目录自己的修改时间：接力、生成 AGENTS.md 都会碰目录，那不是 agent 干的活。
fn latest_change(dir: &Path) -> std::time::SystemTime {
    fn walk(path: &Path, depth: usize, latest: &mut std::time::SystemTime) {
        let Ok(meta) = fs::symlink_metadata(path) else { return };
        if meta.is_file() {
            if path.file_name().is_some_and(|name| name == GENERATED_INSTRUCTIONS_FILE_NAME || name == CARRY_MARKER_FILE_NAME) {
                return;
            }
            if let Ok(modified) = meta.modified() {
                *latest = (*latest).max(modified);
            }
            return;
        }
        if depth == 0 || !meta.is_dir() {
            return;
        }
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                walk(&entry.path(), depth - 1, latest);
            }
        }
    }
    let mut latest = std::time::SystemTime::UNIX_EPOCH;
    walk(dir, 2, &mut latest);
    latest
}

/// 先抢标记再复制。
///
/// `create_new` 在文件已存在时失败，这是一次原子占位：两个并发的轮询同时进到
/// 这里，只有一个会往下走。抢输的那个直接返回，等下一轮就能读到复制好的文件。
fn carry_over(source: &Path, dest: &Path, source_job_id: &str) -> std::io::Result<()> {
    fs::create_dir_all(dest)?;
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest.join(CARRY_MARKER_FILE_NAME))
    {
        Ok(mut marker) => {
            use std::io::Write;
            writeln!(marker, "{source_job_id}")?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(err) => return Err(err),
    }
    let mut budget = CopyBudget::default();
    copy_tree(source, dest, 0, &mut budget)
}

#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
}

impl CopyBudget {
    /// 超预算返回 false —— 停下来而不是报错：已经搬过去的部分是有用的。
    fn take(&mut self, bytes: u64) -> bool {
        if self.files >= MAX_COPY_FILES || self.bytes.saturating_add(bytes) > MAX_COPY_BYTES {
            return false;
        }
        self.files += 1;
        self.bytes += bytes;
        true
    }
}

fn copy_tree(
    source: &Path,
    dest: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> std::io::Result<()> {
    if depth > MAX_COPY_DEPTH {
        return Ok(());
    }
    for entry in fs::read_dir(source)?.flatten() {
        let name = entry.file_name();
        if depth == 0
            && (name == GENERATED_INSTRUCTIONS_FILE_NAME || name == CARRY_MARKER_FILE_NAME)
        {
            continue;
        }
        // DirEntry::metadata 是 lstat 语义，不跟随符号链接 —— 于是下面
        // `is_file()` 对链接为假，链接被跳过。这一条不能松：跟随了就等于允许
        // agent 用 `ln -s /etc/passwd board/x.png` 把任意文件搬进新 job 的
        // 可读目录。
        let meta = entry.metadata()?;
        let target = dest.join(&name);
        if meta.is_dir() {
            fs::create_dir_all(&target)?;
            copy_tree(&entry.path(), &target, depth + 1, budget)?;
        } else if meta.is_file() {
            if !budget.take(meta.len()) {
                return Ok(());
            }
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
