import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func citationFixture() -> QueueEntry {
        var p = QueueEntry(arxiv: "2209.14540",
                           title: "Neural Attenuation Fields for Sparse-View CBCT Reconstruction",
                           authors: ["Ruyi Zha", "Yanhao Zhang", "Hongdong Li"])
        p.venue = "MICCAI 2022"
        p.doi = "10.1000/abc"
        p.published = "2022-09-30"
        p.pdfUrl = "https://arxiv.org/pdf/2209.14540"
        return p
    }

    func testBibtexExportFieldsAndKey() throws {
        let p = citationFixture()
        let bib = CitationExport.bibtex(p)
        XCTAssertTrue(bib.hasPrefix("@misc{2209.14540,"))
        XCTAssertTrue(bib.contains("author = {Zha, Ruyi and Zhang, Yanhao and Li, Hongdong}"))
        XCTAssertTrue(bib.contains("title = {{Neural Attenuation Fields for Sparse-View CBCT Reconstruction}}"))
        XCTAssertTrue(bib.contains("year = {2022}"))
        XCTAssertTrue(bib.contains("eprint = {2209.14540}"))
        XCTAssertTrue(bib.contains("archivePrefix = {arXiv}"))
        XCTAssertTrue(bib.contains("journal = {MICCAI 2022}"))
        XCTAssertTrue(bib.contains("doi = {10.1000/abc}"))
        // 「arXiv」这种占位 venue 不应写成 journal
        var arxivOnly = p; arxivOnly.venue = "arXiv"
        XCTAssertFalse(CitationExport.bibtex(arxivOnly).contains("journal ="))
    }

    // BibTeX 特殊字符必须转义，否则 .bib 文件会被 LaTeX 解析错
    func testBibtexEscapesSpecialCharacters() {
        var p = citationFixture()
        p.title = "A & B: 100% of $x$ #1 _y_ {z} ~ ^"
        let bib = CitationExport.bibtex(p)
        XCTAssertTrue(bib.contains("\\&"))
        XCTAssertTrue(bib.contains("\\%"))
        XCTAssertTrue(bib.contains("\\$"))
        XCTAssertTrue(bib.contains("\\#"))
        XCTAssertTrue(bib.contains("\\_"))
        XCTAssertTrue(bib.contains("\\{"))
        XCTAssertTrue(bib.contains("\\}"))
        XCTAssertFalse(bib.contains("100% of"))
    }

    // 键不能以数字开头（BibTeX 语法限制），非 arXiv 论文回退到 id/标题
    func testCitationKeyFallsBackAndNeverStartsWithDigit() {
        var p = QueueEntry(arxiv: "2209.14540", title: "T")
        XCTAssertEqual(CitationExport.citationKey(p), "2209.14540")
        p = QueueEntry(id: "intratomo-2021", title: "IntraTomo")
        XCTAssertEqual(CitationExport.citationKey(p), "intratomo-2021")
        // 纯数字 id -> 加前缀（部分工具会把纯数字键当数字处理）
        p = QueueEntry(id: "12345", title: "Numeric")
        XCTAssertEqual(CitationExport.citationKey(p), "ref12345")
        // 但 arXiv 号含点号，是合法且惯用的键，不得加前缀
        p = QueueEntry(arxiv: "2209.14540", title: "NAF")
        XCTAssertEqual(CitationExport.citationKey(p), "2209.14540")
        // 无 id 无 arxiv -> 用标题
        p = QueueEntry(title: "Some Title")
        XCTAssertEqual(CitationExport.citationKey(p), "SomeTitle")
    }

    func testAuthorNameConversion() {
        XCTAssertEqual(CitationExport.bibtexAuthor("Ruyi Zha"), "Zha, Ruyi")
        XCTAssertEqual(CitationExport.bibtexAuthor("Zha, Ruyi"), "Zha, Ruyi")
        XCTAssertEqual(CitationExport.bibtexAuthor("Madonna"), "Madonna")
        XCTAssertEqual(CitationExport.bibtexAuthor("  "), "")
        XCTAssertEqual(CitationExport.bibtexAuthor("Guangming Zang"), "Zang, Guangming")
    }

    func testYearExtractionFromVariousFormats() {
        var p = citationFixture()
        XCTAssertEqual(CitationExport.year(p), "2022")
        p.published = "2026"
        XCTAssertEqual(CitationExport.year(p), "2026")
        p.published = nil; p.year = "2021"
        XCTAssertEqual(CitationExport.year(p), "2021")
        p.published = nil; p.year = nil
        XCTAssertEqual(CitationExport.year(p), "")
    }

    func testRisExportIsWellFormed() throws {
        let ris = CitationExport.ris(citationFixture())
        XCTAssertTrue(ris.hasPrefix("TY  - JOUR"))
        XCTAssertTrue(ris.contains("AU  - Zha, Ruyi"))
        XCTAssertTrue(ris.contains("TI  - Neural Attenuation Fields"))
        XCTAssertTrue(ris.contains("PY  - 2022"))
        XCTAssertTrue(ris.contains("DO  - 10.1000/abc"))
        XCTAssertTrue(ris.contains("AN  - arXiv:2209.14540"))
        XCTAssertTrue(ris.hasSuffix("ER  - "))
        // 每条记录必须以 ER 结束，否则导入工具会吞掉后续记录
        let two = CitationExport.ris([citationFixture(), citationFixture()])
        XCTAssertEqual(two.components(separatedBy: "ER  - ").count - 1, 2)
    }

    // 字段缺失时不得生成 `author = {}` 这类脏数据
    func testEmptyFieldsAreOmitted() {
        let bare = QueueEntry(title: "Bare Title")
        let bib = CitationExport.bibtex(bare)
        XCTAssertTrue(bib.contains("title ="))
        XCTAssertFalse(bib.contains("author ="))
        XCTAssertFalse(bib.contains("year ="))
        XCTAssertFalse(bib.contains("doi ="))
        XCTAssertFalse(bib.contains(" = {}"))
    }

    func testBatchExportAndFilename() {
        let p = citationFixture()
        let many = CitationExport.bibtex([p, p])
        XCTAssertEqual(many.components(separatedBy: "@misc{").count - 1, 2)
        XCTAssertEqual(CitationExport.suggestedFilename([p], ext: "bib", today: "2026-10-02"), "2209.14540.bib")
        XCTAssertEqual(CitationExport.suggestedFilename([p, p], ext: "ris", today: "2026-10-02"), "CBCT-citations-2026-10-02.ris")
        // 空集合返回空串，由调用方提示
        XCTAssertEqual(CitationExport.bibtex([]).trimmingCharacters(in: .whitespacesAndNewlines), "")
    }
}
