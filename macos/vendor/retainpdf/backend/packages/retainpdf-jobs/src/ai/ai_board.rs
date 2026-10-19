//! `<job>/ai/board/` —— agent 丢东西给用户看的地方。
//!
//! # 为什么是目录而不是 schema
//!
//! 前三个 agent 产物（reading-path / canvas / notes）各有一套 JSON schema。每加
//! 一种可视化要动三处：schema、前端渲染器、AGENTS.md 一节。加到第三次时
//! AGENTS.md 里一半篇幅都是在教 agent 拼格式。
//!
//! 画板换个思路：**agent 手里已经有 shell 了**。`python3` 画个图、`pdftoppm`
//! 截个页、`jq` 导个表 —— 产物丢进 `board/` 就能被看见，不需要我们为每种东西
//! 新增 API。它现有的本事直接变成可视化。
//!
//! # 这是第一个接受「调用方给文件名」的 agent 产物端点
//!
//! 前面几个 resolver 都刻意不收文件名（见 resolvers.rs 里 `resolve_ai_artifact`
//! 的说明）。画板必须收，所以防护要自己做足，而且**比 markdown 图片那条更严**：
//!
//! - `md/images/` 是**流水线**写的，`safe_markdown_image_path` 只剥 `..` 就够
//! - `board/` 是 **agent** 写的，它能 `ln -s /etc/passwd board/leak.png`
//!
//! 所以这里多两道：拒绝符号链接，以及解析后再确认仍在 board 目录内。
//!
//! 另外只收**单层文件名**（不支持子目录）—— 这一条就掐掉了整类路径穿越，
//! 代价是 agent 不能建子目录，而它也不需要。

use std::time::UNIX_EPOCH;

use serde::Serialize;

use retainpdf_api_base::error::AppError;
use retainpdf_core::storage_paths::resolve_ai_board_dir;

use crate::ai::ai_carryover::carry_over_ai_workspace;
use retainpdf_api_base::job_loading::load_supported_job;
use crate::files::downloads::{DownloadJobsDeps, FileDownload};

/// 单个文件的上限。画板是给人看的，超过这个尺寸多半是 agent 写错了东西
/// （比如把整份 document.v1.json 倒了进来）。
const MAX_BOARD_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 列表里最多返回多少项。agent 可能无节制地写，前端也画不下那么多。
const MAX_BOARD_ITEMS: usize = 200;

/// 文件名上限。留足够长给「fig-3-residual-by-page.png」这类名字。
const MAX_BOARD_NAME_LEN: usize = 128;

#[derive(Debug, Serialize)]
pub struct AiBoardItem {
    pub name: String,
    /// image / markdown / json / text —— 前端据此决定怎么画。
    pub kind: &'static str,
    pub content_type: &'static str,
    pub size: u64,
    /// 修改时间（毫秒）。前端按它做时间流式排版：新的往后排，位置稳定。
    pub modified_ms: u64,
}

#[derive(Debug, Serialize)]
pub struct AiBoardListing {
    pub schema: &'static str,
    pub items: Vec<AiBoardItem>,
    /// 目录里被跳过的文件数（类型不认、是符号链接、太大）。
    /// 暴露出来是为了让「我明明写进去了却没显示」有个说法。
    pub skipped: usize,
}

