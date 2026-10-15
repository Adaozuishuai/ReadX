import Foundation

// GFM 管道表格的解析与渲染模型。
//
// 设计要点（保证「不猜」与「不崩」）：
// - 只把「表头行 + 分隔行 + 至少一行数据」识别为表格；缺分隔行则按普通段落处理；
// - 列数按表头决定；数据行多出的单元格丢弃（不静默改变列语义），少则补空；
// - 单元格内的 `\|` 视为转义管道符，不参与切分；
// - 对齐方式取自分隔行（:--- / :---: / ---:）。

enum TableAlignment: String, Equatable {
    case leading, center, trailing

    /// 从分隔行单元解析，如 `:---:` -> center
    static func parse(_ cell: String) -> TableAlignment {
        let t = cell.trimmingCharacters(in: .whitespaces)
        let left = t.hasPrefix(":")
        let right = t.hasSuffix(":")
        if left && right { return .center }
        if right { return .trailing }
        return .leading
    }
}

struct MarkdownTable: Equatable {
    var header: [String]
    var alignments: [TableAlignment]
    var rows: [[String]]
    var columnCount: Int { header.count }

    /// 是否为合法的分隔行：每格由 -、:、空格组成且至少一个 -。
    static func isDelimiterRow(_ line: String) -> Bool {
        let cells = splitRow(line)
        guard !cells.isEmpty else { return false }
        return cells.allSatisfy { cell in
            let t = cell.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { return false }
            let body = t.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return !body.isEmpty && body.allSatisfy { $0 == "-" }
        }
    }

    /// 切分单元格：支持 `\|` 转义，去掉首尾空格外层管道。
    static func splitRow(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t = String(t.dropFirst()) }
        if t.hasSuffix("|") { t = String(t.dropLast()) }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in t {
            if escaped {
                // 只对管道符还原转义；其它反斜杠保持原样
                if ch == "|" { current.append("|") } else { current.append("\\"); current.append(ch) }
                escaped = false
                continue
            }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" { cells.append(current.trimmingCharacters(in: .whitespaces)); current = ""; continue }
            current.append(ch)
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// 是否为表格起始：本行像表格行，且下一行是分隔行。
    static func starts(at lines: [String], index: Int) -> Bool {
        guard index + 1 < lines.count else { return false }
        let head = lines[index].trimmingCharacters(in: .whitespaces)
        guard head.hasPrefix("|") || head.contains("|") else { return false }
        return isDelimiterRow(lines[index + 1])
    }

    /// 从 lines[start...] 解析表格，返回表格与消耗的行数。解析失败返回 nil。
    static func parse(lines: [String], start: Int) -> (MarkdownTable, Int)? {
        guard starts(at: lines, index: start) else { return nil }
        let header = splitRow(lines[start])
        guard !header.isEmpty, header.contains(where: { !$0.isEmpty }) else { return nil }
        let alignments = splitRow(lines[start + 1]).map(TableAlignment.parse)
        // 对齐数按表头列数对齐
        let cols = header.count
        var normalizedAlign = alignments
        if normalizedAlign.count < cols {
            normalizedAlign += Array(repeating: TableAlignment.leading, count: cols - normalizedAlign.count)
        } else if normalizedAlign.count > cols {
            normalizedAlign = Array(normalizedAlign.prefix(cols))
        }
        var rows: [[String]] = []
        var i = start + 2
        while i < lines.count {
            let raw = lines[i]
            let t = raw.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { break }             // 空行结束表格
            guard t.hasPrefix("|") || t.contains("|") else { break }
            guard !isDelimiterRow(t) else { break }      // 多余的连续分隔行视为结束
            var cells = splitRow(raw)
            // 列数对齐：多出的丢弃（不改列语义），少的补空
            if cells.count > cols { cells = Array(cells.prefix(cols)) }
            if cells.count < cols { cells += Array(repeating: "", count: cols - cells.count) }
            rows.append(cells)
            i += 1
        }
        guard !rows.isEmpty else { return nil }
        return (MarkdownTable(header: header, alignments: normalizedAlign, rows: rows), i - start)
    }

    /// 导出为对齐的纯文本（用于复制 / 无表格能力的环境回退）。
    func plainText() -> String {
        func width(_ col: Int) -> Int {
            var w = header.indices.contains(col) ? header[col].count : 0
            for r in rows where r.indices.contains(col) { w = max(w, r[col].count) }
            return max(1, w)
        }
        let widths = (0..<columnCount).map(width)
        func pad(_ s: String, _ w: Int, _ a: TableAlignment) -> String {
            let diff = max(0, w - s.count)
            switch a {
            case .leading: return s + String(repeating: " ", count: diff)
            case .trailing: return String(repeating: " ", count: diff) + s
            case .center:
                let l = diff / 2
                return String(repeating: " ", count: l) + s + String(repeating: " ", count: diff - l)
            }
        }
        var out = "| " + (0..<columnCount).map { pad(header[$0], widths[$0], alignments[$0]) }.joined(separator: " | ") + " |"
        out += "\n|" + widths.map { String(repeating: "-", count: $0 + 2) }.joined(separator: "|") + "|"
        for r in rows {
            out += "\n| " + (0..<columnCount).map { pad(r[$0], widths[$0], alignments[$0]) }.joined(separator: " | ") + " |"
        }
        return out
    }
}
