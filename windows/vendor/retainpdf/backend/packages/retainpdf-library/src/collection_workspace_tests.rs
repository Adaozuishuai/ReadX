//! 文件夹级的 agent 工作区。
//!
//! 起因：到这一版为止 agent 的工作区钉死在单个 job 上，所以「这几篇里哪些互相
//! 矛盾」这类问题**在结构上问不出来** —— 不是模型不行，是它看不见第二本书。
//!
//! 这里守四件事，每一件反过来都是一种安静的错：
//! - 成员书能被看见（不然这个功能等于没做）
//! - **跳过的书要被说出来**（沉默地少几本 = agent 以为它看全了，结论是错的）
//! - 重建 books/ 不能顺手删掉 agent 的产出
//! - 重译换了 active_job 之后，链接要跟着换（指着旧译文不会报错，只是错）

use std::fs;
use std::path::PathBuf;

use retainpdf_data::db::Db;
use retainpdf_core::models::domain::{CreateJobInput, JobArtifacts, JobSnapshot, UploadRecord};

use super::collection_workspace::{
    collection_workspace_dir, ensure_collection_workspace, link_name,
};

struct Fixture {
    root: PathBuf,
    db: Db,
}

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("retain-collection-ws-{}", fastrand::u64(..)));
        fs::create_dir_all(root.join("uploads")).unwrap();
        let db = Db::new(root.join("jobs.db"), root.clone());
        db.init().unwrap();
        Self { root, db }
    }

    /// 建一本书：upload → document → job，并把 job 设成 active。
    ///
    /// 全程走公开 API（`save_upload_with_document` / `link_job_to_document` /
    /// `set_document_active_job`），不直接 UPDATE 表 —— 直接写表的话，哪天归属
    /// 换个存法这些测试会继续绿着骗人。
    fn book(&self, document_id: &str, title: &str, job_id: &str) -> PathBuf {
        let job_root = self.root.join("jobs").join(job_id);
        fs::create_dir_all(job_root.join("ocr")).unwrap();
        fs::write(job_root.join("ocr").join("document.v1.json"), b"{}").unwrap();

        let upload_id = self.upload(document_id, title, job_id);
        let mut job = JobSnapshot::new(job_id.into(), CreateJobInput::default(), vec![]);
        job.artifacts = Some(JobArtifacts {
            job_root: Some(format!("jobs/{job_id}")),
            ..Default::default()
        });
        self.db.save_job(&job).unwrap();
        self.db.link_job_to_document(job_id, &upload_id).unwrap();
        self.db
            .set_document_active_job(document_id, job_id, Some(7))
            .unwrap();
        job_root
    }

    /// 一本还没翻译完的书：有档案，但 `active_job_id` 始终是 NULL。
    fn book_without_translation(&self, document_id: &str, title: &str) {
        self.upload(document_id, title, "never-translated");
    }

    fn upload(&self, document_id: &str, title: &str, tag: &str) -> String {
        let upload_id = format!("upload-{document_id}-{tag}");
        self.db
            .save_upload_with_document(&UploadRecord {
                upload_id: upload_id.clone(),
                filename: format!("{document_id}.pdf"),
                stored_path: self
                    .root
                    .join("uploads")
                    .join(format!("{document_id}.pdf"))
                    .to_string_lossy()
                    .into_owned(),
                bytes: 1,
                page_count: 7,
                uploaded_at: "2026-09-23T00:00:00Z".into(),
                developer_mode: false,
                content_hash: document_id.into(),
            })
            .unwrap();
        self.db
            .update_document_fields(document_id, Some(title), None)
            .unwrap();
        upload_id
    }

    fn collect(&self, collection_id: &str, document_ids: &[&str]) {
        self.db
            .create_collection(collection_id, "测试文件夹", None)
            .unwrap();
        self.db
            .add_documents_to_collection(
                collection_id,
                &document_ids.iter().map(|id| (*id).to_string()).collect::<Vec<_>>(),
            )
            .unwrap();
    }

    fn workspace(&self, collection_id: &str) -> PathBuf {
        collection_workspace_dir(&self.root, collection_id)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn every_member_book_shows_up_under_books() {
    let fx = Fixture::new();
    fx.book("doc-a", "注意力机制综述", "job-a");
    fx.book("doc-b", "扩散模型的采样加速", "job-b");
    fx.collect("col-1", &["doc-a", "doc-b"]);

    let manifest = ensure_collection_workspace(&fx.db, &fx.root, "col-1", &|_| None).unwrap();
    assert_eq!(manifest.books.len(), 2);
    assert!(manifest.skipped.is_empty());

    // 链接名用标题 —— agent `ls books/` 要能一眼看出有哪几本。
    let books = fx.workspace("col-1").join("books");
    assert!(books.join("注意力机制综述").join("ocr").join("document.v1.json").exists());
    assert!(books.join("扩散模型的采样加速").join("ocr").join("document.v1.json").exists());

    // 清单也要落盘：Python 那边不认识 collection，只会读这份 JSON。
    let raw = fs::read_to_string(fx.workspace("col-1").join("collection.v1.json")).unwrap();
    assert!(raw.contains("retainpdf_collection_workspace_v1"));
    assert!(raw.contains("注意力机制综述"));
}

#[test]
fn books_without_a_translation_are_reported_not_silently_dropped() {
    // 沉默地少几本最糟：agent 以为自己看全了这个文件夹，然后给出一个
    // 「这几篇都没提到 X」的结论 —— 而提到 X 的那篇正好还没翻译完。
    let fx = Fixture::new();
    fx.book("doc-a", "翻译好的", "job-a");
    fx.book_without_translation("doc-b", "还没翻译的");
    fx.collect("col-1", &["doc-a", "doc-b"]);

    let manifest = ensure_collection_workspace(&fx.db, &fx.root, "col-1", &|_| None).unwrap();
    assert_eq!(manifest.books.len(), 1);
    assert_eq!(manifest.skipped.len(), 1, "被跳过的书没进清单");
    assert_eq!(manifest.skipped[0].title, "还没翻译的");
    assert!(!manifest.skipped[0].reason.is_empty(), "没说为什么跳过");

    let raw = fs::read_to_string(fx.workspace("col-1").join("collection.v1.json")).unwrap();
    assert!(raw.contains("还没翻译的"), "跳过的书没写进清单，agent 看不见");
}

#[test]
fn refreshing_keeps_agent_output_and_repoints_links() {
    // 重译之后 active_job 会变。链接还指着旧 job 的话，agent 读到的是上一次的
    // 译文 —— 不报错，只是错。
    let fx = Fixture::new();
    fx.book("doc-a", "会被重译的书", "job-old");
    fx.collect("col-1", &["doc-a"]);
    ensure_collection_workspace(&fx.db, &fx.root, "col-1", &|_| None).unwrap();

    // agent 在工作区里干了活。
    let notes = fx.workspace("col-1").join("notes-across-books.md");
    fs::write(&notes, "跨书笔记").unwrap();

    // 重译：新 job 成为 active。
    fx.book("doc-a", "会被重译的书", "job-new");
    let manifest = ensure_collection_workspace(&fx.db, &fx.root, "col-1", &|_| None).unwrap();

    assert_eq!(manifest.books[0].job_id, "job-new", "还指着旧 job");
    let link = fx.workspace("col-1").join("books").join("会被重译的书");
    assert_eq!(fs::read_link(&link).unwrap(), fx.root.join("jobs").join("job-new"));
    // 重建 books/ 不能顺手把 agent 的产出删了 —— 那是它攒下来的全部东西。
    assert_eq!(fs::read_to_string(&notes).unwrap(), "跨书笔记");
}

#[test]
fn same_titled_books_do_not_overwrite_each_other() {
    // 同一篇论文的两个版本标题一样。后一条盖掉前一条的话，agent `ls books/`
    // 看到一本，而清单里写着两本 —— 它会以为有个文件丢了。
    let fx = Fixture::new();
    fx.book("doc-a", "同名论文", "job-a");
    fx.book("doc-b", "同名论文", "job-b");
    fx.collect("col-1", &["doc-a", "doc-b"]);

    let manifest = ensure_collection_workspace(&fx.db, &fx.root, "col-1", &|_| None).unwrap();
    assert_eq!(manifest.books.len(), 2);
    let dirs: Vec<_> = manifest.books.iter().filter_map(|b| b.dir.clone()).collect();
    assert_eq!(dirs.len(), 2);
    assert_ne!(dirs[0], dirs[1], "两本书指向同一个链接名");
    for dir in &dirs {
        assert!(fx.workspace("col-1").join("books").join(dir).exists());
    }
}

// ------------------------------------------------------- 链接名（纯逻辑，不碰磁盘）
//
// 这里**故意没有**走真实目录的那一版。写过，删了：把清洗改坏之后它是**挂住**
// 而不是变红（symlink 到一个解析出去的绝对路径上），在 CI 上表现成超时，不是
// 失败 —— 等于没有门禁。纯函数没有这个问题。

/// 标题来自 PDF 元数据，不是我们控制的。
///
/// **这几条刻意不走文件系统。** 同样的断言用真实目录做过一版，而把清洗改坏之后
/// 那一版是**挂住**而不是变红 —— 在 CI 上表现成超时，不是失败，等于没有门禁。
/// 纯函数没有这个问题：改坏了当场断言失败。
#[test]
fn a_title_that_looks_like_a_path_never_becomes_one() {
    let mut taken = std::collections::HashSet::new();
    for title in [
        "../../../etc/passwd",
        "/etc/passwd",
        "a/b/c",
        "..",
        ".",
        ".hidden",
        "....//....//x",
    ] {
        let name = link_name(title, "doc-0123456789", &mut taken);
        assert!(!name.contains('/'), "{title} -> {name}：名字里有路径分隔符");
        assert!(!name.contains('\\'), "{title} -> {name}：名字里有反斜杠");
        assert!(!name.starts_with('.'), "{title} -> {name}：名字以点开头");
        assert!(!name.is_empty(), "{title} -> 空名字");
        // 拼进目录之后不能跳出去 —— Path::join 遇到绝对路径会把基路径整个换掉。
        let joined = std::path::Path::new("/tmp/books").join(&name);
        assert_eq!(
            joined.parent(),
            Some(std::path::Path::new("/tmp/books")),
            "{title} -> {name}：拼出来的路径跑到 books/ 外面了"
        );
    }
}

#[test]
fn chinese_titles_survive_intact() {
    // 上一条那些检查很容易用「ASCII 白名单」一刀切满足,代价是中文标题全被削光,
    // `ls books/` 变成一排 book-1 book-2 —— 那就白做了。
    let mut taken = std::collections::HashSet::new();
    let name = link_name("注意力机制综述（第二版）", "doc-0123456789", &mut taken);
    assert_eq!(name, "注意力机制综述（第二版）");
}

#[test]
fn a_title_that_sanitizes_to_nothing_still_gets_a_name() {
    // 空名字会让链接建在 books/ 目录本身上。
    let mut taken = std::collections::HashSet::new();
    for title in ["", "   ", "...", "///", "..."] {
        let name = link_name(title, "doc-0123456789", &mut taken);
        assert!(!name.is_empty(), "「{title}」削成了空名字");
    }
}