/// 扩展名 → (kind, content-type)。认不出的不显示。
///
/// **故意不收 SVG**：SVG 能带脚本，而这些文件是 agent 写的。等有明确需求时
/// 再加，并且要走消毒，不是直接放行。
///
/// # HTML 收，但整条路和别的类型都不一样
///
/// agent 手里有 shell，让它直接写一份自包含 HTML，比我们为每种可视化定一套
/// schema + 写一个渲染器划算得多（画布那条路就是这么死的：加到第三种时
/// AGENTS.md 一半篇幅在教 agent 拼格式）。
///
/// 但它是**这里最危险的一种字节**：agent 读的是不受信的 PDF，一篇论文里埋一句
/// 提示注入就能让它写出任意脚本。而浏览器里 localStorage 存着用户的 API Key。
/// 所以放行的前提是这两道，缺一不可：
///
/// - 这一层：`forces_attachment` 对 html 返回 true，堵死「在 API 源上内联打开」
/// - 前端：只在 `sandbox="allow-scripts"`（**不给 allow-same-origin**）的 iframe
///   里用 srcdoc 渲染，再注入一条断网 CSP。见 reader-board-html.tsx。
///
/// 两个 sandbox 值同时给等于没有沙箱，那条由前端的门禁守着。
///
/// # PDF 收，但和 SVG 的区别要说清楚
///
/// PDF 一样能内嵌 JavaScript（`/OpenAction` + `/JavaScript`），它照样是 agent
/// 写的文件 —— 那为什么这个收、SVG 不收？因为**谁来解释这份字节**不一样：
///
/// - SVG 一旦被 `<img>` 之外的方式放进页面，脚本就在我们自己的 DOM 里跑
/// - PDF 在前端只经过 pdf.js 的 `page.render()`。那条路只画图，不开脚本
///   （`enableScripting` 是 viewer 的开关，我们压根没用 viewer）
///
/// 剩下的口子只有一个：有人**直接在地址栏打开**这个端点。那时解释字节的是
/// 浏览器自带的 PDF 阅读器，它是会跑 PDF 里的 JS 的。所以下载那边给 PDF 加了
/// `Content-Disposition: attachment`，见 `ai_board_file_download` —— 它不影响
/// 我们自己（`fetch()` 根本不看这个头），只把「在我们的 API 源上内联渲染一份
/// agent 写的 PDF」这条路堵死。
fn board_kind(name: &str) -> Option<(&'static str, &'static str)> {
    let ext = name.rsplit_once('.').map(|(_, ext)| ext)?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "webp" => Some(("image", "image/webp")),
        "gif" => Some(("image", "image/gif")),
        "pdf" => Some(("pdf", "application/pdf")),
        "md" => Some(("markdown", "text/markdown; charset=utf-8")),
        "json" => Some(("json", "application/json")),
        "txt" | "csv" => Some(("text", "text/plain; charset=utf-8")),
        "html" => Some(("html", "text/html; charset=utf-8")),
        _ => None,
    }
}

/// 哪些 kind 必须以附件下发。
///
/// PDF 和 HTML：这两种浏览器会当文档执行，而文件是 agent 写的。别的类型要么
/// 浏览器不会执行（图片），要么内联打开也只是一段纯文本。理由写在 `board_kind`
/// 上面那两段里。
///
/// 这个头**不影响我们自己**：前端拿这些文件走 `fetch()`，它根本不看
/// Content-Disposition。挡的是「有人直接在地址栏打开这个端点」。
fn forces_attachment(kind: &str) -> bool {
    matches!(kind, "pdf" | "html")
}

