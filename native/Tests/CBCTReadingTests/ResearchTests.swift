import Foundation
import PDFKit
import CoreGraphics
import ImageIO
import SwiftUI
import AppKit
#if canImport(CBCTReading)
// swift test（SPM）模式：从可执行目标导入被测代码；test.sh 裸编译模式下由本文件自带全部源码
@testable import CBCTReading
#endif

// Standalone regression harness: works with macOS Command Line Tools (no XCTest required).
private var failures = 0
private var passes = 0
struct TestFailure: Error { var message: String }
struct SkipTest: Error { var message: String }
func XCTSkip(_ message: String) -> SkipTest { SkipTest(message: message) }
func report(_ ok: Bool, _ message: String) { if !ok { failures += 1; print("  FAIL: " + message) } }
func XCTAssertEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T, _ message: String = "") {
    do { let av = try a(), bv = try b(); report(av == bv, message.isEmpty ? "Expected \(bv), got \(av)" : message) } catch { report(false, error.localizedDescription) }
}
func XCTAssertTrue(_ value: @autoclosure () -> Bool, _ message: String = "Expected true") { report(value(), message) }
func XCTAssertFalse(_ value: @autoclosure () -> Bool, _ message: String = "Expected false") { report(!value(), message) }
func XCTAssertNil<T>(_ value: @autoclosure () -> T?, _ message: String = "Expected nil") { report(value() == nil, message) }
func XCTAssertLessThan<T: Comparable>(_ a: T, _ b: T) { report(a < b, "Expected \(a) < \(b)") }
func XCTAssertGreaterThan<T: Comparable>(_ a: T, _ b: T) { report(a > b, "Expected \(a) > \(b)") }
func XCTAssertThrowsError<T>(_ value: @autoclosure () throws -> T) { do { _ = try value(); report(false, "Expected error") } catch {} }
func XCTAssertNoThrow<T>(_ value: @autoclosure () throws -> T) { do { _ = try value() } catch { report(false, error.localizedDescription) } }
func XCTUnwrap<T>(_ value: T?) throws -> T { guard let value else { throw TestFailure(message: "Expected non-nil value") }; return value }

