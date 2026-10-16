import Foundation
import PDFKit
import CoreGraphics

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func resultFixture() -> (ResultsAnalysis, String) {
        let source = "=== Page 1 ===\nTable 1: Brain results. PSNR (dB) and SSIM (dimensionless).\nA 33.05 .96\nB 22.89 .78"
        func field(_ k: String, _ v: String, _ quote: String) -> ExperimentField { .init(k: k, v: v, page: 1, excerpt: quote) }
        let header = field("Header", "Brain PSNR and SSIM", "Brain results. PSNR (dB) and SSIM (dimensionless).")
        let columns = [ResultColumn(id: "p", label: "Brain", metric: "PSNR", unit: "dB", context: header), ResultColumn(id: "s", label: "Brain", metric: "SSIM", unit: "dimensionless", context: header)]
        let rows = [ResultRow(id: "a", method: "A", evidence: field("A", "A 33.05 .96", "A 33.05 .96"), cells: [ResultCell(columnID: "p", valueText: "33.05"), ResultCell(columnID: "s", valueText: ".96")]), ResultRow(id: "b", method: "B", evidence: field("B", "B 22.89 .78", "B 22.89 .78"), cells: [ResultCell(columnID: "p", valueText: "22.89"), ResultCell(columnID: "s", valueText: ".78")])]
        let table = ResultTable(id: "t", caption: field("Caption", "Brain results", "Table 1: Brain results."), header: header, protocol: ExperimentField(k: "Protocol", v: "论文未说明", page: nil, excerpt: nil), columns: columns, rows: rows)
        return (ResultsAnalysis(tables: [table], stability: [], ablation: [], generalization: [], efficiency: [], statistics: [], missing: ["Protocol unconfirmed"]), source)
    }
    func testResultEvidenceAndUnits() throws {
        var (analysis, source) = resultFixture()
        XCTAssertNoThrow(try analysis.validate(source: source))
        analysis.tables[0].rows[0].cells[0].valueText = "99.99"; XCTAssertThrowsError(try analysis.validate(source: source))
        analysis.tables[0].rows[0].cells[0].valueText = "33.05"
        analysis.tables[0].rows[0].cells[1].valueText = "0.96"; XCTAssertThrowsError(try analysis.validate(source: source))
        analysis.tables[0].rows[0].cells[1].valueText = ".96"
        analysis.tables[0].rows[0].cells[0].columnID = "invented"; XCTAssertThrowsError(try analysis.validate(source: source))
        analysis.tables[0].rows[0].cells[0].columnID = "p"
        analysis.tables[0].columns[0].unit = "GB"; XCTAssertThrowsError(try analysis.validate(source: source))
        analysis.tables[0].columns[0].unit = "dB"
        analysis.tables[0].rows[0].evidence.page = 99; XCTAssertThrowsError(try analysis.validate(source: source))
        analysis.tables[0].rows[0].evidence.page = 1
        analysis.statistics = [ExperimentField(k: "p", v: "p=0.01", page: 1, excerpt: "Brain results. PSNR (dB)")]; XCTAssertThrowsError(try analysis.validate(source: source))
        let raw = try JSONEncoder().encode(resultFixture().0)
        XCTAssertEqual(try ResultsAnalysis.decode(String(decoding: raw, as: UTF8.self)).tables[0].rows.count, 2)
    }
    func testResultSalvageKeepsVerifiedCells() throws {
        var (analysis, source) = resultFixture()
        analysis.tables[0].rows[0].cells[0].valueText = "99.99" // unsupported; SSIM in the same row is still sound
        analysis.stability = [ResultDiscussion(
            evidence: ExperimentField(k: "bad", v: "unknown", page: 9, excerpt: "invented evidence"),
            interpretation: "unverified", tableID: "t")]
        let rescued = analysis.salvaged(source: source, visuals: [])
        XCTAssertEqual(rescued.tables.count, 1)
        XCTAssertEqual(rescued.tables[0].rows[0].cells.map(\.columnID), ["s"])
        XCTAssertTrue(rescued.missing.contains { $0.contains("cell") || $0.contains("单元格") })
        XCTAssertTrue(rescued.stability.isEmpty)
        XCTAssertNoThrow(try rescued.validate(source: source))
    }

    func testPersistedNAFResultsAgainstOriginalPDF() throws {
        let root = testWorkspace()
        let readingURL = root.appendingPathComponent("app/data/readings/2209.14540.json")
        let pdfURL = root.appendingPathComponent("library/2022-NAF-2209.14540.pdf")
        guard FileManager.default.fileExists(atPath: readingURL.path), FileManager.default.fileExists(atPath: pdfURL.path) else {
            throw XCTSkip("本机 NAF 阅读缓存或 PDF 不存在")
        }
        let reading = try JSONDecoder().decode(ReadingFile.self, from: Data(contentsOf: readingURL))
        let analysis = try ResultsAnalysis.decode(try XCTUnwrap(reading.resultsJSON))
        let pdf = try XCTUnwrap(PDFDocument(url: pdfURL))
        let source = (0..<pdf.pageCount).map { index in
            "=== Page \(index + 1) ===\n" + PDFLayout.text(pdf.page(at: index)!)
        }.joined(separator: "\n")
        XCTAssertNoThrow(try analysis.validate(source: source))
        XCTAssertNoThrow(try analysis.validateBindings(visuals: reading.resultVisuals ?? []))
        XCTAssertFalse(analysis.tables.isEmpty)
        XCTAssertTrue(analysis.tables.allSatisfy { !$0.rows.isEmpty && !$0.columns.isEmpty })
    }
    // 列置换：每个单元格的数字都仍在该行摘录里（集合语义成立），但列被整体错位。
    // 修复前集合语义无法发现，修复后必须被「未按表头列顺序」拒绝。
    // 注意：用例必须让「正确赋值」能通过，否则会因别的原因被拒、测不到顺序校验本身。
    func testResultColumnTranspositionIsRejected() throws {
        let quote = "NAF 33.05 .96 | SART 32.12 .95"
        func field(_ k: String, _ v: String) -> ExperimentField { ExperimentField(k: k, v: v, page: 1, excerpt: quote) }
        func analysis(_ naf: [String], _ sart: [String]) -> ResultsAnalysis {
            let cols = [ResultColumn(id: "p", label: "PSNR", metric: "PSNR", unit: "论文未说明", context: field("h", quote)),
                        ResultColumn(id: "s", label: "SSIM", metric: "SSIM", unit: "论文未说明", context: field("h", quote))]
            func row(_ id: String, _ method: String, _ cells: [String], _ ex: String) -> ResultRow {
                ResultRow(id: id, method: method, evidence: ExperimentField(k: method, v: method, page: 1, excerpt: ex),
                          cells: [ResultCell(columnID: "p", valueText: cells[0]), ResultCell(columnID: "s", valueText: cells[1])])
            }
            let t = ResultTable(id: "t", caption: field("c", "Table"), header: field("h", quote),
                                protocol: ExperimentField(k: "P", v: "论文未说明", page: nil, excerpt: nil),
                                columns: cols, rows: [row("naf", "NAF", naf, "NAF 33.05 .96"), row("sart", "SART", sart, "SART 32.12 .95")])
            return ResultsAnalysis(tables: [t], stability: [], ablation: [], generalization: [], efficiency: [], statistics: [], missing: [])
        }
        let src = "=== Page 1 ===\n" + quote
        // 正确：p=PSNR, s=SSIM，顺序与摘录一致
        XCTAssertNoThrow(try analysis(["33.05", ".96"], ["32.12", ".95"]).validate(source: src))
        // 转置：把 SSIM 的值放进 PSNR 列（数字仍在同一行摘录里，集合语义仍成立）
        XCTAssertThrowsError(try analysis([".96", "33.05"], [".95", "32.12"]).validate(source: src))
    }
    func testResultDifferences() throws {
        var table = resultFixture().0.tables[0]
        let psnr = try XCTUnwrap(ResultDifference.calculate(table: table, columnID: "p", aID: "a", bID: "b"))
        XCTAssertLessThan(abs(psnr.absolute - 10.16), 1e-10)
        XCTAssertLessThan(abs(try XCTUnwrap(psnr.relativePercent) - (psnr.a - psnr.b) / abs(psnr.b) * 100), 1e-10)
        let ssim = try XCTUnwrap(ResultDifference.calculate(table: table, columnID: "s", aID: "a", bID: "b"))
        XCTAssertLessThan(abs(ssim.absolute - 0.18), 1e-10)
        XCTAssertLessThan(abs(try XCTUnwrap(ssim.relativePercent) - 23.0769230769), 1e-8)
        table.columns[1].unit = "论文未说明"
        XCTAssertTrue(ResultDifference.calculate(table: table, columnID: "s", aID: "a", bID: "b")?.relativePercent != nil)
        table.columns[1].unit = "dimensionless"; table.rows[1].cells[1].valueText = "0"
        XCTAssertNil(ResultDifference.calculate(table: table, columnID: "s", aID: "a", bID: "b")?.relativePercent)
        XCTAssertNil(ResultDifference.calculate(table: table, columnID: "s", aID: "a", bID: "a"))
        XCTAssertNil(ResultDifference.calculate(table: table, columnID: "invented", aID: "a", bID: "b"))
        XCTAssertNil(ResultCell(columnID: "s", valueText: "NaN").value)
        XCTAssertNil(ResultCell(columnID: "s", valueText: "1e9999").value)
        table.rows[0].cells[0].valueText = "1e308"; table.rows[1].cells[0].valueText = "-1e308"
        XCTAssertNil(ResultDifference.calculate(table: table, columnID: "p", aID: "a", bID: "b"))
    }
    // 方法名里的数字不是测量值。修复前 numbers("IntraTomo3D") == ["3"]，
    // 会让伪造值「恰好等于方法名里的数字」通过数字支持校验。
    func testNumberTokensIgnoreIdentifiers() {
        XCTAssertEqual(Evidence.numbers("IntraTomo3D"), [])
        XCTAssertEqual(Evidence.numbers("ASD-POCS"), [])
        XCTAssertEqual(Evidence.numbers("NAF (Ours)"), [])
        // 但贴在词后/词前的型号数字是论文真实报告的事实，必须保留
        XCTAssertEqual(Evidence.numbers("RTX3090"), ["3090"])
        XCTAssertEqual(Evidence.numbers("1.2GB"), ["1.2"])
        XCTAssertEqual(Evidence.numbers("RTX 3090"), ["3090"])
        XCTAssertEqual(Evidence.numbers("128×128×128"), ["128"])
        // 原有记法与既有断言不得改变
        XCTAssertEqual(Evidence.numbers("34.45/.95 30.34/.88"), ["34.45", ".95", "30.34", ".88"])
        XCTAssertEqual(Evidence.numbers("five datasets, single RTX 3090"), ["5", "1", "3090"])
        XCTAssertEqual(Evidence.numbers(".958"), [".958"])
        XCTAssertFalse(Evidence.numbers("1×10^3").isSubset(of: Evidence.numbers("1×10−3")))
        // 伪造的「3 dB」在含 IntraTomo3D 的摘录下必须被判为无支持
        let excerpt = "IntraTomo3D [28] 31.94/.95"
        XCTAssertTrue(Evidence.numbers("IntraTomo3D reaches 3 dB").subtracting(Evidence.numbers(excerpt)).contains("3"))
    }
}

