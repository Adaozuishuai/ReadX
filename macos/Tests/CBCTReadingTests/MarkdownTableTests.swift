import Foundation

#if canImport(CBCTReading)
@testable import CBCTReading
#endif

extension ResearchTests {
    func blockKinds(_ src: String) -> [String] {
        Markdown.parse(src).map { b in
            switch b {
            case .heading(let t, let l): return "h\(l):\(t)"
            case .paragraph(let l): return "p:" + l.joined(separator: " ")
            case .quote(let l): return "q:" + l.joined(separator: " ")
            case .bullets(let i): return "ul:" + i.joined(separator: "|")
            case .ordered(let i): return "ol:" + i.joined(separator: "|")
            case .table(let t): return "table:\(t.columnCount)x\(t.rows.count)"
            case .rule: return "rule"
            case .mathBlock(let latex): return "math:" + latex
            }
        }
    }

    // GFM 表格应被解析为 table 块，而不是字面竖线段落
    func testTableParsing() {
        let src = """
        | A | B |
        |---|---|
        | 1 | 2 |
        | 3 | 4 |
        """
        let kinds = blockKinds(src)
        XCTAssertEqual(kinds, ["table:2x2"])
        guard case .table(let t) = Markdown.parse(src)[0] else { return }
        XCTAssertEqual(t.header, ["A", "B"])
        XCTAssertEqual(t.rows, [["1", "2"], ["3", "4"]])
        XCTAssertEqual(t.alignments, [.leading, .leading])
    }

    // 真实产物：NAF 几何表必须完整解析且数值逐字保留
    @MainActor
    func testRealTableFromAcceptanceArtifact() throws {
        let url = Store.findRoot().appendingPathComponent("macos/acceptance/2026-10-02/verified-v3/NAF-chat-geometry.md")
        guard let src = try? String(contentsOf: url, encoding: .utf8) else { return }  // 产物缺失则跳过
        let tables = Markdown.parse(src).compactMap { b -> MarkdownTable? in
            if case .table(let t) = b { return t }; return nil
        }
        let table = try XCTUnwrap(tables.first { $0.columnCount == 6 })
        XCTAssertEqual(table.header.first, "Dataset")
        XCTAssertEqual(table.rows.count, 5)
        // 数值必须原样保留（不得被清洗或改写）
        let aorta = try XCTUnwrap(table.rows.first { $0.first == "Aorta" })
        XCTAssertEqual(aorta, ["Aorta", "512×512×510", "GE C-arm", "−103°~93°", "50 (582)", "500×500"])
        // 每行列数必须与表头一致，否则渲染会错位
        for r in table.rows { XCTAssertEqual(r.count, table.columnCount) }
    }

    // 对齐由分隔行决定
    func testTableAlignmentFromDelimiter() {
        let src = """
        | L | C | R |
        |:---|:---:|---:|
        | a | b | c |
        """
        guard case .table(let t) = Markdown.parse(src)[0] else { return }
        XCTAssertEqual(t.alignments, [.leading, .center, .trailing])
    }

    // 没有分隔行就不是表格（避免把含竖线的普通句子误判）
    func testPipeWithoutDelimiterIsNotTable() {
        XCTAssertEqual(blockKinds("a | b | c"), ["p:a | b | c"])
        XCTAssertEqual(blockKinds("| just | a | row |"), ["p:| just | a | row |"])
        // 只有表头+分隔行、没有数据行 -> 不是表格
        XCTAssertEqual(blockKinds("| A | B |\n|---|---|"), ["p:| A | B |", "p:|---|---|"])
    }

    // 数据行列数不齐：多的丢弃、少的补空，且列数永远等于表头
    func testTableRaggedRowsAreNormalized() {
        let src = """
        | A | B | C |
        |---|---|---|
        | 1 | 2 |
        | 1 | 2 | 3 | 4 |
        """
        guard case .table(let t) = Markdown.parse(src)[0] else { return XCTFailShim("未解析为表格") }
        XCTAssertEqual(t.columnCount, 3)
        XCTAssertEqual(t.rows[0], ["1", "2", ""])
        XCTAssertEqual(t.rows[1], ["1", "2", "3"])
        for r in t.rows { XCTAssertEqual(r.count, 3) }
    }

    // 转义管道符不应被当作分列符
    func testTableEscapedPipeStaysInCell() {
        let src = """
        | A | B |
        |---|---|
        | x \\| y | z |
        """
        guard case .table(let t) = Markdown.parse(src)[0] else { return }
        XCTAssertEqual(t.rows[0][0], "x | y")
        XCTAssertEqual(t.rows[0][1], "z")
    }

    // 表格前后的普通段落必须保持独立，不被并进表格
    func testTableDoesNotSwallowSurroundingText() {
        let src = """
        前置说明
        | A | B |
        |---|---|
        | 1 | 2 |
        后置说明
        """
        let kinds = blockKinds(src)
        XCTAssertEqual(kinds, ["p:前置说明", "table:2x1", "p:后置说明"])
    }

    // 水平分隔线不应显示为字面量 ---，且不能吃掉表格分隔行
    func testHorizontalRule() {
        XCTAssertEqual(blockKinds("---"), ["rule"])
        XCTAssertEqual(blockKinds("***"), ["rule"])
        XCTAssertEqual(blockKinds("___"), ["rule"])
        XCTAssertEqual(blockKinds("a\n\n---\n\nb"), ["p:a", "rule", "p:b"])
        // 表格紧随其后时，--- 仍必须是表格分隔行而非 hr
        XCTAssertEqual(blockKinds("| A |\n|---|\n| 1 |"), ["table:1x1"])
        // 4 个短横线也是 hr
        XCTAssertEqual(blockKinds("----"), ["rule"])
    }

    // 表格纯文本回退必须保留列对齐与全部数值
    func testTablePlainTextFallback() {
        let src = """
        | Metric | Value |
        |---|---:|
        | PSNR | 34.45 |
        | SSIM | .958 |
        """
        guard case .table(let t) = Markdown.parse(src)[0] else { return }
        let text = t.plainText()
        XCTAssertTrue(text.contains("Metric"))
        XCTAssertTrue(text.contains("34.45"))
        XCTAssertTrue(text.contains(".958"))
        // 每行都应以 | 起止，便于等宽对齐阅读
        for line in text.split(separator: "\n") {
            XCTAssertTrue(line.hasPrefix("|"), "回退文本行缺少起始竖线：" + line)
        }
        XCTAssertEqual(text.split(separator: "\n").count, 4)  // 表头 + 分隔 + 2 数据行
    }

    // 列宽计算不得溢出或小于下限
    func testColumnWidthClamping() {
        let narrow = Typography.columnWidths(columnCount: 6, available: 300)
        XCTAssertEqual(narrow.count, 6)
        for w in narrow { XCTAssertEqual(w, Typography.minColumnWidth) }
        let wide = Typography.columnWidths(columnCount: 2, available: 4000)
        for w in wide { XCTAssertEqual(w, Typography.maxColumnWidth) }
        XCTAssertTrue(Typography.columnWidths(columnCount: 0, available: 500).isEmpty)
    }
}

// 测试 harness 没有 XCTFail，提供一个最小替身
func XCTFailShim(_ message: String) { report(false, message) }