final class ResearchTests {
    func testExistingQueueEnvelopeAndLegacyArray() throws {
        let envelope = Data(#"{"papers":[{"arxiv":"2209.14540v2","title":"NAF"},{"arxiv":"2209.14540","title":"NAF"},{"id":"intratomo-2021","title":"IntraTomo"}]}"#.utf8)
        let papers = try PaperIdentity.decodeQueue(envelope)
        XCTAssertEqual(papers.count, 2)
        XCTAssertEqual(papers[0].key, "2209.14540")
        XCTAssertEqual(try PaperIdentity.decodeQueue(Data(#"[{"id":"manual-paper"}]"#.utf8)).count, 1)
        XCTAssertThrowsError(try PaperIdentity.decodeQueue(Data("invalid".utf8)))
    }
    func testDOIDedupAcrossSourcesPreservesManualMetadata() {
        let a = QueueEntry(arxiv: "2609.12345v2", title: "Original", venue: "MICCAI", doi: "https://doi.org/10.1000/ABC")
        let b = QueueEntry(id: "pubmed-123", title: "Original", abstract: "New abstract", doi: "10.1000/abc", source: "PubMed")
        let papers = PaperIdentity.deduplicate([a, b])
        XCTAssertEqual(papers.count, 1)
        XCTAssertEqual(papers[0].venue, "MICCAI")
        XCTAssertEqual(papers[0].abstract, "New abstract")
    }
    func testTitleAuthorDedupAvoidsUnrelatedAuthors() {
        let a = QueueEntry(id: "a", title: "Sparse-view CBCT reconstruction using neural fields", authors: ["Alice Zhang"])
        let b = QueueEntry(id: "b", title: "Sparse view CBCT Reconstruction using Neural Fields!", authors: ["Alice Zhang", "Bob"])
        let c = QueueEntry(id: "c", title: a.title, authors: ["Other Person"])
        XCTAssertEqual(PaperIdentity.deduplicate([a, b, c]).count, 2)
    }
    func testProfileAndNegativeFeedbackChangeRanking() {
        let p = QueueEntry(id: "a", title: "Sparse-view CBCT reconstruction with implicit neural fields", abstract: "Walnut dataset")
        let profile = ResearchProfile()
        let baseline = PaperIdentity.rank(p, profile: profile, state: LibraryState())
        XCTAssertTrue(baseline.reasons.contains { $0.contains("Sparse-view") })
        var disabled = profile; disabled.topics = [:]
        XCTAssertLessThan(PaperIdentity.rank(p, profile: disabled, state: LibraryState()).score, baseline.score)
        var negative = LibraryState(); negative.relevance = -1
        XCTAssertLessThan(PaperIdentity.rank(p, profile: profile, state: negative).score, baseline.score)
        XCTAssertLessThan(PaperIdentity.rank(p, profile: profile, state: LibraryState(), negativeTopics: ["Sparse-view": 3]).score, baseline.score)
    }
    func testSemanticScholarParsesVenuesAndFields() throws {
        // 论文来源已切换为期刊/会议（TMI/MIA/MICCAI/CVPR/NeurIPS/ICLR/AAAI），不再使用 arXiv
        let json = #"""
        {"data":[
            {"paperId":"a1","title":"Sparse-view CBCT reconstruction","venue":"2021 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)","year":2021,"publicationDate":"2021-06-19","authors":[{"name":"Alice Zhang"},{"name":"Bo Li"}],"externalIds":{"DOI":"10.1109/x.1"},"openAccessPdf":{"url":"https://openaccess.thecvf.com/x.pdf"},"abstract":"CBCT"},
            {"paperId":"a2","title":"Journal paper","venue":"IEEE Transactions on Medical Imaging","year":2022,"authors":[]},
            {"paperId":"a3","title":"MICCAI proceedings paper","venue":"Medical Image Computing and Computer-Assisted Intervention -- MICCAI 2020","year":2020,"authors":[]},
            {"paperId":"a4","title":"Random preprint","venue":"arXiv (Cornell University)","year":2023,"authors":[]},
            {"paperId":"a5","title":"Workshop paper","venue":"Some Workshop 2024","year":2024,"authors":[]},
            {"title":"No venue","year":2024,"authors":[]}
        ]}
        """#
        let papers = try DiscoveryService.parseSemanticScholar(Data(json.utf8))
        XCTAssertEqual(papers.map(\.source), ["CVPR", "TMI", "MICCAI"])
        XCTAssertEqual(papers[0].doi, "10.1109/x.1")
        XCTAssertEqual(papers[0].pdfUrl, "https://openaccess.thecvf.com/x.pdf")
        XCTAssertEqual(papers[0].published, "2021-06-19")
        XCTAssertEqual(papers[0].authors, ["Alice Zhang", "Bo Li"])
        XCTAssertNil(papers[0].arxiv, "来源清单里不应再出现 arXiv 通道")
        XCTAssertEqual(DiscoveryService.preferredVenue("NeurIPS 2019"), "NeurIPS")
        XCTAssertEqual(DiscoveryService.preferredVenue("IEEE International Symposium on Biomedical Imaging (ISBI)"), "ISBI")
        XCTAssertEqual(DiscoveryService.preferredVenue("SPIE Medical Imaging 2025"), "SPIE Medical Imaging")
        XCTAssertEqual(DiscoveryService.preferredVenue("Medical Image Analysis"), "MIA")
        XCTAssertNil(DiscoveryService.preferredVenue("Some Workshop"))
        XCTAssertNil(DiscoveryService.preferredVenue(""))
    }

    func testCrossrefFallbackOnlyKeepsAllowlistedVenues() throws {
        let json = #"{"message":{"items":[{"DOI":"10.1000/cvpr","title":["Cone beam reconstruction"],"container-title":["Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition"],"author":[{"given":"Ada","family":"Lovelace"}],"abstract":"<jats:p>Evidence-based abstract.</jats:p>","published":{"date-parts":[[2025,6,1]]},"link":[{"URL":"https://example.org/paper.pdf","content-type":"application/pdf"}]},{"DOI":"10.1000/workshop","title":["Workshop paper"],"container-title":["CVPR Workshops"]},{"DOI":"10.1000/preprint","title":["Preprint"],"container-title":["arXiv"]}]}}"#
        let papers = try DiscoveryService.parseCrossref(Data(json.utf8))
        XCTAssertEqual(papers.count, 1)
        XCTAssertEqual(papers[0].source, "CVPR")
        XCTAssertEqual(papers[0].authors, ["Ada Lovelace"])
        XCTAssertEqual(papers[0].abstract, "Evidence-based abstract.")
        XCTAssertEqual(papers[0].published, "2025-6-1")
        XCTAssertEqual(papers[0].pdfUrl, "https://example.org/paper.pdf")
    }
    func testPubmedStructuredAbstractAndMissingFullText() throws {
        let xml = #"<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><ArticleTitle>Sparse-view <i>CBCT</i> reconstruction</ArticleTitle><Abstract><AbstractText Label="METHODS">Neural fields.</AbstractText><AbstractText Label="RESULTS">Simulation only.</AbstractText></Abstract><Journal><Title>Medical Physics</Title><JournalIssue><PubDate><Year>2026</Year><Month>09</Month></PubDate></JournalIssue></Journal><AuthorList><Author><LastName>Zhang</LastName><ForeName>Alice</ForeName></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/ABC</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>"#
        let p = try XCTUnwrap(DiscoveryService.parsePubmed(Data(xml.utf8)).first)
        XCTAssertEqual(p.title, "Sparse-view CBCT reconstruction")
        XCTAssertEqual(p.published, "2026-09")
        XCTAssertTrue(p.abstract?.contains("RESULTS: Simulation only.") == true)
        XCTAssertNil(p.pdfUrl, "PubMed metadata does not imply full-text access")
    }
    func testEvidenceRetrievalPreservesPageNumbersAndIncludesLatePages() throws {
        let text = (1...12).map { "=== Page \($0) ===\n" + String(repeating: $0 == 12 ? "geometry detector " : "introduction ", count: 30) }.joined(separator: "\n\n")
        let selected = Evidence.select(text, query: "geometry detector", limit: 750)
        XCTAssertTrue(Evidence.pages(selected).contains { $0.number == 12 })
        XCTAssertLessThan(selected.count, 800)
        XCTAssertNoThrow(try Evidence.validate("Detector (Page 12)", source: selected))
        XCTAssertThrowsError(try Evidence.validate("Detector (Page 99)", source: selected))
        XCTAssertThrowsError(try Evidence.validate("Uncited claims", source: selected))
    }
    func testEvidenceLinksAndCitations() {
        XCTAssertEqual(Evidence.citations("(Page 3), Page 12, Page 3"), [3, 12])
        XCTAssertEqual(Evidence.linked("(Page 12)"), "([Page 12](cbct-evidence://page/12))")
        XCTAssertEqual(Evidence.linked("[Page 12](cbct-evidence://page/12)"), "[Page 12](cbct-evidence://page/12)")
    }
    func testScopeDoesNotSilentlyIncludeOtherSections() {
        let text = "=== Page 1 ===\n1 Introduction\nBackground\n=== Page 2 ===\n2 Method\nHash encoder\n=== Page 3 ===\n3 Experiments\n50 projections\n4 Conclusion\nSummary"
        let method = Evidence.select(text, query: "views", scope: "Method")
        XCTAssertTrue(method.contains("Hash encoder"))
        XCTAssertFalse(method.contains("50 projections"))
        XCTAssertTrue(Evidence.select(text, query: "views", scope: "Experiment").contains("50 projections"))
        XCTAssertEqual(Evidence.select(text, query: "appendix", scope: "Appendix"), "")
    }
    @MainActor
    func testConfigurationTimestampDoesNotReadExtendedAttributes() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertTrue(Store.fileMtime(root.appendingPathComponent("queue.json")) != nil)
        XCTAssertNil(Store.fileMtime(root.appendingPathComponent("missing.json")))
    }
    func testExperimentRejectsFabricatedExcerptAndPage() throws {
        let source = "=== Page 4 ===\nWe train using 50 views with a detector of 512 x 512 pixels."
        let good = ExperimentField(k: "views", v: "50 views", page: 4, excerpt: "We train using 50 views")
        var extraction = ExperimentExtraction(dataset: [], acquisition: [good], training: [], loss: [], metrics: [], results: [])
        XCTAssertNoThrow(try extraction.validate(source: source))
        extraction.acquisition[0].excerpt = "We train using 100 views"
        XCTAssertThrowsError(try extraction.validate(source: source))
        extraction.acquisition[0] = good; extraction.acquisition[0].page = 8
        XCTAssertThrowsError(try extraction.validate(source: source))
        extraction.acquisition[0] = ExperimentField(k: "GPU", v: "论文未说明", page: nil, excerpt: nil)
        XCTAssertNoThrow(try extraction.validate(source: source))
        XCTAssertThrowsError(try ExperimentExtraction.decode("{\"dataset\":42}"))
        XCTAssertNoThrow(try extraction.validateConfiguration())
        extraction.training = [.init(k: "训练时长", v: "10-40 minutes", page: 3, excerpt: "reconstruct a detailed CT model within 10-40 minutes")]
        XCTAssertThrowsError(try extraction.validateConfiguration())
        extraction.training = []
        extraction.loss = [.init(k: "损失公式", v: "L=x", page: 5, excerpt: "Loss L=x")]
        XCTAssertThrowsError(try extraction.validateConfiguration())
    }
    func reproductionFixture() -> ReproductionAnalysis {
        let known = ReproductionItem(finding: ExperimentField(k: "views", v: "50 views", page: 4, excerpt: "We train using 50 views"), assessment: "Control the acquisition protocol", action: "Check geometry and views before evaluation")
        let unknown = ReproductionItem(finding: ExperimentField(k: "Dependency version", v: "论文未说明", page: nil, excerpt: nil), assessment: "Version compatibility needs testing", action: "Check supplementary material and pinned dependencies")
        return ReproductionAnalysis(resources: [unknown], environment: [unknown], cost: [unknown], missing: [known], risks: [unknown])
    }
    func testReproductionGroundingCoverageAndUnknowns() throws {
        let source = "=== Page 4 ===\nWe train using 50 views with fixed geometry."
        let good = reproductionFixture()
        XCTAssertNoThrow(try good.validate(source: source))
        XCTAssertEqual(good.unknownCount, 4)
        let raw = String(decoding: try JSONEncoder().encode(good), as: UTF8.self)
        XCTAssertEqual(try ReproductionAnalysis.decode("```json\n" + raw + "\n```").fingerprint, good.fingerprint)
        var bad = good; bad.environment = []; XCTAssertThrowsError(try bad.validate(source: source))
        bad = good; bad.missing[0].finding.v = "100 views"; XCTAssertThrowsError(try bad.validate(source: source))
        bad = good; bad.cost[0].finding.v = "24 GB fits"; XCTAssertThrowsError(try bad.validate(source: source))
        bad = good; bad.risks[0].action = "Check Page 999"; XCTAssertThrowsError(try bad.validate(source: source))
        bad = good; bad.resources += bad.resources; XCTAssertThrowsError(try bad.validate(source: source))
        bad = good; bad.missing[0].action = " "; XCTAssertThrowsError(try bad.validate(source: source))
        let page = "method can reconstruct a detailed CT model within 10-40 minutes, which is comparable to iterative methods."
        let crossPage = "While most INR approaches take hours for training, our " + page
        XCTAssertEqual(Evidence.matchingQuoteFragment(crossPage, in: page), page)
        var crossing = good; crossing.cost = [ReproductionItem(finding: ExperimentField(k: "time", v: "10-40 minutes", page: 3, excerpt: crossPage), assessment: "Reported time only", action: "Profile separately")]
        XCTAssertThrowsError(try crossing.validate(source: "=== Page 3 ===\n" + page))
    }
    @MainActor func testReproductionProgressRevisionsPersistenceAndCorruption() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false), analysis = reproductionFixture()
        let checked = ReproductionTask(status: .verified, note: "Verified PDF Page 4; geometry still pending")
        XCTAssertFalse(store.saveReproductionTask(key: "a", analysis: analysis, itemID: "missing:0", task: ReproductionTask(status: .verified)))
        XCTAssertFalse(store.saveReproductionTask(key: "a", analysis: analysis, itemID: "missing:9", task: checked))
        XCTAssertTrue(store.saveReproductionTask(key: "a", analysis: analysis, itemID: "missing:0", task: checked))
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.reproductionTask(key: "a", revision: analysis.fingerprint, itemID: "missing:0").status, .verified)
        var changed = analysis; changed.missing[0].finding.v = "New analysis value"
        XCTAssertEqual(fresh.reproductionTask(key: "a", revision: changed.fingerprint, itemID: "missing:0").status, .todo)
        XCTAssertTrue(fresh.saveReproductionTask(key: "a", analysis: changed, itemID: "missing:0", task: ReproductionTask(status: .blocked, note: "Need a new evaluation protocol")))
        XCTAssertEqual(fresh.reproductionChecklists["a"]?.revisions.count, 2)
        XCTAssertEqual(fresh.reproductionChecklists["a"]?.analyses?[analysis.fingerprint]?.missing.first?.finding.v, "50 views")
        XCTAssertEqual(fresh.reproductionTask(key: "a", revision: analysis.fingerprint, itemID: "missing:0").note, checked.note)
        try "invalid".write(to: store.reproductionURL("a"), atomically: true, encoding: .utf8)
        let corrupt = Store(root: root, startTimers: false)
        XCTAssertTrue(corrupt.reproductionLoadFailures.contains("a"))
        XCTAssertFalse(corrupt.saveReproductionTask(key: "a", analysis: analysis, itemID: "missing:0", task: checked))
        XCTAssertEqual(try String(contentsOf: store.reproductionURL("a")), "invalid")
        XCTAssertTrue(corrupt.saveReproductionTask(key: "b", analysis: analysis, itemID: "missing:0", task: checked))
        let blockedRoot = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: blockedRoot) }
        let blocked = Store(root: blockedRoot, startTimers: false)
        try FileManager.default.createDirectory(at: blocked.dataDir, withIntermediateDirectories: true)
        try "file instead of directory".write(to: blocked.reproductionDir, atomically: true, encoding: .utf8)
        blocked.loadReproductionChecklists()
        XCTAssertTrue(blocked.reproductionDirectoryFailed)
        XCTAssertFalse(blocked.saveReproductionTask(key: "a", analysis: analysis, itemID: "missing:0", task: checked))
    }
    @MainActor func testReproductionIdeaAndExportDoNotPromoteUnknowns() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false), analysis = reproductionFixture(), ref = store.reference(store.queue[0])
        try FileManager.default.createDirectory(at: store.pdfTextURL(ref.key).deletingLastPathComponent(), withIntermediateDirectories: true)
        try "=== Page 4 ===\nWe train using 50 views with fixed geometry.".write(to: store.pdfTextURL(ref.key), atomically: true, encoding: .utf8)
        store.ideaFromReproduction(analysis.environment[0], ref: ref)
        XCTAssertEqual(store.ideaDraft?.status, .planned)
        XCTAssertFalse(store.ideaDraft?.evidence.contains { $0.origin == .paper } == true)
        XCTAssertTrue(store.ideaDraft?.observation.contains("当前论文材料未找到") == true)
        store.ideaFromReproduction(analysis.missing[0], ref: ref)
        XCTAssertEqual(store.ideaDraft?.evidence.first?.page, 4)
        let draft = try XCTUnwrap(store.ideaDraft)
        XCTAssertTrue(store.saveIdea(draft))
        let checked = ReproductionTask(status: .blocked, note: "Await geometry")
        XCTAssertTrue(store.saveReproductionTask(key: ref.key, analysis: analysis, itemID: "missing:0", task: checked))
        let markdown = Store.reproductionMarkdown(analysis, ref: ref, checklist: store.reproductionChecklists[ref.key])
        XCTAssertTrue(markdown.contains("PDF Page 4")); XCTAssertTrue(markdown.contains("AI 分析 / 推断"))
        XCTAssertTrue(markdown.contains("人工核对：受阻")); XCTAssertTrue(markdown.contains("Await geometry"))
        XCTAssertTrue(markdown.contains("不等于复现成功"))
        var old = try JSONDecoder().decode(ReadingFile.self, from: Data(#"{"key":"a","tldr":"Original"}"#.utf8))
        XCTAssertNil(old.reproductionJSON)
        old.reproductionJSON = String(decoding: try JSONEncoder().encode(analysis), as: UTF8.self)
        XCTAssertTrue(store.saveReadings(old))
        XCTAssertEqual(try ReproductionAnalysis.decode(try XCTUnwrap(store.loadReadings("a")?.reproductionJSON)).fingerprint, analysis.fingerprint)
    }
    func testOldReadingsRemainDecodableAndNewAuditRoundTrips() throws {
        let old = try JSONDecoder().decode(ReadingFile.self, from: Data(#"{"key":"a","tldr":"Legacy (Page 1)"}"#.utf8))
        XCTAssertNil(old.audit)
        XCTAssertNil(old.motivation)
        var updated = old
        updated.motivation = "研究问题与实际需求 (Page 1)"
        updated.method = "方法管线 (Page 3)"
        updated.audit = ["tldr": ReadingAudit(model: "test-model", generatedAt: "2026-10-02", extractionVersion: "v2", evidencePages: [1, 2])]
        let restored = try JSONDecoder().decode(ReadingFile.self, from: JSONEncoder().encode(updated))
        XCTAssertEqual(restored.audit?["tldr"]?.evidencePages, [1, 2])
        XCTAssertEqual(restored.motivation, updated.motivation)
        XCTAssertEqual(restored.method, updated.method)
        XCTAssertEqual(restored.tldr, old.tldr)
    }
    @MainActor
    func testLibraryProfileNotesAndFeedbackPersistAfterReload() throws {
        let root = try temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        XCTAssertEqual(store.queue.count, 2)
        store.mutateLibrary("2209.14540") { $0.favorite = true; $0.status = .later; $0.tags = ["复现"]; $0.notes = "测试笔记"; $0.corrections = "核对 views" }
        var profile = ResearchProfile(); profile.hardware = "RTX 3090 24 GB"
        store.saveProfile(profile)
        let fresh = Store(root: root, startTimers: false)
        XCTAssertTrue(fresh.state("2209.14540").favorite)
        XCTAssertEqual(fresh.state("2209.14540").tags, ["复现"])
        XCTAssertEqual(fresh.state("2209.14540").notes, "测试笔记")
        XCTAssertEqual(fresh.profile.hardware, "RTX 3090 24 GB")
        fresh.mutateLibrary("2209.14540") { $0.relevance = -1 }
        XCTAssertFalse(fresh.rankedPapers.contains { $0.id == "2209.14540" })
        fresh.mutateLibrary("2209.14540") { $0.relevance = 0; $0.status = .ignored }
        XCTAssertFalse(fresh.rankedPapers.contains { $0.id == "2209.14540" })
        XCTAssertNil(fresh.dataError)
    }
    @MainActor
    func testLibraryDeleteRestoreAndPurge() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.mutateLibrary("2209.14540") { $0.favorite = true; $0.notes = "保留我" }
        XCTAssertTrue(store.savedPapers.contains { $0.key == "2209.14540" })
        // 移入回收站：从论文库/推荐消失，但本地状态保留
        store.deletePaper("2209.14540")
        XCTAssertFalse(store.savedPapers.contains { $0.key == "2209.14540" })
        XCTAssertFalse(store.rankedPapers.contains { $0.id == "2209.14540" })
        XCTAssertEqual(store.deletedPapers.map(\.key), ["2209.14540"])
        XCTAssertEqual(store.state("2209.14540").notes, "保留我")
        XCTAssertFalse(store.selectedComparison.contains("2209.14540"))
        // 恢复：回到论文库，状态为未读
        store.restorePaper("2209.14540")
        XCTAssertTrue(store.savedPapers.contains { $0.key == "2209.14540" })
        XCTAssertEqual(store.state("2209.14540").status, .unread)
        // 彻底删除：本地记录完全移除
        store.deletePaper("2209.14540")
        store.purgePaper("2209.14540")
        XCTAssertEqual(store.state("2209.14540").notes, "")
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.state("2209.14540").notes, "")
        // 旧数据兼容：library.json 中没有 deleted 状态时正常解码
        let legacy = try JSONDecoder().decode(LibraryState.self, from: Data(#"{"status":"reading","favorite":false,"tags":[],"notes":"","relevance":0,"corrections":"","updatedAt":""}"#.utf8))
        XCTAssertEqual(legacy.status, .reading)
    }
    @MainActor
    func testCompareSessionPersistsAndComparabilityWarns() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.selectedComparison = ["2209.14540", "manual"]
        store.comparePinned = "manual"
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.selectedComparison, ["2209.14540", "manual"])
        XCTAssertEqual(fresh.comparePinned, "manual")
        // 移除被固定的论文后，固定自动清理
        fresh.selectedComparison.remove("manual")
        XCTAssertNil(fresh.comparePinned)
        let reloaded = Store(root: root, startTimers: false)
        XCTAssertNil(reloaded.comparePinned)
        XCTAssertEqual(reloaded.selectedComparison, ["2209.14540"])
        // 可比性检查：已知值不一致时警示；未知不参与、不误报
        let rows: [(String, [String])] = [
            ("视角数", ["views：50 views (Page 6)", "views：25 views (Page 5)"]),
            ("几何", ["论文未说明 / 尚未抽取", "0–180°"]),
            ("数据集", ["Walnut", "Walnut"]),
        ]
        let warnings = Comparability.warnings(rows: rows)
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("视角数不一致"))
        XCTAssertTrue(warnings[0].contains("不能直接排名"))
        XCTAssertTrue(Comparability.warnings(rows: [("视角数", ["50 views", "50 views"])]).isEmpty)
        XCTAssertTrue(Comparability.warnings(rows: [("结果", ["33.05", "31.94"])]).isEmpty)
    }
    func testDiscoveryFirstSeenAndTopicGrouping() throws {
        // firstSeen：新论文记为当天，已有记录不覆盖
        let a = QueueEntry(arxiv: "2501.00001", title: "Sparse-view CBCT reconstruction with neural fields")
        let b = QueueEntry(id: "pubmed-9", title: "Low-dose CT denoising")
        var seen = DiscoveryCache.mergedFirstSeen([:], papers: [a, b], day: "2026-10-02")
        XCTAssertEqual(seen["2501.00001"], "2026-10-02")
        seen = DiscoveryCache.mergedFirstSeen(seen, papers: [a, b, QueueEntry(arxiv: "2501.00002", title: "Diffusion CT")], day: "2026-10-03")
        XCTAssertEqual(seen["2501.00001"], "2026-10-02")
        XCTAssertEqual(seen["2501.00002"], "2026-10-03")
        // 主题分组：归入权重最高的匹配主题，其余进「领域探索」
        func ranked(_ p: QueueEntry) -> RankedPaper { RankedPaper(paper: p, score: 10, reasons: []) }
        let groups = TopicNavigation.grouped([ranked(a), ranked(b), ranked(QueueEntry(id: "x", title: "Unrelated optics study"))], topics: ["Sparse-view", "Low-dose"])
        XCTAssertEqual(groups.first(where: { $0.0 == "Sparse-view" })?.1.count, 1)
        XCTAssertEqual(groups.first(where: { $0.0 == "Low-dose" })?.1.count, 1)
        XCTAssertEqual(groups.first(where: { $0.0 == "领域探索" })?.1.count, 1)
        // 空输入与全匹配都不会产生空组
        XCTAssertTrue(TopicNavigation.grouped([], topics: ["Sparse-view"]).isEmpty)
    }
    @MainActor
    func testRetrievalChunksCosineAndKeywordFallback() async throws {
        // R-05：分块 / 余弦 / 无 API 时关键词回退检索
        XCTAssertTrue(abs(TextMath.cosine([1, 0], [1, 0]) - 1.0) < 1e-9)
        XCTAssertTrue(abs(TextMath.cosine([1, 0], [0, 1])) < 1e-9)
        XCTAssertTrue(abs(TextMath.cosine([1, 0], [2, 0]) - 1.0) < 1e-9)
        XCTAssertEqual(TextMath.cosine([], []), 0.0)
        let source = "\n\n=== Page 1 ===\nshort\n\n=== Page 2 ===\n" + String(repeating: "x", count: 2500)
        let chunks = TextMath.chunks(paper: "p", source: source)
        XCTAssertEqual(chunks.count, 4) // 第 1 页 1 块；第 2 页 2500 字 → 1200+1200+100 共 3 块
        XCTAssertEqual(chunks[0].page, 1)
        XCTAssertEqual(chunks[1].page, 2)
        XCTAssertEqual(chunks[1].text.count, 1200)
        XCTAssertEqual(chunks[3].text.count, 100)
        XCTAssertTrue(TextMath.keywordScore("Gaussian splatting beats NAF", terms: ["gaussian", "naf"]) > 0)
        XCTAssertTrue(TextMath.keywordScore("nothing relevant here", terms: ["gaussian"]) == 0)

        // 无 API 配置：检索自动回退关键词；索引为关键词索引且已落盘
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let textDir = root.appendingPathComponent("library/text")
        try FileManager.default.createDirectory(at: textDir, withIntermediateDirectories: true)
        try "\n\n=== Page 3 ===\nThe gaussian splatting representation reconstructs sparse-view CT.\n".write(to: textDir.appendingPathComponent("b-v3.txt"), atomically: true, encoding: .utf8)
        try "\n\n=== Page 1 ===\nTotally unrelated recipe text about soup.\n".write(to: textDir.appendingPathComponent("a-v3.txt"), atomically: true, encoding: .utf8)
        let store = Store(root: root, startTimers: false)

        // Chat 路径只读已有索引：磁盘上没有索引时必须返回空，不得在请求路径里现建
        let coldHits = await store.retrieveAcrossLibrary(query: "gaussian splatting", excluding: "current")
        XCTAssertTrue(coldHits.isEmpty)

        _ = await store.retrievalIndex(for: "b")   // 预热建索引
        let hits = await store.retrieveAcrossLibrary(query: "gaussian splatting sparse-view CT", excluding: "current", topK: 2)
        XCTAssertEqual(hits.first?.paper, "b")
        XCTAssertEqual(hits.first?.page, 3)
        XCTAssertFalse(hits.first?.viaEmbedding ?? true)
        let index = try JSONDecoder().decode(RetrievalIndex.self, from: Data(contentsOf: store.retrievalIndexURL("b")))
        XCTAssertNil(index.model)
        // 无命中关键词的其他论文不应出现在结果里（a 未建索引 → 直接跳过）
        XCTAssertFalse(hits.contains { $0.paper == "a" })

        // 跨论文材料块必须写明论文名与页码，供引用校验做归属判断
        let block = Store.libraryContextBlock(hits)
        XCTAssertTrue(block.contains("Page 3"))
        XCTAssertTrue(block.contains("必须同时写出论文名与 Page N"))
    }
    // MARK: - 公式排版 / 结构图解析

    func testMathParserSupportsCommonStructuresAndDegrades() {
        // 常见结构必须解析成功
        for latex in ["x^2 + y^2 = z^2", "\\frac{a}{b}", "\\sqrt{x + 1}", "\\sum_{i=1}^{N} x_i",
                      "\\mathcal{L} = \\| \\mathbf{x} - \\hat{x} \\|^2", "\\alpha \\cdot \\beta \\leq \\gamma",
                      "\\int_{0}^{1} f(x) dx", "y_{i,j}^{(t)}"] {
            let parsed = MathParser.parse(latex)
            XCTAssertTrue(parsed.supported, "应支持：\(latex)")
            XCTAssertFalse(parsed.nodes.isEmpty)
            XCTAssertGreaterThan(MathMetrics.width(parsed.nodes, size: 15), 0)
        }
        // 不认识的命令必须标记不支持（调用方降级展示原始 LaTeX，不做半渲染）
        let unknown = MathParser.parse("\\begin{matrix} a & b \\end{matrix}")
        XCTAssertFalse(unknown.supported)
        let weird = MathParser.parse("\\someUndefinedCommand{x}")
        XCTAssertFalse(weird.supported)
        // 未闭合分组不应崩溃，且结果可用
        let unbalanced = MathParser.parse("\\frac{a}{b")
        XCTAssertFalse(unbalanced.nodes.isEmpty)
    }

    func testMathSegmentsAndFlatten() {
        // 行内 / 独立公式分段
        let segments = MathSegmenter.split("令 $x_i$ 表示投影，则 $$L = \\|x\\|^2$$ 成立")
        XCTAssertTrue(segments.contains { if case .inlineMath(let l) = $0 { return l == "x_i" } else { return false } })
        XCTAssertTrue(segments.contains { if case .blockMath(let l) = $0 { return l.contains("L =") } else { return false } })
        // 未闭合的 $ 不吞掉正文
        let unclosed = MathSegmenter.split("价格是 5 $ 与 10 元")
        XCTAssertTrue(unclosed.contains { if case .text(let s) = $0 { return s.contains("10 元") } else { return false } })
        // \(...\) / \[...\]
        let parens = MathSegmenter.split("行内 \\(a+b\\) 与独立 \\[c=d\\]")
        XCTAssertTrue(parens.contains { if case .inlineMath(let l) = $0 { return l == "a+b" } else { return false } })
        XCTAssertTrue(parens.contains { if case .blockMath(let l) = $0 { return l == "c=d" } else { return false } })
        // 简单公式压成 Unicode 上下标（可随正文换行）
        let flat = MathFlatten.unicode(MathParser.parse("x_i^2").nodes)
        XCTAssertEqual(flat, "xᵢ²")
        XCTAssertEqual(MathFlatten.unicode(MathParser.parse("\\mathcal{ABC}").nodes), "𝒜ℬ𝒞")
        XCTAssertEqual(MathFlatten.unicode(MathParser.parse("\\mathbb{R}^n").nodes), "ℝⁿ")
        // 分数属于复杂结构，不压平（改由行内视图渲染）
        XCTAssertNil(MathFlatten.unicode(MathParser.parse("\\frac{a}{b}").nodes))
        // Markdown 独立公式块
        let blocks = Markdown.parse("说明\n\n$$E = mc^2$$\n\n后续")
        XCTAssertTrue(blocks.contains { if case .mathBlock(let l) = $0 { return l == "E = mc^2" } else { return false } })
        // 未闭合的 $$ 不吞掉后续正文
        let dangling = Markdown.parse("$$未闭合\n后续正文仍应在")
        XCTAssertTrue(dangling.contains { if case .paragraph(let lines) = $0 { return lines.joined().contains("后续正文仍应在") } else { return false } })
    }

    @MainActor func testMethodFormulaWorkflow() throws {
        let raw = "% Eq. (2)\n\\frac{a}{b} = \\sqrt{x}\n\n% Eq. (3)\n$$\n\\mathcal{L}=\\sum_{r\\in B} x_r^2\n$$"
        let rendered = MethodMath.transcriptionMarkdown(raw)
        let formulas = Store.formulas(in: rendered)
        XCTAssertEqual(formulas.count, 2)
        XCTAssertTrue(formulas.allSatisfy { MathParser.parse($0).supported })
        XCTAssertTrue(MathParser.parse("\\mathcal{L}=\\sum_{r\\in B}\\left\\lVert I_r(r)-I_s(r)\\right\\rVert^2").supported)
        XCTAssertEqual(MathFlatten.unicode(MathParser.parse("h(c) \\bmod T").nodes), "h(c) mod T")
        XCTAssertTrue(Markdown.parse(rendered).contains { if case .mathBlock = $0 { return true }; return false })
        XCTAssertTrue(Store.formulas(in: MethodMath.transcriptionMarkdown("% 本页没有可辨认的公式")).isEmpty)
        XCTAssertTrue(Store.formulas(in: MethodMath.transcriptionMarkdown("无法完整辨认公式")).isEmpty)
        let fenced = MethodMath.notesMarkdown("说明\n```latex\n\\frac{x_i}{2} = y\n```\n后续")
        XCTAssertEqual(Store.formulas(in: fenced), ["\\frac{x_i}{2} = y"])
        XCTAssertTrue(fenced.contains("后续"))
        let code = "```python\nx = 3\n```"
        XCTAssertEqual(MethodMath.notesMarkdown(code), code)
        let matrix = Store.formulas(in: MethodMath.transcriptionMarkdown("% Eq. 1\n\\begin{matrix}a&b\\end{matrix}"))
        XCTAssertEqual(matrix.count, 1)
        XCTAssertFalse(MathParser.parse(matrix[0]).supported)
        let source = "=== Page 1 ===\n1 Introduction\na = b\n=== Page 3 ===\n2 Method\n2.1 Pipeline\nx = f(p)\n=== Page 4 ===\n2.2 Encoding\nH = I(p)\n=== Page 5 ===\n3 Experiments\nPSNR = 35\n=== Page 6 ===\nReferences\ny = 1"
        XCTAssertEqual(MethodMath.pages(in: source, method: "Page 1; Page 5"), [3, 4])
        XCTAssertFalse(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: "N"))
        XCTAssertFalse(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: "L"))
        XCTAssertFalse(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: #"\mathrm{X}"#))
        XCTAssertFalse(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: #"\left[ 9 \right]"#))
        XCTAssertFalse(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: #"\mathcal{M}_{\mathcal{H}}"#))
        XCTAssertTrue(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: #"\mathbf{p} \in \mathbb{R}^{3}"#))
        XCTAssertTrue(LocalFormulaOCR.isFormulaCandidate(kind: "embedding", latex: #"x_i + y_i"#))
        XCTAssertTrue(LocalFormulaOCR.isFormulaCandidate(kind: "isolated", latex: "x"))
        XCTAssertEqual(MethodMath.pages(in: "=== Page 7 ===\nx=y\n=== Page 8 ===\na=b", method: "Eq. (2), Page 8"), [8])
        // The visual API returns no locally generated dropped/note keys.
        let figure = try FigureAnalysis.decode("{\"title\":\"Fig. 1\",\"nodes\":[{\"id\":\"n1\",\"label\":\"Input\",\"kind\":\"input\"},{\"id\":\"n2\",\"label\":\"MLP\",\"kind\":\"module\"}],\"edges\":[{\"from\":\"n1\",\"to\":\"n2\"}]}")
        XCTAssertTrue(figure.validated(against: "Input MLP").isUsable)
        let saved = ReadingFile(key: "paper", methodFormulas: [MethodFormulaPage(page: 4, source: raw)])
        let decoded = try JSONDecoder().decode(ReadingFile.self, from: JSONEncoder().encode(saved))
        XCTAssertEqual(decoded.methodFormulas, saved.methodFormulas)
        let legacy = try JSONDecoder().decode(ReadingFile.self, from: Data("{\"key\":\"legacy\",\"method\":\"old notes\"}".utf8))
        XCTAssertNil(legacy.methodFormulas)
    }

    func testLocalFormulaOCRWrapperOnRealPDF() throws {
        guard ProcessInfo.processInfo.environment["CBCT_FORMULA_OCR_SMOKE"] == "1" else {
            throw XCTSkip("Set CBCT_FORMULA_OCR_SMOKE=1 to run the local model integration check")
        }
        let root = testWorkspace()
        let pdfURL = root.appendingPathComponent("library/2022-NAF-2209.14540.pdf")
        guard FileManager.default.fileExists(atPath: pdfURL.path) else { throw XCTSkip("NAF PDF unavailable") }
        let pdf = try XCTUnwrap(PDFDocument(url: pdfURL))
        let page = try XCTUnwrap(pdf.page(at: 3))
        let bounds = page.bounds(for: .mediaBox)
        let image = page.thumbnail(of: CGSize(width: bounds.width * 3, height: bounds.height * 3), for: .mediaBox)
        let cgImage = try XCTUnwrap(image.cgImage(forProposedRect: nil, context: nil, hints: nil))
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]))
        let output = try LocalFormulaOCR.transcribe(png: png, script: LocalFormulaOCR.scriptURL(projectRoot: root))
        XCTAssertTrue(output.contains("\\mathcal") || output.contains("\\mathbf"), "OCR must return parseable LaTeX, not page prose")
        XCTAssertTrue(output.contains("\\in"), "structured inline math should survive filtering")
        XCTAssertEqual(output.components(separatedBy: "% Local OCR formula ").count - 1, 2,
                       "Only the verified equation and structured inline expression should remain; discard symbol/legend embeddings")
        XCTAssertFalse(output.contains("(embedding)\n$$\nN\n$$"), "single-character legend labels must not be emitted as formulas")
        XCTAssertFalse(output.contains("(embedding)\n$$\nL\n$$"), "single-character legend labels must not be emitted as formulas")
        XCTAssertFalse(output.contains("\\mathrm{X}"), "single-letter legend labels must not be emitted as formulas")
    }

    @MainActor func testModuleFormulaPlacement() throws {
        let escaped = #"% Eq. (1)\n$$\n\\mathcal{H}=\\frac{x}{y}\n$$"#
        let recovered = MethodMath.equations([MethodFormulaPage(page: 4, source: escaped)])
        XCTAssertEqual(recovered.count, 1)
        XCTAssertEqual(recovered.first?.latex, #"\mathcal{H}=\frac{x}{y}"#)
        XCTAssertTrue(MethodMath.transcriptionMarkdown(#"$$\nabla x$$"#).contains(#"\nabla"#))
        let pages = [MethodFormulaPage(page: 4, source: "% Eq. (1)\n$$H=\\frac{x}{y}$$"),
                     MethodFormulaPage(page: 5, source: "% Eq. (2)\n$$I=I_0\\exp(-\\sum_i\\mu_i\\delta_i)$$")]
        let notes = "## 编码模块\n输入坐标，输出编码。\n\n[[formula:p4-e1]]\n\n符号 H 表示特征，解决表示问题。\n\n## 投影合成\n输入衰减系数，输出投影。\n\n[[formula:p5-e1]]\n\n符号 I 表示输出投影。"
        XCTAssertNoThrow(try MethodMath.validateReferences(notes, pages: pages))
        let integrated = MethodMath.integratedMarkdown(notes, pages: pages)
        XCTAssertFalse(integrated.contains("[[formula:"))
        XCTAssertEqual(Store.formulas(in: integrated).count, 2)
        XCTAssertTrue(integrated.range(of: "H=\\frac{x}{y}")!.lowerBound < integrated.range(of: "## 投影合成")!.lowerBound)
        XCTAssertTrue(integrated.range(of: "## 投影合成")!.lowerBound < integrated.range(of: "I=I_0")!.lowerBound)
        XCTAssertThrowsError(try MethodMath.validateReferences(notes + "\n[[formula:p4-e1]]", pages: pages))
        XCTAssertThrowsError(try MethodMath.validateReferences(notes.replacingOccurrences(of: "p5-e1", with: "p99-e1"), pages: pages))
        XCTAssertThrowsError(try MethodMath.validateReferences("仅解释未插入公式", pages: pages))
        XCTAssertThrowsError(try MethodMath.validateReferences("## 公式汇总\n[[formula:p4-e1]]\n解释符号。\n[[formula:p5-e1]]", pages: pages))
        XCTAssertThrowsError(try MethodMath.validateReferences("## 编码模块\n[[formula:p4-e1]]\n\n[[formula:p5-e1]]", pages: pages))
        XCTAssertFalse(MethodMath.integratedMarkdown("[[formula:invented]]", pages: []).contains("[[formula:"))
    }

    @MainActor func testComplexMathViewCanLayout() {
        // Exercise SwiftUI itself, not just parsing. The previous recursive view type
        // overflowed the stack in _viewListCount as soon as a real formula was shown.
        for width: CGFloat in [280, 960] {
            let host = NSHostingView(rootView: MarkdownView(src: "令 $\\frac{x_i}{\\sqrt{2}}$ 为输入。\n\n$$\\mathcal{L}=\\sum_{r\\in B}\\lVert I_r-I_s\\rVert^2$$"))
            host.frame = CGRect(x: 0, y: 0, width: width, height: 320)
            host.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(host.fittingSize.height, 0)
        }
        // The clipping viewport must contain real intrinsic layout, including both
        // summation limits and nested fractions, rather than a fixed height guess.
        for formula in ["\\sum_{i=1}^{N}\\mu_i\\delta_i", "\\frac{\\frac{x}{y}}{\\sqrt{z}}", "x_i^2+y_j"] {
            let nodes = MathParser.parse(formula).nodes
            let row = NSHostingView(rootView: MathRow(nodes: nodes, size: 18, color: .ink).fixedSize())
            XCTAssertTrue(row.fittingSize.height <= MathMetrics.height(nodes, size: 18) + 1)
        }
    }

    func testFigureAnalysisValidationAndLayout() {
        let ocr = "Sinogram Prediction Geometry Correction Input Projection Loss"
        let analysis = FigureAnalysis(page: 3, title: "Fig. 2 Overview",
                                      nodes: [
                                        FigureNode(id: "n1", label: "Input Projection", kind: "input"),
                                        FigureNode(id: "n2", label: "Sinogram Prediction", kind: "module"),
                                        FigureNode(id: "n3", label: "不存在的模块", kind: "module"),
                                      ],
                                      edges: [FigureEdge(from: "n1", to: "n2"), FigureEdge(from: "n2", to: "n3"), FigureEdge(from: "n2", to: "n9")])
        let clean = analysis.validated(against: ocr)
        // 未在图中出现的标签必须被剔除（防编造）
        XCTAssertEqual(clean.nodes.count, 2)
        XCTAssertTrue(clean.dropped.contains("不存在的模块"))
        // 引用不存在节点的边必须被丢弃
        XCTAssertEqual(clean.edges.count, 1)
        XCTAssertTrue(clean.isUsable)
        // 全不匹配的输入不可用 → 调用方降级为原图
        let bogus = FigureAnalysis(page: 3, title: "t", nodes: [FigureNode(id: "a", label: "Xyzzy")], edges: []).validated(against: ocr)
        XCTAssertFalse(bogus.isUsable)

        // 重复与空 ID 要在布局前剔除，不能让 Dictionary(uniqueKeysWithValues:) 崩溃。
        let duplicateIDs = FigureAnalysis(page: 3, title: "t", nodes: [
            FigureNode(id: "same", label: "Input Projection"),
            FigureNode(id: "same", label: "Sinogram Prediction"),
            FigureNode(id: "", label: "Loss")
        ], edges: [FigureEdge(from: "same", to: "same")]).validated(against: ocr)
        XCTAssertEqual(duplicateIDs.nodes.map(\.label), ["Input Projection"])
        XCTAssertEqual(duplicateIDs.dropped.count, 2)
        XCTAssertTrue(FigureLayout.layout(nodes: duplicateIDs.nodes + duplicateIDs.nodes,
                                          edges: duplicateIDs.edges,
                                          canvas: CGSize(width: 300, height: 200), vertical: false).placed.count == 2)

        // 分层：模型给了 layer 时尊重它；缺失时按最长路径推导
        let layered = FigureAnalysis(page: 1, title: "t",
                                     nodes: [FigureNode(id: "a", label: "A"), FigureNode(id: "b", label: "B"), FigureNode(id: "c", label: "C")],
                                     edges: [FigureEdge(from: "a", to: "b"), FigureEdge(from: "b", to: "c")])
        let depth = FigureLayout.layers(nodes: layered.nodes, edges: layered.edges)
        XCTAssertEqual(depth["a"], 0); XCTAssertEqual(depth["b"], 1); XCTAssertEqual(depth["c"], 2)
        // 布局：画布内、不重叠出界
        let result = FigureLayout.layout(nodes: layered.nodes, edges: layered.edges, canvas: CGSize(width: 600, height: 300), vertical: false)
        XCTAssertEqual(result.placed.count, 3)
        XCTAssertEqual(result.layerCount, 3)
        for placed in result.placed {
            XCTAssertTrue(placed.rect.minX >= 0 && placed.rect.maxX <= 600.5, "节点超出画布：\(placed.label)")
            XCTAssertTrue(placed.rect.minY >= 0 && placed.rect.maxY <= 300.5, "节点超出画布：\(placed.label)")
            XCTAssertGreaterThan(placed.rect.width, 0)
        }
        XCTAssertEqual(result.arrows.count, 2)
        // 窄容器切换纵向布局
        let narrow = FigureLayout.layout(nodes: layered.nodes, edges: layered.edges, canvas: CGSize(width: 300, height: 400), vertical: true)
        XCTAssertTrue(narrow.placed[0].rect.minY < narrow.placed[2].rect.minY)
        // 非法画布返回空而不崩
        XCTAssertTrue(FigureLayout.layout(nodes: layered.nodes, edges: layered.edges, canvas: .zero, vertical: false).placed.isEmpty)
        // 图题定位
        let hits = FigureLocator.find(in: "\n\n=== Page 3 ===\nThe results are shown in Figure 1.\nFig. 2. Overview of the proposed network.\n")
        XCTAssertEqual(hits.first?.page, 3)
        XCTAssertTrue(hits.first?.caption.contains("Fig. 2") ?? false)
        XCTAssertEqual(FigureLocator.architecture(in: "=== Page 2 ===\nFigure 1. Dataset samples\n=== Page 3 ===\nFig. 2. Overview of the proposed network")?.page, 3)
    }

    @MainActor
    func testFormulaPageImageCompression() throws {
        // R-07：整页图压缩——超长边等比缩小 + JPEG 编码（负载从数 MB 降到数百 KB）
        let w = 3000, h = 2400
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw NSError(domain: "t", code: 1) }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        guard let cg = ctx.makeImage() else { throw NSError(domain: "t", code: 2) }
        guard let jpeg = Store.compressedJPEG(cg) else { throw NSError(domain: "t", code: 3) }
        XCTAssertTrue(jpeg.count > 0)
        XCTAssertTrue(jpeg.prefix(2).elementsEqual([0xFF, 0xD8] as [UInt8])) // JPEG 魔数
        // 解码后长边应不超过 1800
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int,
              let height = props[kCGImagePropertyPixelHeight] as? Int else { throw NSError(domain: "t", code: 4) }
        XCTAssertTrue(max(width, height) <= 1800)
        // 小图不缩放
        guard let ctx2 = CGContext(data: nil, width: 800, height: 600, bitsPerComponent: 8, bytesPerRow: 0,
                                   space: CGColorSpaceCreateDeviceRGB(),
                                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw NSError(domain: "t", code: 5) }
        ctx2.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx2.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
        guard let small = ctx2.makeImage(), let jpeg2 = Store.compressedJPEG(small) else { throw NSError(domain: "t", code: 6) }
        guard let source2 = CGImageSourceCreateWithData(jpeg2 as CFData, nil),
              let props2 = CGImageSourceCopyPropertiesAtIndex(source2, 0, nil) as? [CFString: Any],
              let width2 = props2[kCGImagePropertyPixelWidth] as? Int else { throw NSError(domain: "t", code: 7) }
        XCTAssertEqual(width2, 800)
    }
    @MainActor
    func testOCRMarkerAndEvidenceCompatibility() throws {
        // R-06：OCR 标注不破坏 === Page N === 证据格式；标注前的引导文本不计入任何页
        let ocr = Store.markAsOCR("\n\n=== Page 1 ===\nRecognized text\n\n=== Page 2 ===\nMore text")
        XCTAssertTrue(Store.isOCRSource(ocr))
        XCTAssertFalse(Store.isOCRSource("plain text layer"))
        XCTAssertFalse(Store.isOCRSource(nil))
        let pages = Evidence.pages(ocr)
        XCTAssertEqual(pages.count, 2)
        XCTAssertEqual(pages[0].number, 1)
        XCTAssertEqual(pages[0].text.trimmingCharacters(in: .whitespacesAndNewlines), "Recognized text")
        // 普通文本层缓存不会被误判为 OCR
        XCTAssertFalse(Store.isOCRSource(Store.markAsOCR("").replacingOccurrences(of: Store.ocrMarker, with: "")))
    }
    @MainActor
    func testRepoDependencyChecks() throws {
        // R-11：规则扫描代码快照 → 依赖声明 / 数据 / 权重核对项；纯函数不访问网络
        func file(_ path: String, _ text: String) -> CodeFile {
            CodeFile(path: path, sha: "x", category: "config", text: text, truncated: false)
        }
        let snapshot = CodeSnapshot(
            paperKey: "2209.14540",
            repository: try RepositoryID.parse("https://github.com/meer-cw/NAF"),
            commit: String(repeating: "a", count: 40),
            scannedAt: "2026-10-03 00:00:00",
            paths: ["requirements.txt", "download_data.sh", "train.py"],
            files: [
                file("requirements.txt", "torch>=1.12\nnumpy\n"),
                file("download_data.sh", "gdown https://drive.google.com/uc?id=abc\ncurl -O https://example.org/checkpoints/naf.pth\n"),
                file("train.py", "print('hello')\n"),
            ],
            warnings: [])
        try snapshot.validateSnapshot()
        let checks = RepoAudit.checks(from: snapshot)
        XCTAssertTrue(checks.contains { $0.kind == "依赖" && $0.path == "requirements.txt" })
        XCTAssertTrue(checks.contains { $0.kind == "数据" && $0.path == "download_data.sh" })
        XCTAssertTrue(checks.contains { $0.kind == "权重" && $0.line == 2 })
        XCTAssertEqual(checks.count, Set(checks.map(\.id)).count)
        // 确定性：同快照两次扫描结果一致（清单键稳定）
        XCTAssertEqual(checks.map(\.id), RepoAudit.checks(from: snapshot).map(\.id))
        // 上限：清单只做核对提示，不做穷举
        let noisy = (0..<40).map { file("scripts/d\($0).sh", "gdown https://drive.google.com/uc?id=\($0)\n") }
        let big = CodeSnapshot(paperKey: snapshot.paperKey, repository: snapshot.repository, commit: snapshot.commit,
                               scannedAt: snapshot.scannedAt, paths: noisy.map(\.path), files: noisy, warnings: [])
        XCTAssertTrue(RepoAudit.checks(from: big).count <= 12)
        // 持久化：任务写入 checklist.repoChecks 并能回读
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let check = checks[0]
        XCTAssertTrue(store.saveRepoCheckTask(key: "2209.14540", check: check, task: ReproductionTask(status: .verified, note: "已手动安装并核对版本")))
        XCTAssertEqual(store.repoCheckTask(key: "2209.14540", checkID: check.id).status, .verified)
        // 已核对必须有记录；空 note 拒绝
        XCTAssertFalse(store.saveRepoCheckTask(key: "2209.14540", check: check, task: ReproductionTask(status: .verified, note: " ")))
    }
    @MainActor
    func testThrottledPersistFlushesBeforeReload() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.mutateLibrary("2209.14540") { $0.notes = "first" }   // 距上次写入 >2s：立即落盘
        store.mutateLibrary("2209.14540") { $0.notes = "second" }  // 2s 窗口内：去抖合并
        store.flushPendingPersists()                              // goHome/退出前的强制冲刷
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.state("2209.14540").notes, "second")
    }
    func testDeduplicateScalesAndPreservesSemantics() {
        // 大输入下索引化去重的正确性：同 key 合并、手工元数据保留
        let many = (0..<300).map { QueueEntry(arxiv: "2501.\(String(format: "%05d", $0))", title: "Paper number \($0)") }
        XCTAssertEqual(PaperIdentity.deduplicate(many + many).count, 300)
        var manual = QueueEntry(id: "manual-1", title: "A", doi: "10.1000/ABC")
        manual.abstract = "手工摘要"
        let doiTwin = QueueEntry(arxiv: "2502.00001", title: "B", doi: "https://doi.org/10.1000/abc")
        let merged = PaperIdentity.deduplicate([manual, doiTwin])
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].abstract, "手工摘要")
        // 既有语义：手工条目已有 id 时不回填 arXiv（仅 nil id 的条目才补），勿擅自改宽
        XCTAssertNil(merged[0].arxiv)
    }
    @MainActor
    func testRegenerationArchivesPreviousOutput() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        var reading = ReadingFile(key: "test", tldr: "old")
        store.saveReadings(reading); reading.tldr = "new"; store.saveReadings(reading)
        XCTAssertEqual(store.loadReadings("test")?.tldr, "new")
        let files = try FileManager.default.contentsOfDirectory(atPath: store.dataDir.appendingPathComponent("readings/history").path)
        XCTAssertEqual(files.count, 1)
        let old = try JSONDecoder().decode(ReadingFile.self, from: Data(contentsOf: store.dataDir.appendingPathComponent("readings/history/" + files[0])))
        XCTAssertEqual(old.tldr, "old")
    }
    /// 测试工作区 = 本文件向上四级（ResearchTests.swift → Tests/CBCTReadingTests → Tests → native → cbct-reading）。
    /// 不用 Store.findRoot()：它在 swift test 运行器下解析到的是 .build 内部路径。
    func testWorkspace() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testArxivKeysStripInternalWhitespace() {
        // 内部空白会让 URL(string:) 返回 nil，曾在启动路径 id_list 查询处强解包崩溃（M-1）
        XCTAssertEqual(PaperIdentity.arxiv("2401.12345 (v2)"), "2401.12345(v2)")
        // 尾部带空格的版本号仍能被版本正则剥掉：先去 v2 再清空白
        XCTAssertEqual(PaperIdentity.arxiv("2401.12345 v2"), "2401.12345")
        XCTAssertEqual(PaperIdentity.arxiv(" https://arxiv.org/abs/2401.12345 \n"), "2401.12345")
        // 既有语义不回退：前缀剥离、版本剥离、普通编号原样
        XCTAssertEqual(PaperIdentity.arxiv("https://arxiv.org/pdf/2209.14540v3.pdf"), "2209.14540")
        XCTAssertEqual(PaperIdentity.arxiv("2209.14540"), "2209.14540")
    }

    func testForbiddenPhrasesHaveNoDuplicates() {
        // 红线词表曾含重复项「前所未有的」，导致同一短语被重复扫描（L-1）；表必须保持无重复
        XCTAssertEqual(TrendAnalysis.forbiddenPhrases.count, Set(TrendAnalysis.forbiddenPhrases).count)
        XCTAssertTrue(TrendAnalysis.forbiddenPhrases.contains("首次"))
    }

    func testJSONExtractStripsFencesAndProse() {
        // 部分论文结果分析曾因模型在 JSON 前后加说明文字/围栏而整体解码失败
        XCTAssertEqual(JSONExtract.object(from: "```json\n{\"a\":1}\n```"), "{\"a\":1}")
        XCTAssertEqual(JSONExtract.object(from: "说明如下：\n{\"a\": {\"b\": 2}}\n以上为结果"), "{\"a\": {\"b\": 2}}")
        XCTAssertEqual(JSONExtract.object(from: "{\"a\":1}"), "{\"a\":1}")
        XCTAssertEqual(JSONExtract.object(from: "没有大括号"), "没有大括号")
    }

    func testPDFSelectionContextExtractsNearbyText() {
        // 「这里没懂」移到 PDF 面板后，上下文从 page.string 提取（H-1 恢复）
        let page = String(repeating: "引言背景。", count: 100) + "稀疏视角下的角度采样是核心问题。" + String(repeating: "后续内容。", count: 100)
        let sel = "稀疏视角下的角度采样是核心问题。"
        let ctx = PDFSelectionContext.nearby(sel, in: page)
        XCTAssertTrue(ctx.contains(sel))
        XCTAssertTrue(ctx.count <= sel.count + 800 + 20)
        // 选区因换行/连字符记法差异匹配不上页面文本时，回退为选区本身
        XCTAssertEqual(PDFSelectionContext.nearby("页面里没有的句子", in: page), "页面里没有的句子")
        XCTAssertEqual(PDFSelectionContext.nearby("", in: page), "")
        // 前缀逐级缩短匹配：选区尾部换行不一致时仍能定位
        let partial = PDFSelectionContext.nearby(sel + "\n后续", in: page)
        XCTAssertTrue(partial.contains(sel))
    }

    @MainActor
    func testActualQueueAndPDFExtraction() async throws {
        let workspace = testWorkspace()
        // 结构性断言：队列可解码且每条都有 key 与标题。不断言具体篇数——
        // 真实 queue.json 随使用增删，断言篇数会让测试随用户操作随机变红（曾为线上 bug，勿改回）。
        let papers = try PaperIdentity.decodeQueue(Data(contentsOf: workspace.appendingPathComponent("queue.json")))
        XCTAssertFalse(papers.isEmpty)
        for p in papers { XCTAssertFalse(p.key.isEmpty); XCTAssertFalse((p.title ?? "").isEmpty) }
        let url = workspace.appendingPathComponent("library/2022-NAF-2209.14540.pdf")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("NAF PDF 不在本机，跳过真实 PDF 抽取检查") }
        let pdf = try XCTUnwrap(PDFDocument(url: url))
        XCTAssertGreaterThan(pdf.pageCount, 1)
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("library"), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: url, to: root.appendingPathComponent("library/2209.14540.pdf"))
        let store = Store(root: root, startTimers: false)
        let source = try await store.ensurePDFText(for: store.reference(store.queue[0]))
        XCTAssertEqual(Evidence.pages(source).count, pdf.pageCount)
        XCTAssertTrue(source.contains("attenuation") || source.contains("Attenuation"))
    }
    @MainActor
    func testNoPDFStopsGenerationWithoutAPI() async throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let ref = PaperRef(key: "missing", arxiv: "", noteId: nil, hasNote: false, title: "Missing paper", venue: "", why: "")
        let session = SessionState(ref: ref, step: 1)
        store.openReading(session, kind: "tldr")
        for _ in 0..<30 where session.readingBusy(for: "tldr") { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertFalse(session.readingBusy(for: "tldr"))
        XCTAssertTrue(session.readingError(for: "tldr")?.contains("原文证据不可用") == true)
        XCTAssertNil(store.loadReadings("missing"))
    }
    @MainActor
    func testParallelReadingKindsDoNotBlockEachOther() throws {
        // 旧的全局 readingBusy 一票否决：results 解析中其他种类的解析请求被静默丢弃（用户报告的 bug）。
        // 现在按种类独立加锁：tldr 解析中，critical 仍能立即开始，且互不覆盖状态。
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let session = SessionState(ref: store.reference(store.queue[0]), step: 1)
        store.openReading(session, kind: "tldr")
        XCTAssertTrue(session.readingBusy(for: "tldr"))
        store.openReading(session, kind: "critical")
        XCTAssertTrue(session.readingBusy(for: "critical"))
        XCTAssertEqual(session.readingKind, "critical")
        // 同一种类防重入：critical 解析中重复点击不再重置其状态
        store.openReading(session, kind: "critical")
        XCTAssertTrue(session.readingBusy(for: "critical"))
    }
    @MainActor
    func testMalformedFrontmatterDoesNotCrash() {
        XCTAssertEqual(Store.parseFrontmatter("---\ntitle: incomplete").0["title"]?.str, "incomplete")
    }
    @MainActor
    func testPhysicalTableRowsAndNumericQuoteValidation() throws {
        let file = testWorkspace().appendingPathComponent("library/2022-NAF-2209.14540.pdf")
        let page = try XCTUnwrap(PDFDocument(url: file)?.page(at: 6))
        let text = PDFLayout.text(page)
        XCTAssertTrue(text.contains("NAF (Ours) 33.05/.96 34.14/.94 31.63/.94 34.45/.95 30.34/.88"))
        XCTAssertTrue(text.contains("FDK [7] 22.89/.78 28.59/.78 23.92/.58 22.39/.59 12.11/.21"))
        let quote = "NAF (Ours) 33.05/.96 34.14/.94 31.63/.94 34.45/.95 30.34/.88"
        XCTAssertTrue(PDFLayout.selection(quote, page: page)?.string?.contains("NAF") == true)
        let value = ExperimentField(k: "NAF abdomen PSNR", v: "34.45 dB", page: 7, excerpt: quote)
        var parsed = ExperimentExtraction(dataset: [], acquisition: [], training: [], loss: [], metrics: [], results: [value])
        XCTAssertNoThrow(try parsed.validate(source: "=== Page 7 ===\n" + text))
        parsed.results[0].v = "NAF 12.11 dB"
        XCTAssertThrowsError(try parsed.validate(source: "=== Page 7 ===\n" + text))
        parsed.results[0] = ExperimentField(k: "GPU", v: "论文中未说明", page: nil, excerpt: nil)
        XCTAssertNoThrow(try parsed.validate(source: "=== Page 7 ===\n" + text))
        XCTAssertEqual(Evidence.normalized("attenuation coeﬃ-\ncients"), Evidence.normalized("attenuation coefficients"))
        XCTAssertTrue(Evidence.quoteRange("attenuation coefficients", in: "attenuation coeﬃ-\ncients") != nil)
        XCTAssertEqual(Evidence.normalized("hyper-parameter"), Evidence.normalized("hyper-\nparameter"))
        XCTAssertTrue(Evidence.quoteRange("frequency-encoding methods", in: "frequency-\nencoding methods") != nil)
        XCTAssertEqual(Evidence.numbers("34.45/.95 30.34/.88"), ["34.45", ".95", "30.34", ".88"])
        XCTAssertEqual(Evidence.numbers("five datasets, single RTX 3090"), ["5", "1", "3090"])
        XCTAssertFalse(Evidence.numbers("1×10^3").isSubset(of: Evidence.numbers("1×10−3")))
    }
    func testIdeaEvidenceAndNormalizedHighlightRange() throws {
        let source = "=== Page 4 ===\n患者 📐 We train\nusing 50 views with detector pixels."
        let evidence = IdeaEvidence(paperKey: "a", paperTitle: "Paper", origin: .paper, page: 4, excerpt: "We train using 50 views")
        XCTAssertNoThrow(try evidence.validate(source: source))
        var fabricated = evidence; fabricated.excerpt = "We train using 100 views"
        XCTAssertThrowsError(try fabricated.validate(source: source))
        fabricated = evidence; fabricated.page = 2
        XCTAssertThrowsError(try fabricated.validate(source: source))
        fabricated.origin = .interpretation
        XCTAssertNoThrow(try fabricated.validate(source: source))
        let page = Evidence.pages(source)[0].text
        let range = try XCTUnwrap(Evidence.quoteRange(evidence.excerpt, in: page))
        XCTAssertEqual(Evidence.normalized((page as NSString).substring(with: range)), Evidence.normalized(evidence.excerpt))
        XCTAssertNil(Evidence.quoteRange("wrong quote", in: page))
    }
    @MainActor
    func testIdeaLifecyclePersistenceAndCorruptFileProtection() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        var idea = ResearchIdea(); idea.question = "Can sparse views transfer?"; idea.hypothesis = "Test hypothesis"; idea.experiment = "Compare equal views"; idea.status = .planned
        let source = "=== Page 4 ===\nWe train using 50 views."
        try FileManager.default.createDirectory(at: store.pdfTextURL("2209.14540").deletingLastPathComponent(), withIntermediateDirectories: true)
        try source.write(to: store.pdfTextURL("2209.14540"), atomically: true, encoding: .utf8)
        idea.evidence = [IdeaEvidence(paperKey: "2209.14540", paperTitle: "NAF", origin: .paper, page: 4, excerpt: "We train using 50 views")]
        XCTAssertTrue(store.saveIdea(idea))
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.ideas.first?.status, .planned)
        XCTAssertEqual(fresh.ideas.first?.evidence.first?.page, 4)
        idea.status = .adopted; XCTAssertTrue(fresh.saveIdea(idea)); XCTAssertEqual(fresh.ideas.count, 1)
        var fake = idea; fake.evidence[0].excerpt = "We train using 100 views"
        XCTAssertFalse(fresh.saveIdea(fake))
        XCTAssertEqual(fresh.ideas.first?.evidence[0].excerpt, "We train using 50 views")
        let markdown = Store.ideasMarkdown(fresh.ideas)
        XCTAssertTrue(markdown.contains("[论文原文]")); XCTAssertTrue(markdown.contains("PDF Page 4")); XCTAssertTrue(markdown.contains("Hypothesis · 待验证"))
        XCTAssertTrue(fresh.deleteIdea(idea.id)); XCTAssertTrue(Store(root: root, startTimers: false).ideas.isEmpty)
        try "bad json".write(to: store.ideasURL, atomically: true, encoding: .utf8)
        let corrupt = Store(root: root, startTimers: false)
        XCTAssertTrue(corrupt.ideasLoadFailed); XCTAssertFalse(corrupt.saveIdea(idea))
        XCTAssertEqual(try String(contentsOf: store.ideasURL), "bad json")
    }
    @MainActor
    func testIdeasAcceptEnvelopeAndArrayFormats() throws {
        // 外部迁移脚本曾把 ideas.json 写成 {"ideas":[...]} 信封格式；只认裸数组会让 Ideas 整体进入停写保护
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        var idea = ResearchIdea(); idea.question = "Q1"; idea.status = .planned
        let arrayJSON = String(data: try JSONEncoder().encode([idea]), encoding: .utf8)!
        try ("{\"ideas\":" + arrayJSON + "}").write(to: store.ideasURL, atomically: true, encoding: .utf8)
        store.loadIdeas()
        XCTAssertFalse(store.ideasLoadFailed)
        XCTAssertEqual(store.ideas.first?.question, "Q1")
        XCTAssertEqual(store.ideas.first?.status, .planned)
        // 裸数组继续兼容
        try arrayJSON.write(to: store.ideasURL, atomically: true, encoding: .utf8)
        store.loadIdeas()
        XCTAssertFalse(store.ideasLoadFailed)
        XCTAssertEqual(store.ideas.first?.question, "Q1")
        // 两种格式都不匹配才进入停写保护
        try "bad json".write(to: store.ideasURL, atomically: true, encoding: .utf8)
        store.loadIdeas()
        XCTAssertTrue(store.ideasLoadFailed)
    }
    func testApplicationAdviceRequiresGroundingAndExperiment() throws {
        let source = "=== Page 2 ===\nWe use an implicit neural representation for CT reconstruction."
        let fact = ExperimentField(k: "method", v: "implicit representation", page: 2, excerpt: "We use an implicit neural representation")
        var item = ApplicationAdvice(title: "Try implicit fields", suggestion: "Research suggestion", constraint: "Test sparse CBCT geometry", verification: "Equal-view evaluation", evidence: [fact])
        var application = ResearchApplication(reusable: [], adaptation: [item], conflicts: [], validation: [])
        XCTAssertNoThrow(try application.validate(source: source))
        item.evidence[0].excerpt = "Invented evidence excerpt"; application.adaptation = [item]
        XCTAssertThrowsError(try application.validate(source: source))
        item.evidence = [ExperimentField(k: "GPU", v: "论文未说明", page: nil, excerpt: nil)]; application.adaptation = [item]
        XCTAssertThrowsError(try application.validate(source: source))
        item.evidence = [fact]; item.verification = ""; application.adaptation = [item]
        XCTAssertThrowsError(try application.validate(source: source))
        let raw = try JSONEncoder().encode(ResearchApplication(reusable: [], adaptation: [ApplicationAdvice(title: "Try", suggestion: "Suggestion", constraint: "views", verification: "Experiment", evidence: [fact])], conflicts: [], validation: []))
        XCTAssertEqual(try ResearchApplication.decode(String(decoding: raw, as: UTF8.self)).adaptation.count, 1)
    }
    func testLegacyExperimentAndNewBaselines() throws {
        let raw = #"{"dataset":[],"acquisition":[],"training":[],"loss":[],"metrics":[],"results":[]}"#
        var parsed = try ExperimentExtraction.decode(raw)
        XCTAssertNil(parsed.baselines)
        parsed.baselines = [ExperimentField(k: "FDK", v: "经典重建基线", page: 1, excerpt: "Comparison with FDK and SART")]
        XCTAssertNoThrow(try parsed.validate(source: "=== Page 1 ===\nComparison with FDK and SART"))
        let reread = try ExperimentExtraction.decode(String(decoding: JSONEncoder().encode(parsed), as: UTF8.self))
        XCTAssertEqual(reread.baselines?.first?.k, "FDK")
    }
    func testMethodsTaskAndExplorationRanking() {
        var profile = ResearchProfile(); profile.topics = [:]; profile.datasets = ""; profile.methods = "Transformer"; profile.task = "投影补全"
        let match = PaperIdentity.rank(QueueEntry(id: "a", title: "Transformer projection completion"), profile: profile, state: LibraryState())
        let unrelated = PaperIdentity.rank(QueueEntry(id: "b", title: "Dental dose study"), profile: profile, state: LibraryState())
        XCTAssertTrue(match.matchesProfile); XCTAssertFalse(unrelated.matchesProfile)
        XCTAssertGreaterThan(match.score, unrelated.score)
    }
    // 小数与编号章节不得被当成有序列表：只判「首字符是数字 + 点号靠前」会把
    // "0.5 mm" 解析成列表项 "5 mm"，把论文原文数字静默改写。第②步左栏直接渲染全文。
    func testMarkdownDoesNotMisparseDecimalsAsOrderedList() {
        func kind(_ s: String) -> String {
            for b in Markdown.parse(s) {
                switch b {
                case .paragraph(let l): return "paragraph:" + l.joined(separator: " ")
                case .ordered(let i): return "ordered:" + i.joined(separator: "|")
                case .bullets(let i): return "bullets:" + i.joined(separator: "|")
                case .heading(let t, _): return "heading:" + t
                case .quote(let q): return "quote:" + q.joined(separator: " ")
                case .table(let t): return "table:\(t.columnCount)x\(t.rows.count)"
                case .rule: return "rule"
                case .mathBlock(let latex): return "math:" + latex
                }
            }
            return "none"
        }
        // 小数必须原样保留为段落
        XCTAssertEqual(kind("0.5 mm detector pixel"), "paragraph:0.5 mm detector pixel")
        XCTAssertEqual(kind("12.5 dB improvement"), "paragraph:12.5 dB improvement")
        XCTAssertEqual(kind("3.5 views per second"), "paragraph:3.5 views per second")
        // 编号章节标题不得被吃掉首位数字
        XCTAssertEqual(kind("2.1 Datasets and metrics"), "paragraph:2.1 Datasets and metrics")
        XCTAssertEqual(kind("3.1 Data"), "paragraph:3.1 Data")
        XCTAssertEqual(kind("2024. a year"), "paragraph:2024. a year")
        // 真正的有序列表仍须正确解析
        XCTAssertEqual(kind("1. correct item"), "ordered:correct item")
        XCTAssertEqual(kind("2. also correct"), "ordered:also correct")
    }
    // 切换论文时必须先落盘旧会话的第④步草稿，否则从 Idea 弹层跳转会静默丢失。
    @MainActor
    func testSessionSwapFlushesDraftsBeforeReplacingSession() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let a = store.reference(store.queue[0])
        store.openReader(a)
        guard let first = store.session else { throw TestFailure(message: "session missing") }
        first.drafts["q1"] = "论文A的管线反思"
        first.freeNoteDraft = "论文A的自由批注"
        // 切到另一篇：openReader 必须先 flush 旧会话
        let b = PaperRef(key: "other-paper", arxiv: "", noteId: nil, hasNote: false, title: "Other", venue: "", why: "")
        store.openReader(b)
        XCTAssertEqual(store.progress[a.key]?.reflections?["q1"], "论文A的管线反思")
        XCTAssertEqual(store.progress[a.key]?.freeNote, "论文A的自由批注")
        // flushActiveSession 本身也必须幂等可用
        store.session?.drafts["q2"] = "论文B的存疑"
        store.flushActiveSession()
        XCTAssertEqual(store.progress["other-paper"]?.reflections?["q2"], "论文B的存疑")
    }
    @MainActor
    func testAnnotationAppendDoesNotDuplicateSectionAndKeepsHistory() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let original = """
        ---
        id: 2022-naf
        arxiv: "2209.14540"
        title: "NAF"
        ---

        ## 4. 研究启发
        - 已有结论

        ## 5. 我的批注
        - 旧批注甲
        - 旧批注乙
        """
        try FileManager.default.createDirectory(at: root.appendingPathComponent("papers"), withIntermediateDirectories: true)
        try original.write(to: root.appendingPathComponent("papers/2022-naf.md"), atomically: true, encoding: .utf8)
        let store = Store(root: root, startTimers: false)
        XCTAssertEqual(try XCTUnwrap(store.appendAnnotation(arxiv: "2209.14540", noteId: nil, text: "新批注")), "2022-naf")
        let content = try String(contentsOf: root.appendingPathComponent("papers/2022-naf.md"), encoding: .utf8)
        XCTAssertEqual(content.components(separatedBy: "## 5. 我的批注").count - 1, 1, "不得产生重复小节")
        XCTAssertTrue(content.contains("- 旧批注甲"), "原有批注必须保留")
        XCTAssertTrue(content.contains("新批注"))
        let heading = try XCTUnwrap(content.range(of: "## 5. 我的批注"))
        let fresh = try XCTUnwrap(content.range(of: "新批注"))
        let old = try XCTUnwrap(content.range(of: "旧批注甲"))
        XCTAssertTrue(fresh.lowerBound > heading.upperBound && fresh.lowerBound < old.lowerBound, "新批注应插在标题行之后、旧批注之前")
        let sections = Store.splitSections(content)
        XCTAssertTrue(sections["annotations"]?.contains("旧批注甲") ?? false, "应用视图不得丢失原有批注")
        XCTAssertTrue(sections["annotations"]?.contains("新批注") ?? false)
        _ = store.appendAnnotation(arxiv: "2209.14540", noteId: nil, text: "第二批")
        let again = try String(contentsOf: root.appendingPathComponent("papers/2022-naf.md"), encoding: .utf8)
        XCTAssertEqual(again.components(separatedBy: "## 5. 我的批注").count - 1, 1, "二次追加仍不得产生重复小节")
    }

    func testEvidenceSubsetDisclosesMaterialScope() throws {
        var full = ""
        for i in 1...30 {
            full += "\n\n=== Page \(i) ===\n" + String(repeating: "method architecture experiment \(i) dataset results ", count: 240)
        }
        XCTAssertGreaterThan(full.count, 50000)
        let meta = Evidence.selectWithMeta(full, query: "method")
        XCTAssertLessThan(meta.included, meta.total)
        let scoped = Evidence.scopingNote(meta)
        XCTAssertTrue(scoped.contains("材料范围"))
        XCTAssertTrue(scoped.contains("\(meta.included)/\(meta.total)"))
        XCTAssertEqual(Evidence.pages(scoped).count, meta.included, "披露行不得影响页码解析")
        // 未超限的全文不披露
        let small = Evidence.selectWithMeta("=== Page 1 ===\nmethod text", query: "method")
        XCTAssertEqual(small.included, small.total)
        XCTAssertFalse(Evidence.scopingNote(small).contains("材料范围"))
    }

    @MainActor
    func testManualQueueEntryLinksSkillNamedNote() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        // 技能笔记命名（YYYY-短名）与手工队列 id（短名-YYYY）顺序相反，需按规范化标题关联
        let note = """
        ---
        id: 2021-intratomo
        title: "IntraTomo: Self-supervised Learning-based Tomography via Sinogram Synthesis and Prediction"
        ---

        ## 一句话总结
        测试笔记
        """
        try FileManager.default.createDirectory(at: root.appendingPathComponent("papers"), withIntermediateDirectories: true)
        try note.write(to: root.appendingPathComponent("papers/2021-intratomo.md"), atomically: true, encoding: .utf8)
        try Data(#"{"papers":[{"id":"intratomo-2021","title":"IntraTomo: Self-supervised Learning-based Tomography via Sinogram Synthesis and Prediction","authors":["Guangming Zang"]}]}"#.utf8)
            .write(to: root.appendingPathComponent("queue.json"))
        let store = Store(root: root, startTimers: false)
        XCTAssertEqual(store.queue.first?.key, "intratomo-2021")
        XCTAssertEqual(store.notes.first?.key, "2021-intratomo")
        let linked = store.noteForQueue(try XCTUnwrap(store.queue.first))
        XCTAssertEqual(linked?.id, "2021-intratomo", "手工条目应能按规范化标题关联技能命名的笔记")
        let first = try XCTUnwrap(store.queue.first)
        XCTAssertTrue(store.reference(first).noteId != nil)
    }

    @MainActor
    func testUnreadableNotesAreReportedAndArxivKeysNormalize() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("papers"), withIntermediateDirectories: true)
        let good = """
        ---
        id: 2022-naf
        arxiv: "2209.14540v2"
        title: "NAF"
        ---

        ## 一句话总结
        ok
        """
        try good.write(to: root.appendingPathComponent("papers/2022-naf.md"), atomically: true, encoding: .utf8)
        try "".write(to: root.appendingPathComponent("papers/empty.md"), atomically: true, encoding: .utf8)
        try Data([0x80]).write(to: root.appendingPathComponent("papers/binary.md"))
        let store = Store(root: root, startTimers: false)
        XCTAssertEqual(store.notes.count, 1, "空文件与无法解码的文件不得进入论文库")
        XCTAssertEqual(store.notes.first?.key, "2209.14540", "arxiv 版本号应归一化，避免与队列/发现条目的进度键分裂")
        XCTAssertTrue(store.dataError?.contains("empty.md") ?? false, "跳过的文件必须上报，不得静默")
        XCTAssertTrue(store.dataError?.contains("binary.md") ?? false)
    }

    @MainActor
    func testCorruptStateFilesAreNeverOverwritten() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let data = root.appendingPathComponent("app/data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let broken = Data("{broken state".utf8)
        for name in ["progress.json", "library.json", "profile.json", "compare.json"] {
            try broken.write(to: data.appendingPathComponent(name))
        }
        let store = Store(root: root, startTimers: false)
        store.saveProgress(key: "manual") { $0.freeNote = "new note" }
        store.mutateLibrary("manual") { $0.notes = "new library note" }
        store.saveProfile(ResearchProfile())
        store.selectedComparison = ["manual"]
        store.flushPendingPersists()
        for name in ["progress.json", "library.json", "profile.json", "compare.json"] {
            XCTAssertEqual(try Data(contentsOf: data.appendingPathComponent(name)), broken, name + " must remain recoverable")
        }
        XCTAssertTrue(store.dataError != nil)
        let brokenQueue = Data("not a queue".utf8)
        try brokenQueue.write(to: store.queueURL)
        store.reloadAll()
        store.addToQueue(QueueEntry(id: "new-paper", title: "must not overwrite broken queue"))
        XCTAssertEqual(try Data(contentsOf: store.queueURL), brokenQueue)
        // 修复后重新加载即可恢复保存，无需删除整个数据目录。
        try Data("{}".utf8).write(to: store.progressURL)
        try Data("{}".utf8).write(to: store.libraryStateURL)
        try JSONEncoder().encode(ResearchProfile()).write(to: store.profileURL)
        try JSONEncoder().encode(CompareSession()).write(to: store.compareURL)
        store.reloadAll()
        store.saveProgress(key: "manual") { $0.freeNote = "recovered" }
        store.flushPendingPersists()
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.progress["manual"]?.freeNote, "recovered")
    }
    @MainActor
    func testCompareLoadIsReadOnly() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let original = Data(#"{"selected":["manual","2209.14540"],"pinned":"manual"}"#.utf8)
        try original.write(to: store.compareURL)
        store.loadResearchData()
        XCTAssertEqual(store.comparePinned, "manual")
        XCTAssertEqual(try Data(contentsOf: store.compareURL), original)
    }
    @MainActor
    func testPurgeSupersedesPendingLibraryWrites() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.mutateLibrary("manual") { $0.notes = "first" }
        store.mutateLibrary("manual") { $0.notes = "pending edit" }
        store.purgePaper("manual")
        store.flushPendingPersists()
        let fresh = Store(root: root, startTimers: false)
        XCTAssertNil(fresh.libraryState["manual"], "A delayed edit must not resurrect a purged record")
    }
    @MainActor
    func testReloadPreservesPendingEdits() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.mutateLibrary("manual") { $0.notes = "first" }
        store.mutateLibrary("manual") { $0.notes = "latest" }
        store.reloadAll()
        XCTAssertEqual(store.state("manual").notes, "latest")
    }
    @MainActor
    func testReopeningCurrentPaperKeepsSessionDrafts() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        let ref = store.reference(store.queue[1])
        store.openReader(ref)
        let original = try XCTUnwrap(store.session)
        original.drafts["q1"] = "unsaved reflection"
        original.freeNoteDraft = "unsaved note"
        store.openReader(ref)
        XCTAssertTrue(store.session === original)
        XCTAssertEqual(store.session?.drafts["q1"], "unsaved reflection")
        XCTAssertEqual(store.session?.freeNoteDraft, "unsaved note")
    }
    @MainActor
    func testWriteFailureKeepsSessionAndDraftsForRetry() throws {
        let root = try temporaryRoot(); defer { try? FileManager.default.removeItem(at: root) }
        let store = Store(root: root, startTimers: false)
        store.openReader(store.reference(store.queue[1]))
        let original = try XCTUnwrap(store.session)
        original.freeNoteDraft = "must survive a write failure"
        // 目录占据 JSON 路径，稳定模拟写失败，不依赖执行用户的权限。
        try FileManager.default.createDirectory(at: store.progressURL, withIntermediateDirectories: true)
        store.goHome()
        XCTAssertTrue(store.session === original, "Failed save must keep the editor open")
        store.openReader(store.reference(store.queue[0]))
        XCTAssertTrue(store.session === original, "Failed save must prevent replacing the session")
        store.finishReading(original)
        XCTAssertTrue(store.session === original)
        XCTAssertNil(store.toast, "Must not announce completion when persistence failed")
        try FileManager.default.removeItem(at: store.progressURL)
        store.goHome()
        XCTAssertNil(store.session)
        let fresh = Store(root: root, startTimers: false)
        XCTAssertEqual(fresh.progress[original.ref.key]?.freeNote, original.freeNoteDraft)
        XCTAssertNil(fresh.progress[original.ref.key]?.doneAt, "Failed completion must not mark the paper done")
    }
    func temporaryRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("cbct-tests-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        try Data(#"{"papers":[{"arxiv":"2209.14540","title":"Sparse-view implicit CBCT reconstruction"},{"id":"manual","title":"CT reconstruction"}]}"#.utf8).write(to: url.appendingPathComponent("queue.json"))
        return url
    }
}

final class LiveDiscoveryTests {
    func testOfficialAPIs() async throws {
        guard ProcessInfo.processInfo.environment["CBCT_LIVE_TESTS"] == "1" else { throw XCTSkip("Set CBCT_LIVE_TESTS=1 for official API smoke test") }
        let venues = try await DiscoveryService.semanticScholar()
        XCTAssertFalse(venues.isEmpty)
        XCTAssertTrue(venues.allSatisfy { !$0.key.isEmpty && !($0.title ?? "").isEmpty })
        XCTAssertTrue(venues.allSatisfy { $0.arxiv == nil }, "来源清单不再使用 arXiv")
        XCTAssertTrue(venues.allSatisfy { DiscoveryService.preferredVenue($0.venue ?? "") != nil })
        let pubmed = try await DiscoveryService.pubmed()
        XCTAssertFalse(pubmed.isEmpty)
        XCTAssertTrue(pubmed.allSatisfy { $0.source == "PubMed" })
    }
}

struct RegressionRunner {
    @MainActor static func run() async -> Bool {
        let tests = ResearchTests()
        let cases: [(String, () async throws -> Void)] = [
            ("Queue envelope / array", { try tests.testExistingQueueEnvelopeAndLegacyArray() }),
            ("DOI deduplication", { tests.testDOIDedupAcrossSourcesPreservesManualMetadata() }),
            ("Title / author deduplication", { tests.testTitleAuthorDedupAvoidsUnrelatedAuthors() }),
            ("Profile / feedback ranking", { tests.testProfileAndNegativeFeedbackChangeRanking() }),
            ("Semantic Scholar venues / fields", { try tests.testSemanticScholarParsesVenuesAndFields() }),
            ("Crossref fallback allowlist / metadata", { try tests.testCrossrefFallbackOnlyKeepsAllowlistedVenues() }),
            ("PubMed XML", { try tests.testPubmedStructuredAbstractAndMissingFullText() }),
            ("Evidence retrieval / validation", { try tests.testEvidenceRetrievalPreservesPageNumbersAndIncludesLatePages() }),
            ("Clickable evidence links", { tests.testEvidenceLinksAndCitations() }),
            ("Scope-limited evidence", { tests.testScopeDoesNotSilentlyIncludeOtherSections() }),
            ("Lightweight file timestamp", { try tests.testConfigurationTimestampDoesNotReadExtendedAttributes() }),
            ("Experiment evidence validation", { try tests.testExperimentRejectsFabricatedExcerptAndPage() }),
            ("Legacy readings / audit", { try tests.testOldReadingsRemainDecodableAndNewAuditRoundTrips() }),
            ("Library / profile persistence", { try tests.testLibraryProfileNotesAndFeedbackPersistAfterReload() }),
            ("Library delete / restore / purge", { try tests.testLibraryDeleteRestoreAndPurge() }),
            ("Compare session persistence / comparability", { try tests.testCompareSessionPersistsAndComparabilityWarns() }),
            ("Discovery firstSeen / topic grouping", { try tests.testDiscoveryFirstSeenAndTopicGrouping() }),
            ("Repo dependency checks (R-11)", { try tests.testRepoDependencyChecks() }),
            ("OCR marker / evidence compatibility (R-06)", { try tests.testOCRMarkerAndEvidenceCompatibility() }),
            ("Retrieval chunks / cosine / keyword fallback (R-05)", { try await tests.testRetrievalChunksCosineAndKeywordFallback() }),
            ("Formula page image compression (R-07)", { try tests.testFormulaPageImageCompression() }),
            ("Math parser / degradation", { tests.testMathParserSupportsCommonStructuresAndDegrades() }),
            ("Math segments / flatten / md block", { tests.testMathSegmentsAndFlatten() }),
            ("Method formula pages / rendering / cache / visual JSON", { try tests.testMethodFormulaWorkflow() }),
            ("Local formula OCR wrapper / real PDF", { try tests.testLocalFormulaOCRWrapperOnRealPDF() }),
            ("Module-adjacent formula placement / missing references", { try tests.testModuleFormulaPlacement() }),
            ("Complex formulas / actual SwiftUI layout", { tests.testComplexMathViewCanLayout() }),
            ("Figure analysis validation / layout", { tests.testFigureAnalysisValidationAndLayout() }),
            ("Throttled persist flush", { try tests.testThrottledPersistFlushesBeforeReload() }),
            ("Corrupt state protection / repair", { try tests.testCorruptStateFilesAreNeverOverwritten() }),
            ("Compare load is read only", { try tests.testCompareLoadIsReadOnly() }),
            ("Purge supersedes pending writes", { try tests.testPurgeSupersedesPendingLibraryWrites() }),
            ("Reload preserves pending edits", { try tests.testReloadPreservesPendingEdits() }),
            ("Same paper keeps active drafts", { try tests.testReopeningCurrentPaperKeepsSessionDrafts() }),
            ("Write failure preserves session / retry", { try tests.testWriteFailureKeepsSessionAndDraftsForRetry() }),
            ("Dedup index / large input", { tests.testDeduplicateScalesAndPreservesSemantics() }),
            ("Reading history preservation", { try tests.testRegenerationArchivesPreviousOutput() }),
            ("Existing queue / real PDF extraction", { try await tests.testActualQueueAndPDFExtraction() }),
            ("Missing PDF stops AI generation", { try await tests.testNoPDFStopsGenerationWithoutAPI() }),
            ("Parallel reading kinds do not block (per-kind locks)", { try tests.testParallelReadingKindsDoNotBlockEachOther() }),
            ("Malformed frontmatter", { tests.testMalformedFrontmatterDoesNotCrash() }),
            ("Markdown decimals not list items", { tests.testMarkdownDoesNotMisparseDecimalsAsOrderedList() }),
            ("Session swap flushes drafts", { try tests.testSessionSwapFlushesDraftsBeforeReplacingSession() }),
            ("Physical table rows / number evidence", { try tests.testPhysicalTableRowsAndNumericQuoteValidation() }),
            ("Idea evidence / PDF range", { try tests.testIdeaEvidenceAndNormalizedHighlightRange() }),
            ("Idea lifecycle / corruption protection", { try tests.testIdeaLifecyclePersistenceAndCorruptFileProtection() }),
            ("Ideas envelope / array formats", { try tests.testIdeasAcceptEnvelopeAndArrayFormats() }),
            ("Application grounding / experiment", { try tests.testApplicationAdviceRequiresGroundingAndExperiment() }),
            ("Legacy experiments / baselines", { try tests.testLegacyExperimentAndNewBaselines() }),
            ("Profile methods / task / exploration", { tests.testMethodsTaskAndExplorationRanking() }),
            ("Reproduction grounding / unknowns", { try tests.testReproductionGroundingCoverageAndUnknowns() }),
            ("Reproduction revisions / corruption", { try tests.testReproductionProgressRevisionsPersistenceAndCorruption() }),
            ("Reproduction Ideas / export / compatibility", { try tests.testReproductionIdeaAndExportDoNotPromoteUnknowns() }),
            ("Repository URLs / scan coverage", { try tests.testRepositoryURLsAndFileCoverage() }),
            ("Paper-code dual evidence / lines", { try tests.testCodeMappingEvidence() }),
            ("Code revisions / confirmation / corruption", { try tests.testCodePersistenceAndCorruption() }),
            ("Results row / unit evidence", { try tests.testResultEvidenceAndUnits() }),
            ("Results keep independently verified cells", { try tests.testResultSalvageKeepsVerifiedCells() }),
            ("Persisted NAF results validate against the original PDF", { try tests.testPersistedNAFResultsAgainstOriginalPDF() }),
            ("Result document bindings / visual persistence", { try tests.testResultDocumentBindings() }),
            ("Result crop scope / two-column figures", { try tests.testResultVisualCropScope() }),
            ("Real PDF result figures / tables crop", { try tests.testActualResultVisualCrops() }),
            ("Two-column PDF table crops / no clipping", { try tests.testTwoColumnPaperTablesKeepWholeColumnsAndDropNeighborProse() }),
            ("Results column transposition rejected", { try tests.testResultColumnTranspositionIsRejected() }),
            ("Numeric tokens ignore identifiers", { tests.testNumberTokensIgnoreIdentifiers() }),
            ("BibTeX fields / citation key", { try tests.testBibtexExportFieldsAndKey() }),
            ("BibTeX special character escaping", { tests.testBibtexEscapesSpecialCharacters() }),
            ("Citation key fallback / digit prefix", { tests.testCitationKeyFallsBackAndNeverStartsWithDigit() }),
            ("BibTeX author name conversion", { tests.testAuthorNameConversion() }),
            ("Citation year extraction", { tests.testYearExtractionFromVariousFormats() }),
            ("RIS record structure", { try tests.testRisExportIsWellFormed() }),
            ("Citation empty fields omitted", { tests.testEmptyFieldsAreOmitted() }),
            ("Citation batch / filename", { tests.testBatchExportAndFilename() }),
            ("Compare pin moves column to front", { tests.testComparePinnedColumnMovesToFront() }),
            ("Compare pinned column removal", { tests.testComparePinnedColumnRemovedFromSelection() }),
            ("Compare pin toggle / highlight", { tests.testComparePinnedToggleAndHighlight() }),
            ("Compare export follows pinned order", { tests.testCompareExportFollowsPinnedOrder() }),
            ("System tags cover eight categories", { tests.testSystemTagsCoverEightCategories() }),
            ("System tags derived from paper text", { tests.testSystemTagsDeriveFromPaperText() }),
            ("System tags never invented on weak evidence", { tests.testSystemTagsDoNotInventOnWeakEvidence() }),
            ("System tags no duplicates / stable order", { tests.testSystemTagsNoDuplicatesAndStableOrder() }),
            ("System tag coverage counts", { tests.testSystemTagCoverageCounts() }),
            ("System tags empty paper stays empty", { try tests.testSystemTagsOnEmptyPaperAreEmpty() }),
            ("System tags do not touch user tags", { try tests.testSystemTagsDoNotTouchUserTags() }),
            ("Trend window derived / disclosed", { tests.testTrendWindowIsDerivedAndDisclosed() }),
            ("Trend refuses judgement below sample", { tests.testTrendRefusesJudgementBelowMinimumSample() }),
            ("Trend carries evidence set", { tests.testTrendCarriesEvidenceSet() }),
            ("Trend disclosure has three elements", { tests.testTrendDisclosureContainsAllThreeElements() }),
            ("Trend gap never claims first", { tests.testTrendGapStatementNeverClaimsFirst() }),
            ("Trend redline detector", { tests.testTrendRedlineDetector() }),
            ("Trend empty corpus safe", { tests.testTrendEmptyCorpusIsSafe() }),
            ("Baseline cards cover PRD methods", { tests.testBaselineLibraryCoversPrdNamedMethods() }),
            ("Classical methods not neural nets", { tests.testClassicalMethodsAreNotNeuralNetworks() }),
            ("Baseline alias matching", { tests.testBaselineAliasMatching() }),
            ("Unknown baseline does not match", { tests.testUnknownBaselineDoesNotFalselyMatch() }),
            ("Baseline matches deduplicated", { tests.testBaselineMatchesAreDeduplicated() }),
            ("Baseline relation is neutral", { tests.testBaselineRelationIsNeutral() }),
            ("Uncertain cards marked needsReview", { tests.testUncertainCardsAreMarkedNeedsReview() }),
            ("Table parsing", { tests.testTableParsing() }),
            ("Real table from acceptance artifact", { try tests.testRealTableFromAcceptanceArtifact() }),
            ("Table alignment from delimiter", { tests.testTableAlignmentFromDelimiter() }),
            ("Pipe without delimiter is not table", { tests.testPipeWithoutDelimiterIsNotTable() }),
            ("Table ragged rows normalized", { tests.testTableRaggedRowsAreNormalized() }),
            ("Table escaped pipe stays in cell", { tests.testTableEscapedPipeStaysInCell() }),
            ("Table does not swallow text", { tests.testTableDoesNotSwallowSurroundingText() }),
            ("Horizontal rule", { tests.testHorizontalRule() }),
            ("Table plain text fallback", { tests.testTablePlainTextFallback() }),
            ("Column width clamping", { tests.testColumnWidthClamping() }),
            ("Deterministic differences / log scales", { try tests.testResultDifferences() }),
            ("Annotation append / no duplicate section", { try tests.testAnnotationAppendDoesNotDuplicateSectionAndKeepsHistory() }),
            ("Evidence subset / material scope disclosure", { try tests.testEvidenceSubsetDisclosesMaterialScope() }),
            ("Manual queue entry / skill note linkage", { try tests.testManualQueueEntryLinksSkillNamedNote() }),
            ("Unreadable notes / arxiv key normalization", { try tests.testUnreadableNotesAreReportedAndArxivKeysNormalize() }),
            ("arxiv key strips whitespace (M-1)", { tests.testArxivKeysStripInternalWhitespace() }),
            ("Forbidden phrases unique (L-1)", { tests.testForbiddenPhrasesHaveNoDuplicates() }),
            ("PDF selection context (H-1 restore)", { tests.testPDFSelectionContextExtractsNearbyText() }),
            ("JSON extraction robustness (results decode)", { tests.testJSONExtractStripsFencesAndProse() }),
            ("Official APIs", { try await LiveDiscoveryTests().testOfficialAPIs() })
        ]
        for (name, test) in cases {
            let before = failures
            do { try await test(); if failures == before { passes += 1; print("PASS: " + name) } }
            catch let skip as SkipTest { print("SKIP: " + name + " · " + skip.message) }
            catch { failures += 1; print("FAIL: " + name + " · " + String(describing: error)) }
        }
        print("\(passes) passed; \(failures) failed")
        return failures == 0
    }
}
