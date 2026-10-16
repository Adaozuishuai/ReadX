import Foundation
import PDFKit

enum PDFLayout {
    struct Row { var text: String; var rect: CGRect }
    // PDFPage.string can serialize all method names followed by all table values.
    // Rectangular line selection follows physical rows and retains row labels.
    static func rows(_ page: PDFPage) -> [Row] {
        let bounds = page.bounds(for: .cropBox)
        guard bounds.height > 0, bounds.height < 5000 else { return [] }
        var seen = Set<String>(), result: [Row] = []
        for y in stride(from: bounds.maxY, through: bounds.minY, by: -1) {
            let rect = CGRect(x: bounds.minX, y: y - 1, width: bounds.width, height: 2)
            guard let text = page.selection(for: rect)?.string?.replacingOccurrences(of: "\n", with: " | ").trimmingCharacters(in: .whitespacesAndNewlines), text.count >= 4 else { continue }
            if seen.insert(text).inserted { result.append(Row(text: text, rect: rect)) }
        }
        return result
    }
    static func text(_ page: PDFPage) -> String {
        let original = page.string ?? ""
        guard original.range(of: "(?i)\\btable\\s*[0-9]+", options: .regularExpression) != nil else { return original }
        let layout = rows(page).map(\.text).joined(separator: "\n")
        // Fail conservatively if rectangular extraction lost most page content.
        guard layout.count > original.count / 2 else {
            return original + "\n【表格行布局未可靠恢复；禁止从此页扁平文本推断表格行列对应关系】"
        }
        return "【PDF 物理行布局；保留表格行标签。多栏或复杂合并单元格仍需核对；行列不明确时禁止报告单元格数字】\n" + layout
    }
    static func selection(_ quote: String, page: PDFPage) -> PDFSelection? {
        if let range = Evidence.quoteRange(quote, in: page.string ?? ""), let selection = page.selection(for: range) { return selection }
        let rows = rows(page)
        let layout = rows.map(\.text).joined(separator: "\n")
        guard let range = Evidence.quoteRange(quote, in: layout) else { return nil }
        var offset = 0, matched: [Row] = []
        for row in rows {
            let rowRange = NSRange(location: offset, length: (row.text as NSString).length)
            if NSIntersectionRange(range, rowRange).length > 0 { matched.append(row) }
            offset += rowRange.length + 1
        }
        guard let first = matched.first, let last = matched.last else { return nil }
        let bounds = page.bounds(for: .cropBox)
        let rect = CGRect(x: bounds.minX, y: last.rect.minY - 4, width: bounds.width, height: first.rect.maxY - last.rect.minY + 8)
        return page.selection(for: rect)
    }
}