extension ResearchTests {
    func testResultDocumentBindings() throws {
        var (analysis, source) = resultFixture()
        analysis.tables[0].caption.v = "Table 1: Brain results."
        let field = analysis.tables[0].rows[0].evidence
        analysis.stability = [ResultDiscussion(evidence: field, interpretation: "仅支持当前数据集对比。", tableID: "t")]
        let assets = [ResultVisual(id: "table1", page: 1, caption: "Table 1", kind: "table", jpeg: Data([1,2]), ocr: "Brain results"),
                      ResultVisual(id: "fig2", page: 2, caption: "Fig. 2", kind: "figure", jpeg: nil, ocr: "")]
        XCTAssertNoThrow(try analysis.validateBindings(visuals: assets))
        let plan = ResultDocumentPlan.items(analysis, visuals: assets)
        XCTAssertEqual(plan.count, 2)
        XCTAssertEqual(plan[0].visual?.id, "table1")
        XCTAssertEqual(plan[0].table?.id, "t")
        XCTAssertEqual(plan[0].discussions.count, 1)
        XCTAssertEqual(plan[1].discussions.count, 0)
        analysis.stability[0].tableID = nil; analysis.stability[0].visualID = "table1"
        XCTAssertEqual(ResultDocumentPlan.items(analysis, visuals: assets)[0].discussions.count, 1)
        analysis.stability[0].tableID = "t"; analysis.stability[0].visualID = nil
        analysis.stability[0].tableID = "absent"
        XCTAssertThrowsError(try analysis.validateBindings(visuals: assets))
        analysis.stability[0].tableID = "t"; analysis.stability[0].visualID = "fig2"
        XCTAssertThrowsError(try analysis.validateBindings(visuals: assets))
        analysis.stability = []
        // 表没有解读不再硬性失败（辅助性表格常无解读；UI 显示占位）——曾导致部分论文结果分析整体失败
        XCTAssertNoThrow(try analysis.validateBindings(visuals: assets))
        let cached = ReadingFile(key: "test", resultVisuals: assets)
        let restored = try JSONDecoder().decode(ReadingFile.self, from: JSONEncoder().encode(cached))
        XCTAssertEqual(restored.resultVisuals?.first?.jpeg, Data([1,2]))
        XCTAssertNil(restored.resultVisualVersion)
        XCTAssertFalse(ResultVisualCrop.cacheIsCurrent(restored.resultVisualVersion), "legacy crops must be regenerated after the crop algorithm changes")
        XCTAssertTrue(ResultVisualCrop.cacheIsCurrent(ResultVisualCrop.cacheVersion))
        XCTAssertFalse(ResultVisualCrop.cacheIsCurrent(ResultVisualCrop.cacheVersion - 1))
        let legacy = try JSONDecoder().decode(ReadingFile.self, from: Data("{\"key\":\"legacy\"}".utf8))
        XCTAssertNil(legacy.resultVisuals)
        let merged = ResultVisualSource.augmented(source, fullSource: source + "\n=== Page 2 ===\nFig. 2 Results", visuals: assets)
        XCTAssertEqual(Evidence.pages(merged).map(\.number), [1,2])
        XCTAssertTrue(merged.contains("Brain results"))
        let visualField = ExperimentField(k: "曲线标签", v: "PSNR 33.05 and SSIM .96", page: 1, excerpt: "PSNR 33.05 and SSIM .96")
        var reading = ResultVisualReading(observations: [visualField], interpretation: "AI解读：PSNR 33.05", category: "comparison")
        XCTAssertNoThrow(try reading.validate(page: 1, ocr: "PSNR 33.05 and SSIM .96"))
        reading.interpretation = "AI解读：PSNR 99.99"
        XCTAssertThrowsError(try reading.validate(page: 1, ocr: "PSNR 33.05 and SSIM .96"))
        XCTAssertThrowsError(try reading.validate(page: 2, ocr: "PSNR 33.05 and SSIM .96"))
        let shortLabel = ResultVisualReading(observations: [.init(k: "指标", v: "SSIM", page: 1, excerpt: "SSIM")], interpretation: "仅按图内可见曲线比较趋势，未读取精确数值。", category: "comparison")
        XCTAssertNoThrow(try shortLabel.validate(page: 1, ocr: "PSNR\nSSIM"))
        XCTAssertThrowsError(try shortLabel.validate(page: 1, ocr: "PSNR only"))
        let selected = try ResultVisualReading.decode(#"{"observations":[{"k":"指标","ocrLineIDs":[2]}],"interpretation":"仅比较可见趋势。","category":"comparison"}"#, page: 1, ocr: "PSNR\nSSIM")
        XCTAssertEqual(selected.observations[0].v, "SSIM")
        XCTAssertNoThrow(try selected.validate(page: 1, ocr: "PSNR\nSSIM"))
        XCTAssertThrowsError(try ResultVisualReading.decode(#"{"observations":[{"k":"指标","ocrLineIDs":[99]}],"interpretation":"假读数","category":"comparison"}"#, page: 1, ocr: "PSNR\nSSIM"))
    }
    func testResultVisualCropScope() throws {
        let source = "=== Page 1 ===\n2 Method\nFig. 1: Pipeline\n=== Page 4 ===\n3 Experiments\nTable 1: Dataset dimensions\nFig. 2: Qualitative comparison\n=== Page 5 ===\nFig. 3: Ablation\nFig. 4: Efficiency"
        XCTAssertEqual(ResultVisualLocator.find(in: source).map(\.id), ["table1", "fig2", "fig3", "fig4"])
        let parallel = ResultVisualLocator.find(in: "=== Page 7 ===\nTable 1. Left-column table | Table 2. Right-column table")
        XCTAssertEqual(parallel.map(\.id), ["table1", "table2"], "same-row captions in PDFLayout's two-column separator must stay distinct")
        typealias Line = ResultVisualCrop.Line
        let lines = [Line(text: "Fig. 3: Results on chest", box: CGRect(x: 0.08, y: 0.3, width: 0.38, height: 0.02)),
                     Line(text: "Fig. 4: Results on jaw", box: CGRect(x: 0.54, y: 0.3, width: 0.38, height: 0.02))]
        let left = try XCTUnwrap(ResultVisualCrop.region(for: .init(id: "fig3", page: 5, caption: "Fig. 3", kind: "figure"), lines: lines))
        let right = try XCTUnwrap(ResultVisualCrop.region(for: .init(id: "fig4", page: 5, caption: "Fig. 4", kind: "figure"), lines: lines))
        XCTAssertTrue(left.maxX <= right.minX)
        XCTAssertTrue(left.minY > lines[0].box.maxY)
        XCTAssertNil(ResultVisualCrop.region(for: .init(id: "fig30", page: 5, caption: "Fig. 30", kind: "figure"), lines: lines))
        let tableLine = Line(text: "Table 2: PSNR and SSIM", box: CGRect(x: 0.08, y: 0.8, width: 0.84, height: 0.02))
        let table = try XCTUnwrap(ResultVisualCrop.region(for: .init(id: "table2", page: 7, caption: "Table 2", kind: "table"), lines: [tableLine]))
        XCTAssertTrue(table.maxY < tableLine.box.minY)
        XCTAssertLessThan(table.height, 0.5)
        let shortCaption = Line(text: "Table 1: Dataset", box: CGRect(x: 0.2, y: 0.8, width: 0.6, height: 0.02))
        let wideTable = try XCTUnwrap(ResultVisualCrop.region(for: .init(id: "table1", page: 6, caption: "Table 1", kind: "table"), lines: [shortCaption]))
        XCTAssertTrue(wideTable.minX < 0.05 && wideTable.maxX > 0.95)
    }
    func testActualResultVisualCrops() throws {
        let url = testWorkspace().appendingPathComponent("library/2022-NAF-2209.14540.pdf")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("NAF PDF unavailable") }
        let doc = try XCTUnwrap(PDFDocument(url: url))
        let source = (0..<doc.pageCount).map { "=== Page \($0 + 1) ===\n" + PDFLayout.text(doc.page(at: $0)!) }.joined(separator: "\n")
        let hits = ResultVisualLocator.find(in: source)
        XCTAssertFalse(hits.contains { $0.id == "fig1" })
        XCTAssertTrue(hits.contains { $0.id == "fig3" })
        XCTAssertTrue(hits.contains { $0.id == "table2" })
        let assets = try ResultVisualCrop.extract(url: url, hits: hits)
        XCTAssertEqual(assets.count, hits.count)
        for asset in assets {
            XCTAssertTrue(asset.jpeg != nil, "Crop failed for " + asset.id)
            if asset.id == "table1" { XCTAssertTrue(asset.ocr.contains("Chest") && asset.ocr.contains("128")) }
            if asset.id == "fig3" { XCTAssertFalse(asset.ocr.contains("R. Zha")) }
            if asset.id == "table2" { XCTAssertFalse(asset.ocr.contains("Projection")) }
            if let directory = ProcessInfo.processInfo.environment["CBCT_VISUAL_QA_DIR"], let jpeg = asset.jpeg {
                let output = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
                try jpeg.write(to: output.appendingPathComponent(asset.id + ".jpg"))
            }
        }
    }

    func testTwoColumnPaperTablesKeepWholeColumnsAndDropNeighborProse() throws {
        let url = testWorkspace().appendingPathComponent("library/2026-2608.04764.pdf")
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("two-column CBCT PDF unavailable") }
        let doc = try XCTUnwrap(PDFDocument(url: url))
        let source = (0..<doc.pageCount).map { "=== Page \($0 + 1) ===\n" + PDFLayout.text(doc.page(at: $0)!) }.joined(separator: "\n")
        let allTableHits = ResultVisualLocator.find(in: source).filter { $0.kind == "table" }
        let hits = allTableHits.filter { $0.page == 7 }
        XCTAssertEqual(hits.map(\.id), ["table1", "table2", "table3", "table4"],
                       "page 7 table captions: " + hits.map { "\($0.id)@\($0.page):\($0.caption.prefix(48))" }.joined(separator: "; "))
        let assets = try ResultVisualCrop.extract(url: url, hits: hits)
        let tables = Dictionary(uniqueKeysWithValues: assets.map { ($0.id, $0) })
        if let directory = ProcessInfo.processInfo.environment["CBCT_VISUAL_QA_DIR"] {
            let output = URL(fileURLWithPath: directory)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            for asset in assets { if let jpeg = asset.jpeg { try jpeg.write(to: output.appendingPathComponent("two-column-" + asset.id + ".jpg")) } }
        }
        let efficiency = try XCTUnwrap(tables["table1"])
        XCTAssertTrue(efficiency.jpeg != nil)
        XCTAssertTrue(efficiency.ocr.contains("Ours"), "right-most method column must not be clipped: \(efficiency.ocr)")
        XCTAssertTrue(efficiency.ocr.contains("Blueberry"), "last data row must remain in the table crop")
        XCTAssertFalse(efficiency.ocr.contains("Table 2"), "neighboring right-column caption must not leak into Table 1")
        XCTAssertFalse(efficiency.ocr.contains("severe artifacts"), "discussion paragraphs must not leak into Table 1")
        let quantitative = try XCTUnwrap(tables["table2"])
        XCTAssertTrue(quantitative.jpeg != nil, quantitative.error ?? "Table 2 crop is missing")
        XCTAssertTrue(quantitative.ocr.contains("Broccoli") && quantitative.ocr.contains("28.96"), quantitative.ocr)
        XCTAssertFalse(quantitative.ocr.contains("Table 3"), "the next table must not leak into Table 2")
        let spectral = try XCTUnwrap(tables["table3"])
        XCTAssertTrue(spectral.ocr.contains("SSIM3D") && spectral.ocr.contains("0.994"), spectral.ocr)
        XCTAssertFalse(spectral.ocr.contains("Table 4"), "the next table must not leak into Table 3")
        let ablation = try XCTUnwrap(tables["table4"])
        XCTAssertTrue(ablation.jpeg != nil)
        XCTAssertTrue(ablation.ocr.contains("Baseline") && ablation.ocr.contains("28.04"), ablation.ocr)
        XCTAssertFalse(ablation.ocr.contains("Number of spectrum components"), "adjacent prose should not enter the Table 4 crop: \(ablation.ocr)")
    }
}
