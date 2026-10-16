import Foundation
import AppKit
import PDFKit
import UniformTypeIdentifiers

extension Store {
    var dataDir: URL { progressURL.deletingLastPathComponent() }
    var profileURL: URL { dataDir.appendingPathComponent("profile.json") }
    var libraryStateURL: URL { dataDir.appendingPathComponent("library.json") }
    var discoveryURL: URL { dataDir.appendingPathComponent("discovery.json") }
    var compareURL: URL { dataDir.appendingPathComponent("compare.json") }

    @discardableResult func persist<T: Encodable>(_ value: T, to url: URL) -> Bool {
        guard !blockedPersistenceURLs.contains(url) else {
            dataError = "\(url.lastPathComponent) 读取失败，请先恢复文件后再保存。"
            return false
        }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(value).write(to: url, options: .atomic)
            return true
        } catch { dataError = "保存失败：\(url.lastPathComponent) · \(error.localizedDescription)"; return false }
    }
    /// 历史快照目录只保留每个论文最新 `keep` 份：重新生成用 UUID 命名归档，
    /// 没有清理就会无上限堆积（readings 与代码快照共用同一策略）。
    func pruneHistory(in dir: URL, prefix: String, keep: Int = 10) {
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        let sorted = files
            .filter { $0.lastPathComponent.hasPrefix(prefix) }
            .sorted { a, b in
                let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return da > db
            }
        for url in sorted.dropFirst(keep) { try? FileManager.default.removeItem(at: url) }
    }
    func loadResearchData() {
        isLoadingResearchData = true
        defer { isLoadingResearchData = false }
        func load<T: Decodable>(_ type: T.Type, _ url: URL, fallback: T) -> T {
            guard FileManager.default.fileExists(atPath: url.path) else {
                blockedPersistenceURLs.remove(url)
                return fallback
            }
            do {
                let value = try JSONDecoder().decode(type, from: Data(contentsOf: url))
                blockedPersistenceURLs.remove(url)
                return value
            } catch {
                blockedPersistenceURLs.insert(url)
                dataError = "\(url.lastPathComponent) 读取失败，原文件已保留：\(error.localizedDescription)"
                return fallback
            }
        }
        profile = load(ResearchProfile.self, profileURL, fallback: profile)
        libraryState = load([String: LibraryState].self, libraryStateURL, fallback: libraryState)
        discovery = load(DiscoveryCache.self, discoveryURL, fallback: discovery)
        // Migrate older caches that mixed arXiv preprints into the peer-reviewed feed.
        let legacyPreprints = discovery.papers.filter { ($0.source ?? "").localizedCaseInsensitiveContains("arxiv") }
        if !legacyPreprints.isEmpty {
            discovery.papers.removeAll { ($0.source ?? "").localizedCaseInsensitiveContains("arxiv") }
            discovery.preprints = PaperIdentity.deduplicate((discovery.preprints ?? []) + legacyPreprints)
        }
        // 早期缓存没有 firstSeen：回填为首次抓取日（界面会标注该口径，不等于真实发表日）
        if discovery.firstSeen.isEmpty, !(discovery.papers + (discovery.preprints ?? [])).isEmpty {
            let day = discovery.fetchedAt.count >= 10 ? String(discovery.fetchedAt.prefix(10)) : Self.nowISO()
            discovery.firstSeen = DiscoveryCache.mergedFirstSeen([:], papers: discovery.papers + (discovery.preprints ?? []), day: day)
        }
        let compare = load(CompareSession.self, compareURL, fallback: CompareSession())
        comparePinned = CompareLayout.reconciled(compare.selected, pinned: compare.pinned)
        selectedComparison = Set(compare.selected)
        loadIdeas()
        loadReproductionChecklists()
        loadCodeSnapshots()
    }
    var allPapers: [QueueEntry] {
        if let cachedAllPapers { return cachedAllPapers }
        let noteEntries = notes.map { note -> QueueEntry in
            var p = QueueEntry(arxiv: note.meta["arxiv"]?.str, id: note.id, title: note.title, venue: note.venue)
            p.why = note.sections["summary"]
            return p
        }
        let result = PaperIdentity.deduplicate(queue + noteEntries + discovery.papers + (discovery.preprints ?? []))
        cachedAllPapers = result
        return result
    }
    var savedPapers: [QueueEntry] {
        // 已删除（回收站）的论文不出现在论文库、推荐与今日中；回收站视图用 deletedPapers
        allPapers.filter { state($0.key).status != .deleted }
            .filter { paper in queue.contains(where: { PaperIdentity.same($0, paper) }) || noteForQueue(paper) != nil || libraryState[paper.key] != nil }
    }
    /// 回收站：被标记删除但仍保留本地状态的论文，可恢复或彻底删除（PRD 8.3）
    var deletedPapers: [QueueEntry] {
        allPapers.filter { state($0.key).status == .deleted }
    }
    /// 移入回收站：保留标签/笔记/纠错等本地状态，随时可恢复
    func deletePaper(_ key: String) {
        guard mutateLibrary(key, { $0.status = .deleted }) else { return }
        selectedComparison.remove(key)
        showToast("已移入回收站，可随时恢复")
    }
    /// 从回收站恢复为未读
    func restorePaper(_ key: String) {
        guard mutateLibrary(key, { $0.status = .unread }) else { return }
        showToast("已恢复到论文库")
    }
    /// 彻底删除：移除该论文的全部本地状态（标签/笔记/纠错/反馈），不可恢复。
    /// 论文本身若仍在队列或发现源中，会以「未读」重新出现；精读记录与 Markdown 笔记保留。
    func purgePaper(_ key: String) {
        pendingPersistTasks[libraryStateURL]?.cancel()
        pendingPersistTasks[libraryStateURL] = nil
        pendingPersist.removeValue(forKey: libraryStateURL)
        var next = libraryState
        next.removeValue(forKey: key)
        guard persist(next, to: libraryStateURL) else { return }
        libraryState = next
        invalidatePaperCaches()
        computeToday()
        showToast("已彻底删除本地记录")
    }
    func state(_ key: String) -> LibraryState {
        var value = libraryState[key] ?? LibraryState()
        if libraryState[key] == nil, progress[key]?.doneAt != nil { value.status = .read }
        return value
    }
    @discardableResult
    func mutateLibrary(_ key: String, _ mutation: (inout LibraryState) -> Void) -> Bool {
        var value = state(key); mutation(&value)
        value.updatedAt = ISO8601DateFormatter().string(from: Date())
        var next = libraryState; next[key] = value
        guard persistThrottled(next, to: libraryStateURL) else { return false }
        libraryState = next
        invalidatePaperCaches()
        computeToday()
        return true
    }
    var rankedPapers: [RankedPaper] {
        if let cachedRankedPapers { return cachedRankedPapers }
        var negative: [String: Int] = [:]
        for paper in allPapers where state(paper.key).relevance < 0 {
            let text = ((paper.title ?? "") + " " + (paper.abstract ?? "")).lowercased()
            for (topic, words) in ResearchProfile.keywords where words.contains(where: text.contains) { negative[topic, default: 0] += 1 }
        }
        let eligible = allPapers.filter { paper in
            let s = state(paper.key)
            return s.status != .ignored && s.status != .deleted && s.relevance >= 0
        }
        let ranked = eligible.map { PaperIdentity.rank($0, profile: profile, state: state($0.key), negativeTopics: negative) }
        let result = ranked.sorted { a, b in a.score == b.score ? (a.paper.published ?? "") > (b.paper.published ?? "") : a.score > b.score }
        cachedRankedPapers = result
        return result
    }
    func reference(_ paper: QueueEntry) -> PaperRef {
        let note = noteForQueue(paper)
        return PaperRef(key: paper.key, arxiv: paper.arxiv ?? "", noteId: note?.id, hasNote: note != nil,
                        title: paper.title ?? paper.key, venue: paper.venue ?? "", why: paper.why ?? "")
    }
    func saveProfile(_ value: ResearchProfile) {
        guard persist(value, to: profileURL) else { return }
        profile = value; invalidatePaperCaches(); computeToday()
        showToast("研究画像已保存，推荐排序已更新")
    }
    /// 持久化对比选择集与固定列（PRD 4.8「对比可保存」）；小对象，直接原子写。
    func persistCompareSession() {
        guard !isLoadingResearchData else { return }
        _ = persist(CompareSession(selected: selectedComparison.sorted(),
                                   pinned: CompareLayout.reconciled(selectedComparison.sorted(), pinned: comparePinned)), to: compareURL)
    }
    func refreshDiscovery(force: Bool = false) async {
        guard !discoveryBusy else { return }
        if !force, String(discovery.fetchedAt.prefix(10)) == Self.nowISO() { return }
        discoveryBusy = true
        var papers: [QueueEntry] = [], preprints: [QueueEntry] = [], errors: [String] = [], successes = 0
        do {
            let arxivEntries = try await DiscoveryService.arxiv()
            papers += arxivEntries.filter { ($0.source ?? "").localizedCaseInsensitiveCompare("arXiv 预印本") != .orderedSame }
            preprints += arxivEntries.filter { ($0.source ?? "").localizedCaseInsensitiveCompare("arXiv 预印本") == .orderedSame }
            successes += 1
        } catch {
            errors.append("arXiv 预印本源：\(error.localizedDescription)")
            preprints += discovery.preprints ?? []
        }
        do { papers += try await DiscoveryService.semanticScholar(); successes += 1 }
        catch {
            errors.append("期刊会议源：\(error.localizedDescription)")
            papers += discovery.papers.filter { $0.source != "PubMed" && !(($0.source ?? "").localizedCaseInsensitiveContains("arxiv")) }
        }
        do { papers += try await DiscoveryService.pubmed(); successes += 1 }
        catch { errors.append("PubMed：\(error.localizedDescription)"); papers += discovery.papers.filter { $0.source == "PubMed" } }
        discovery.errors = errors
        if successes > 0 {
            discovery.papers = PaperIdentity.deduplicate(papers)
            discovery.preprints = PaperIdentity.deduplicate(preprints)
            let allDiscovered = discovery.papers + (discovery.preprints ?? [])
            discovery.firstSeen = DiscoveryCache.mergedFirstSeen(discovery.firstSeen, papers: allDiscovered, day: Self.nowISO())
            let formatter = DateFormatter(); formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"; formatter.timeZone = .current
            discovery.fetchedAt = formatter.string(from: Date())
            persist(discovery, to: discoveryURL)
        }
        discoveryBusy = false; invalidatePaperCaches(); computeToday()
    }
    /// 今日新增：首见日期为今天的发现论文（PRD 5.1「准确的新增计数」）
    var todayNewPapers: [QueueEntry] {
        discovery.papers.filter { discovery.firstSeen[$0.key] == Self.nowISO() }
    }
    var todayNewPreprints: [QueueEntry] {
        (discovery.preprints ?? []).filter { discovery.firstSeen[$0.key] == Self.nowISO() }
    }
    func addToQueue(_ paper: QueueEntry) {
        if !queue.contains(where: { PaperIdentity.same($0, paper) }) {
            let nextQueue = PaperIdentity.deduplicate(queue + [paper])
            struct Envelope: Encodable { var papers: [QueueEntry] }
            guard persist(Envelope(papers: nextQueue), to: queueURL) else { return }
            queue = nextQueue
            invalidatePaperCaches()
        }
        guard mutateLibrary(paper.key, { $0.status = .later }) else { return }
        showToast("已加入稍后读")
    }
    func importPDF(for existing: QueueEntry? = nil) {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.pdf]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let input = panel.url else { return }
        do {
            guard let doc = PDFDocument(url: input), doc.pageCount > 0 else { throw DiscoveryService.invalidSource() }
            var paper = existing ?? QueueEntry(id: "local-" + UUID().uuidString.lowercased(), title: (doc.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String) ?? input.deletingPathExtension().lastPathComponent, venue: "本地私有论文")
            if existing == nil { paper.source = "本地导入" }
            try FileManager.default.createDirectory(at: libraryDir, withIntermediateDirectories: true)
            let destination = libraryDir.appendingPathComponent(paper.key.replacingOccurrences(of: "/", with: "-") + ".pdf")
            try Data(contentsOf: input).write(to: destination, options: .atomic)
            try? FileManager.default.removeItem(at: pdfTextURL(paper.key))
            addToQueue(paper)
            if let s = session, s.ref.key == paper.key { s.pdfState = .ready(destination); s.sourceText = ""; Task { await preparePDF(s) } }
            showToast("PDF 已私有保存到本地论文库")
        } catch { dataError = "导入 PDF 失败：\(error.localizedDescription)" }
    }
    func preparePDF(_ s: SessionState) async {
        s.evidencePhase = "下载 / 打开 PDF"
        s.pdfState = .loading
        do {
            let url = try await ensurePDF(for: s.ref)
            s.pdfState = .ready(url)
            s.evidenceRequest = UUID()
            s.evidencePhase = "解析 PDF 文字"
            do { s.sourceText = try await ensurePDFText(for: s.ref); s.evidencePhase = "原文证据已就绪" }
            catch { s.evidencePhase = "文本解析失败；PDF 可继续阅读" }
        } catch { s.pdfState = .failed(error.localizedDescription); s.evidencePhase = "全文不可用，可导入 PDF 后重试" }
    }
    func jumpToEvidence(_ s: SessionState, page: Int, excerpt: String = "") {
        guard page > 0 else { return }
        if case .ready(let url) = s.pdfState, let doc = PDFDocument(url: url), page > doc.pageCount {
            showToast("该页码超出 PDF 范围，请反馈纠错"); return
        }
        s.evidencePage = page; s.evidenceExcerpt = excerpt; s.evidenceRequest = UUID(); setStep(2)
    }
    func exportResearch() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "CBCT-research-\(Self.nowISO()).json"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        struct Export: Encodable {
            var schemaVersion = "1.4"
            var profile: ResearchProfile
            var papers: [QueueEntry]
            var library: [String: LibraryState]
            var progress: [String: ProgressEntry]
            var readings: [ReadingFile]
            var notes: [String: String]
            var ideas: [ResearchIdea]
            var reproduction: [String: ReproductionChecklist]
            var code: [String: CodeSnapshot]
        }
        let noteText = Dictionary(uniqueKeysWithValues: notes.map { ($0.file, (try? String(contentsOf: papersDir.appendingPathComponent($0.file), encoding: .utf8)) ?? "") })
        // 回收站条目不随资产导出：删除的语义是「不再属于个人论文库」（readings 同口径）
        let activeLibrary = libraryState.filter { $0.value.status != .deleted }
        persist(Export(profile: profile, papers: savedPapers, library: activeLibrary, progress: progress,
                       readings: savedPapers.compactMap { loadReadings($0.key) }, notes: noteText, ideas: ideas, reproduction: reproductionChecklists, code: codeSnapshots), to: url)
    }
}
