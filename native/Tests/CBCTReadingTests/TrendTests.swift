import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func trendPaper(_ id: String, _ year: String, _ text: String) -> QueueEntry {
        var p = QueueEntry(id: id, title: text)
        p.published = year + "-01-01"
        return p
    }

    // PRD 4.16 要求趋势必须展示时间窗口
    func testTrendWindowIsDerivedAndDisclosed() {
        let papers = [trendPaper("a", "2021", "sparse-view"), trendPaper("b", "2024", "low-dose"),
                      trendPaper("c", "2023", "sparse-view")]
        let sample = TrendAnalysis.sample(papers)
        XCTAssertEqual(sample.windowStart, "2021")
        XCTAssertEqual(sample.windowEnd, "2024")
        XCTAssertEqual(sample.count, 3)
        XCTAssertTrue(sample.isWindowBounded)
        // 年份缺失时必须显式标记为未知，而不是编造
        let noYear = [QueueEntry(id: "x", title: "no year")]
        XCTAssertFalse(TrendAnalysis.sample(noYear).isWindowBounded)
        XCTAssertNil(TrendAnalysis.sample(noYear).windowStart)
    }

    // PRD 风险表点名「样本少导致伪趋势」：样本不足不得下趋势判断
    func testTrendRefusesJudgementBelowMinimumSample() {
        XCTAssertEqual(TrendAnalysis.minimumSample, 5)
        let few = (0..<4).map { trendPaper("p\($0)", "2023", "sparse-view CBCT") }
        let findings = TrendAnalysis.findings(few) { SystemTags.derive(from: [$0.title ?? ""]) }
        XCTAssertFalse(findings.isEmpty)
        for f in findings {
            XCTAssertFalse(f.isSupported, "样本不足却标记为可支持：" + f.topic)
            XCTAssertTrue(f.claim.contains("样本不足"))
            XCTAssertTrue(f.caveat.contains("不下趋势判断"))
        }
        // 达到下限后可以给计数型结论，但仍不得声称升温
        let enough = (0..<5).map { trendPaper("q\($0)", "2023", "sparse-view CBCT") }
        let supported = TrendAnalysis.findings(enough) { SystemTags.derive(from: [$0.title ?? ""]) }
        XCTAssertTrue(supported.contains { $0.isSupported })
        for f in supported where f.isSupported {
            XCTAssertFalse(f.claim.contains("升温"))
            XCTAssertTrue(f.caveat.contains("不代表"))
        }
    }

    // 证据集合：每条结论必须能指出是哪几篇论文
    func testTrendCarriesEvidenceSet() {
        let papers = (0..<6).map { trendPaper("e\($0)", "2023", "sparse-view CBCT with PSNR") }
        let findings = TrendAnalysis.findings(papers) { SystemTags.derive(from: [$0.title ?? ""]) }
        let sparse = try? XCTUnwrap(findings.first { $0.topic == "Sparse-view" })
        XCTAssertEqual(sparse?.count, 6)
        XCTAssertEqual(sparse?.evidence.first?.papers.count, 6)
        XCTAssertEqual(Set(sparse?.evidence.first?.papers.map(\.key) ?? []).count, 6)
    }

    // disclosure 必须同时含时间窗、样本数、证据三样
    func testTrendDisclosureContainsAllThreeElements() {
        let papers = (0..<6).map { trendPaper("d\($0)", "2022", "sparse-view") }
        let findings = TrendAnalysis.findings(papers) { SystemTags.derive(from: [$0.title ?? ""]) }
        let f = try? XCTUnwrap(findings.first)
        let d = f?.disclosure ?? ""
        XCTAssertTrue(d.contains("时间窗口"))
        XCTAssertTrue(d.contains("样本数"))
        XCTAssertTrue(d.contains("证据"))
        XCTAssertTrue(d.contains("6 篇"))
    }

    // PRD 红线：不能声称「首次」「无人研究过」
    func testTrendGapStatementNeverClaimsFirst() {
        let papers = (0..<2).map { trendPaper("g\($0)", "2023", "some topic") }
        let stmt = TrendAnalysis.gapStatement(topic: "金属伪影", sample: TrendAnalysis.sample(papers))
        XCTAssertTrue(stmt.contains("未发现"))
        XCTAssertTrue(stmt.contains("不等于该方向无人研究"))
        XCTAssertTrue(stmt.contains("不构成「首次」声明"))
        XCTAssertFalse(TrendAnalysis.violatesRedline(stmt))
    }

    func testTrendRedlineDetector() {
        XCTAssertTrue(TrendAnalysis.violatesRedline("这是首次提出该方法"))
        XCTAssertTrue(TrendAnalysis.violatesRedline("No one has tried this"))
        XCTAssertTrue(TrendAnalysis.violatesRedline("首个 4D-CBCT 工作"))
        XCTAssertFalse(TrendAnalysis.violatesRedline("在检索范围内未发现直接工作"))
        XCTAssertFalse(TrendAnalysis.violatesRedline("6 篇论文涉及 Sparse-view"))
    }

    // 空集合不得崩溃，也不得给出任何结论
    func testTrendEmptyCorpusIsSafe() {
        let papers: [QueueEntry] = []
        XCTAssertEqual(TrendAnalysis.sample(papers).count, 0)
        XCTAssertFalse(TrendAnalysis.sample(papers).isWindowBounded)
        XCTAssertTrue(TrendAnalysis.findings(papers) { _ in [] }.isEmpty)
        let stmt = TrendAnalysis.gapStatement(topic: "x", sample: TrendAnalysis.sample(papers))
        XCTAssertTrue(stmt.contains("0 篇"))
    }
}