/// 只认单层、字符受限的文件名。
///
/// 拒绝以 `.` 开头顺带掐掉了 `.` / `..` 和隐藏文件，不用单独判。
pub(super) fn safe_board_name(name: &str) -> Result<&str, AppError> {
    if name.is_empty() || name.len() > MAX_BOARD_NAME_LEN {
        return Err(AppError::bad_request("board file name length out of range"));
    }
    if name.starts_with('.') {
        return Err(AppError::bad_request(
            "board file name must not start with a dot",
        ));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(AppError::bad_request(
            "board file name has unsupported characters",
        ));
    }
    Ok(name)
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 列出画板里能显示的东西。目录不存在 = 还没往里放过，返回空列表而不是 404 ——
/// 画板是叠加层，「没有」是正常状态。
pub(super) fn ai_board_listing(
    deps: &DownloadJobsDeps<'_>,
    job_id: &str,
) -> Result<AiBoardListing, AppError> {
    let job = load_supported_job(deps.db, deps.data_root, job_id)?;
    carry_over_ai_workspace(deps.db, deps.data_root, &job);
    let empty = AiBoardListing {
        schema: "retainpdf_ai_board_v1",
        items: Vec::new(),
        skipped: 0,
    };
    let Some(dir) = resolve_ai_board_dir(&job, deps.data_root) else {
        return Ok(empty);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(empty);
    };

    let mut items = Vec::new();
    let mut skipped = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 逐条跳过而不是整个失败：一个坏文件不该让整块画板消失。
        let Ok(name) = safe_board_name(&name).map(str::to_owned) else {
            skipped += 1;
            continue;
        };
        let Some((kind, content_type)) = board_kind(&name) else {
            skipped += 1;
            continue;
        };
        // symlink_metadata 不跟随链接 —— 这正是要拦的东西。
        let Ok(metadata) = entry.path().symlink_metadata() else {
            skipped += 1;
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            skipped += 1;
            continue;
        }
        if metadata.len() > MAX_BOARD_FILE_BYTES {
            skipped += 1;
            continue;
        }
        items.push(AiBoardItem {
            name,
            kind,
            content_type,
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }

    // 按时间排序：前端据此做时间流式布局，新的往后排，已有的位置不动。
    items.sort_by(|a, b| {
        a.modified_ms
            .cmp(&b.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    if items.len() > MAX_BOARD_ITEMS {
        skipped += items.len() - MAX_BOARD_ITEMS;
        items.truncate(MAX_BOARD_ITEMS);
    }
    Ok(AiBoardListing {
        schema: "retainpdf_ai_board_v1",
        items,
        skipped,
    })
}

/// 取画板里的一个文件。
///
/// 三道检查缺一不可，理由见模块头：文件名受限、拒绝符号链接、解析后仍在目录内。
pub(super) fn ai_board_file_download(
    deps: &DownloadJobsDeps<'_>,
    job_id: &str,
    name: &str,
) -> Result<FileDownload, AppError> {
    let job = load_supported_job(deps.db, deps.data_root, job_id)?;
    carry_over_ai_workspace(deps.db, deps.data_root, &job);
    let dir = resolve_ai_board_dir(&job, deps.data_root)
        .ok_or_else(|| AppError::not_found(format!("board not found: {job_id}")))?;
    let name = safe_board_name(name)?;
    let (kind, content_type) =
        board_kind(name).ok_or_else(|| AppError::bad_request("unsupported board file type"))?;

    let path = dir.join(name);
    let metadata = path
        .symlink_metadata()
        .map_err(|_| AppError::not_found(format!("board file not found: {name}")))?;
    if metadata.file_type().is_symlink() {
        // agent 在 board/ 里 `ln -s /etc/passwd leak.png` 就走到这里。
        return Err(AppError::bad_request("symlinked board file is not allowed"));
    }
    if !metadata.is_file() {
        return Err(AppError::not_found(format!("board file not found: {name}")));
    }
    if metadata.len() > MAX_BOARD_FILE_BYTES {
        return Err(AppError::bad_request("board file is too large"));
    }

    // 双保险：上面已经挡住了链接和 `..`，这里再确认一次解析结果仍在目录内。
    // 便宜，而且挡的是「目录本身被换成链接」这类我没想到的情况。
    let (Ok(resolved), Ok(resolved_dir)) = (path.canonicalize(), dir.canonicalize()) else {
        return Err(AppError::not_found(format!("board file not found: {name}")));
    };
    if !resolved.starts_with(&resolved_dir) {
        return Err(AppError::bad_request("board file escapes the board dir"));
    }

    // PDF 走附件。`safe_board_name` 已经把名字限死在 `[A-Za-z0-9._-]` 里，
    // 拼进 Content-Disposition 不会带出引号或换行 —— 这道头注入在别处要单独
    // 防，这里是白名单顺手挡掉的。
    let download_name = forces_attachment(kind).then(|| name.to_owned());
    Ok(FileDownload::new(resolved, content_type, download_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这些名字全都得被拒。`board/` 是 **agent** 写的目录，名字也来自浏览器 URL，
    /// 放过任何一个都等于把任意文件读取暴露出去。
    #[test]
    fn hostile_names_are_refused() {
        for hostile in [
            "../../../etc/passwd",
            "..",
            ".",
            "./x.png",
            "a/b.png",
            "a\\b.png",
            ".hidden.png",
            "",
            "x.png\0",
            "x y.png",     // 空格：不在白名单字符里
            "图.png",       // 非 ASCII：不在白名单里
            "%2e%2e/x.png",
            "x.png?a=1",
        ] {
            assert!(
                safe_board_name(hostile).is_err(),
                "这个名字被放行了: {hostile:?}"
            );
        }
    }

    #[test]
    fn ordinary_names_pass() {
        for ok in [
            "chart.png",
            "fig-3-residual-by-page.png",
            "table_2.json",
            "notes.md",
            "a.txt",
            "x1.jpeg",
        ] {
            assert!(safe_board_name(ok).is_ok(), "正常名字被拒了: {ok}");
        }
    }

    #[test]
    fn a_name_at_the_length_limit_is_accepted_but_one_over_is_not() {
        let stem = "a".repeat(MAX_BOARD_NAME_LEN - 4);
        assert!(safe_board_name(&format!("{stem}.png")).is_ok());
        let long = "a".repeat(MAX_BOARD_NAME_LEN + 1);
        assert!(safe_board_name(&long).is_err());
    }

    /// SVG 能带脚本，而这些文件是 agent 写的。要放行得先做消毒，不是直接收。
    ///
    /// HTML 后来放行了，但走的是另一条路（沙箱 iframe + 断网 CSP，见
    /// `html_is_a_board_kind_but_always_an_attachment`）。SVG 没有那条路：
    /// 它会被当图片直接塞进我们自己的 DOM，脚本就在页面里跑。
    #[test]
    fn svg_is_not_a_board_kind() {
        assert!(board_kind("x.svg").is_none());
        assert!(board_kind("x.js").is_none());
        // 认得出的那些还得在。
        assert_eq!(board_kind("x.png").map(|(k, _)| k), Some("image"));
        assert_eq!(board_kind("x.PNG").map(|(k, _)| k), Some("image"));
        assert_eq!(board_kind("x.md").map(|(k, _)| k), Some("markdown"));
        assert_eq!(board_kind("x.json").map(|(k, _)| k), Some("json"));
        assert!(board_kind("noext").is_none());
    }

    /// agent 现在能用 typst 写 `.typ` 渲出中文 PDF（PATH 上就有），所以 PDF 得认。
    #[test]
    fn pdf_is_a_board_kind() {
        assert_eq!(
            board_kind("report.pdf"),
            Some(("pdf", "application/pdf")),
            "PDF 没被认出来，agent 渲出来的东西在画布上就是不存在"
        );
        assert_eq!(board_kind("REPORT.PDF").map(|(k, _)| k), Some("pdf"));
    }

    /// HTML 是这里最危险的一种字节：agent 读不受信的 PDF，而浏览器里
    /// localStorage 存着 API Key。放行它的前提是**两道**，这里守第一道。
    #[test]
    fn html_is_a_board_kind_but_always_an_attachment() {
        assert_eq!(
            board_kind("chart.html"),
            Some(("html", "text/html; charset=utf-8")),
            "HTML 没被认出来，agent 写的可视化在前端就是不存在"
        );
        assert_eq!(board_kind("CHART.HTML").map(|(k, _)| k), Some("html"));
        assert!(
            forces_attachment("html"),
            "HTML 不强制附件 = 能在我们的 API 源上内联打开一份 agent 写的页面，\
             那时它和应用同源，localStorage 里的 key 就是它的"
        );
    }

    /// 会被浏览器当文档执行的才强制附件。加错了会把图片也变成下载。
    #[test]
    fn only_executable_kinds_force_an_attachment() {
        assert!(forces_attachment("pdf"));
        for inline in ["image", "markdown", "json", "text"] {
            assert!(!forces_attachment(inline), "{inline} 被改成附件了");
        }
    }
}

/// 端到端地过一遍下载那条路。
///
/// 单测 `forces_attachment` 只证明了策略，证明不了它**接上了**。这里建一个真的
/// job 目录、真的写文件，看 `FileDownload` 上的 `download_name` 到底是什么 ——
/// 那个字段就是 `Content-Disposition: attachment` 的开关（见 routes/job_helpers.rs）。
#[cfg(test)]
mod download_tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;
    use retainpdf_data::db::Db;
    use retainpdf_core::models::domain::{JobArtifacts, JobSnapshot};
    use retainpdf_core::models::request::CreateJobInput;
    use retainpdf_files::DownloadGeneration;

    struct BoardFixture {
        root: PathBuf,
        db: Db,
        generation: Arc<DownloadGeneration>,
    }

    impl BoardFixture {
        const JOB_ID: &'static str = "job-board-pdf";

        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("retain-board-pdf-{}", fastrand::u64(..)));
            let data_root = root.join("data");
            let job_root = data_root.join("jobs").join(Self::JOB_ID);
            std::fs::create_dir_all(job_root.join("ai/board")).expect("board dir");
            let db = Db::new(root.join("jobs.db"), data_root.clone());
            db.init().expect("db init");
            let mut job = JobSnapshot::new(Self::JOB_ID.into(), CreateJobInput::default(), vec![]);
            job.artifacts = Some(JobArtifacts {
                job_root: Some(format!("jobs/{}", Self::JOB_ID)),
                ..Default::default()
            });
            db.save_job(&job).expect("save job");
            Self {
                root,
                db,
                generation: Arc::new(DownloadGeneration::default()),
            }
        }

        fn data_root(&self) -> PathBuf {
            self.root.join("data")
        }

        fn board_dir(&self) -> PathBuf {
            self.data_root()
                .join("jobs")
                .join(Self::JOB_ID)
                .join("ai/board")
        }

        fn write(&self, name: &str, bytes: &[u8]) {
            std::fs::write(self.board_dir().join(name), bytes).expect("write board file");
        }

        fn download(&self, name: &str) -> Result<FileDownload, AppError> {
            let data_root = self.data_root();
            let downloads_dir = self.root.join("downloads");
            let deps = DownloadJobsDeps {
                db: &self.db,
                data_root: &data_root,
                downloads_dir: &downloads_dir,
                download_generation: &self.generation,
                python_bin: "python3",
                pipeline_command: "",
            };
            ai_board_file_download(&deps, Self::JOB_ID, name)
        }

        fn listing(&self) -> AiBoardListing {
            let data_root = self.data_root();
            let downloads_dir = self.root.join("downloads");
            let deps = DownloadJobsDeps {
                db: &self.db,
                data_root: &data_root,
                downloads_dir: &downloads_dir,
                download_generation: &self.generation,
                python_bin: "python3",
                pipeline_command: "",
            };
            ai_board_listing(&deps, Self::JOB_ID).expect("listing")
        }
    }

    impl Drop for BoardFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// PDF 能内嵌 JavaScript。我们自己的画布只让 pdf.js 画第一页（不开脚本），
    /// 但地址栏里直接打开这个端点的话，解释字节的是浏览器自带的阅读器 —— 它会跑。
    /// 附件头就是为了掐掉那条路。
    #[test]
    fn a_board_pdf_is_served_as_an_attachment() {
        let fixture = BoardFixture::new();
        fixture.write("report.pdf", b"%PDF-1.7\n");
        let download = fixture.download("report.pdf").expect("pdf download");
        assert_eq!(download.content_type, "application/pdf");
        assert_eq!(
            download.download_name.as_deref(),
            Some("report.pdf"),
            "PDF 没带附件头 —— 直接打开这个 URL 就是在我们的源上内联渲染 agent 写的 PDF"
        );
    }

    /// HTML 走完整条下发路径也必须带附件头。
    ///
    /// 只测 `forces_attachment("html")` 不够：那只证明那张表对了，不证明这条
    /// 分支真的接到了下发上（`board_kind` 和 `forces_attachment` 之间还隔着
    /// 一次 kind 字符串的传递，拼错了表照样对、下发照样裸奔）。
    #[test]
    fn a_board_html_is_served_as_an_attachment() {
        let fixture = BoardFixture::new();
        fixture.write("chart.html", b"<!doctype html><p>hi");
        let download = fixture.download("chart.html").expect("html download");
        assert_eq!(download.content_type, "text/html; charset=utf-8");
        assert_eq!(
            download.download_name.as_deref(),
            Some("chart.html"),
            "HTML 没带附件头 —— 在地址栏打开这个 URL，agent 写的页面就跑在我们的源上，\
             localStorage 里的 API Key 归它了"
        );
    }

    /// 图片必须保持内联：前端是靠 `fetch` 拿字节再转 data URL 的，一旦这里
    /// 顺手把所有类型都改成附件，别的地方（比如直接 `<img src>`）就会开始下载。
    #[test]
    fn other_board_kinds_stay_inline() {
        let fixture = BoardFixture::new();
        fixture.write("chart.png", b"\x89PNG\r\n");
        fixture.write("summary.md", b"# hi");
        for name in ["chart.png", "summary.md"] {
            let download = fixture.download(name).expect("download");
            assert_eq!(download.download_name, None, "{name} 变成附件了");
        }
    }

    /// 后缀白名单是这条路上第一道闸：认不出来的根本不该走到读文件那一步。
    #[test]
    fn unknown_extensions_are_still_refused() {
        let fixture = BoardFixture::new();
        fixture.write("evil.svg", b"<svg onload=alert(1)>");
        assert!(fixture.download("evil.svg").is_err(), "SVG 被放行了");
    }

    /// 列目录是产物条出现的**唯一**依据，而它此前一条测试都没有 —— 既有覆盖是
    /// `safe_board_name`（敌意名字）、`board_kind`（后缀白名单）和下发那条路的附件头。
    /// `board_kind` 的单测只证明那张表对了，证明不了它接到了列目录上。
    #[test]
    fn the_listing_shows_an_agent_written_html_with_the_kind_the_front_end_filters_on() {
        let fixture = BoardFixture::new();
        fixture.write("chart.html", b"<!doctype html><p>hi");
        let listing = fixture.listing();
        assert_eq!(
            listing.schema, "retainpdf_ai_board_v1",
            "schema 变了，前端的解包要跟着改"
        );
        let names: Vec<&str> = listing.items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(
            names, ["chart.html"],
            "agent 写进 board/ 的 HTML 没被列出来 —— 产物条永远是空的"
        );
        assert_eq!(
            listing.items[0].kind, "html",
            "kind 不是 html，前端的 openableBoardItems 会把它整个过滤掉"
        );
        assert_eq!(listing.skipped, 0, "正常文件被当成跳过项了");
    }

    /// 认不出的后缀只跳过它自己。`skipped` 是「我明明写进去了却不显示」唯一的说法。
    #[test]
    fn unknown_kinds_are_skipped_without_losing_the_rest() {
        let fixture = BoardFixture::new();
        fixture.write("chart.html", b"<p>ok");
        fixture.write("notes.rst", b"nope");
        // SVG 是故意不收的（能带脚本，而这些文件是 agent 写的）。
        fixture.write("evil.svg", b"<svg onload=alert(1)>");
        let listing = fixture.listing();
        assert_eq!(
            listing.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["chart.html"],
            "一个认不出的文件把整块画板带没了"
        );
        assert_eq!(listing.skipped, 2, "跳过的数量没报出来");
    }

    /// agent 手里有 shell，能 `ln -s /etc/passwd board/leak.png`。列目录就不该让它
    /// 出现 —— 下发那层会拒，但在它之前用户已经看到一个能点的条目了。
    #[cfg(unix)]
    #[test]
    fn symlinks_never_appear_in_the_listing() {
        let fixture = BoardFixture::new();
        fixture.write("chart.html", b"<p>ok");
        std::os::unix::fs::symlink("/etc/passwd", fixture.board_dir().join("leak.png"))
            .expect("symlink");
        let listing = fixture.listing();
        assert_eq!(
            listing.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["chart.html"],
            "符号链接被列了出来"
        );
        assert_eq!(listing.skipped, 1);
    }

    /// 超限的要跳过：列一个点开就被拒的东西，比不列更糟。
    #[test]
    fn oversized_files_are_skipped_in_the_listing() {
        let fixture = BoardFixture::new();
        fixture.write("chart.html", b"<p>ok");
        std::fs::File::create(fixture.board_dir().join("huge.json"))
            .expect("create")
            .set_len(MAX_BOARD_FILE_BYTES + 1)
            .expect("grow");
        let listing = fixture.listing();
        assert_eq!(
            listing.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(),
            ["chart.html"],
            "超限文件进了列表，点开会被下载那条路拒掉"
        );
        assert_eq!(listing.skipped, 1);
    }

    /// 时间流式布局的前提：列表自己就是有序的，同毫秒时按名字稳定。
    #[test]
    fn the_listing_is_sorted_so_the_front_end_can_lay_it_out_by_time() {
        let fixture = BoardFixture::new();
        for name in ["c.html", "a.html", "b.html"] {
            fixture.write(name, b"<p>ok");
        }
        let listing = fixture.listing();
        assert_eq!(listing.items.len(), 3, "三个文件没都列出来，下面的有序断言就没分量");
        assert!(
            listing.items.windows(2).all(|pair| {
                (pair[0].modified_ms, pair[0].name.as_str())
                    <= (pair[1].modified_ms, pair[1].name.as_str())
            }),
            "列表没有按 (时间, 名字) 排好 —— 产物条每轮询一次就换一次顺序"
        );
    }
}
