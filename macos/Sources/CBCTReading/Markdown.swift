import SwiftUI

// MARK: - 迷你 Markdown 渲染（与笔记格式约定一致）

enum MDBlock {
    case heading(String, Int)
    case paragraph([String])          // 段落行
    case quote([String])
    case bullets([String])
    case ordered([String])
    case table(MarkdownTable)
    /// 水平分隔线（--- / *** / ___）。原先被当成普通段落，会在正文里显示字面量。
    case rule
    /// 独立公式块（$$…$$ / \[…\]）
    case mathBlock(String)
}

enum Markdown {
    static func parse(_ src: String) -> [MDBlock] {
        var blocks: [MDBlock] = []
        var kind: MDBlock?
        var buf: [String] = []
        func flush() {
            switch kind {
            case .heading(let t, let l): blocks.append(.heading(t, l))
            case .quote: blocks.append(.quote(buf))
            case .bullets: blocks.append(.bullets(buf))
            case .ordered: blocks.append(.ordered(buf))
            case .paragraph: if !buf.isEmpty { blocks.append(.paragraph(buf)) }
            case .mathBlock(let latex): blocks.append(.mathBlock(latex))
            case .table, .rule, nil: break
            }
            buf = []
            kind = nil
        }
        let lines = src.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var idx = 0
        while idx < lines.count {
            let line = lines[idx]
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { flush(); idx += 1; continue }
            // 独立公式块：整行以 $$ 或 \[ 开头。可能跨多行，直到出现闭合定界符。
            if t.hasPrefix("$$") || t.hasPrefix("\\[") {
                flush()
                if let found = collectMathBlock(lines: lines, start: idx) {
                    blocks.append(.mathBlock(found.latex))
                    idx = found.next
                    continue
                }
            }
            if t.hasPrefix("### ") { flush(); blocks.append(.heading(String(t.dropFirst(4)), 3)); idx += 1; continue }
            if t.hasPrefix("## ") { flush(); blocks.append(.heading(String(t.dropFirst(3)), 2)); idx += 1; continue }
            if t.hasPrefix("# ") { flush(); blocks.append(.heading(String(t.dropFirst(2)), 1)); idx += 1; continue }
            // 水平分隔线：--- / *** / ___（至少 3 个相同字符，允许空格）
            if isHorizontalRule(t) { flush(); blocks.append(.rule); idx += 1; continue }
            // 孤立的表格分隔行（如只有表头+分隔行、没有数据行）：
            // 不能让它并进上一段，否则会显示成 "| A | B | |---|---|" 这类糊在一起的一行。
            if MarkdownTable.isDelimiterRow(t) {
                flush()
                blocks.append(.paragraph([t]))
                idx += 1
                continue
            }
            // 表格：必须在段落判定之前，否则整块会被并进 paragraph
            if let (table, consumed) = MarkdownTable.parse(lines: lines, start: idx) {
                flush()
                blocks.append(.table(table))
                idx += consumed
                continue
            }
            if t.hasPrefix("> ") || t == ">" {
                if case .quote = kind { buf.append(String(t.dropFirst(2))) } else { flush(); kind = .quote([]); buf.append(String(t.dropFirst(2))) }
                idx += 1
                continue
            }
            if t.hasPrefix("- ") || t.hasPrefix("* ") {
                if case .bullets = kind { buf.append(String(t.dropFirst(2))) } else { flush(); kind = .bullets([]); buf.append(String(t.dropFirst(2))) }
                idx += 1
                continue
            }
            // 有序列表：点号前必须全是数字、点号后必须紧跟空格。
            // 只判「首字符是数字 + 点号在前 2 字符内」会把小数与编号章节误判成列表，
            // 并把首个数字连同小数点一起吃掉（0.5 mm -> 列表项 "5 mm"），见回归测试。
            if let dot = t.firstIndex(of: "."),
               dot != t.startIndex,
               t[t.startIndex..<dot].allSatisfy(\.isNumber),
               t.distance(from: t.startIndex, to: dot) <= 2,
               t.index(after: dot) < t.endIndex,
               t[t.index(after: dot)] == " " {
                let body = String(t[t.index(after: dot)...]).trimmingCharacters(in: .whitespaces)
                if case .ordered = kind { buf.append(body) } else { flush(); kind = .ordered([]); buf.append(body) }
                idx += 1
                continue
            }
            if case .paragraph = kind { buf.append(t) } else { flush(); kind = .paragraph([]); buf.append(t) }
            idx += 1
        }
        flush()
        return blocks
    }

    /// 收集独立公式块：从 start 行开始，直到闭合定界符（$$ 或 \]）。
    /// 返回 (latex, nextIndex)；未闭合时返回 nil，交给常规解析按普通文本处理（不吞掉正文）。
    static func collectMathBlock(lines: [String], start: Int) -> (latex: String, next: Int)? {
        let first = lines[start].trimmingCharacters(in: .whitespaces)
        let isDoubleDollar = first.hasPrefix("$$")
        let open = isDoubleDollar ? "$$" : "\\["
        let close = isDoubleDollar ? "$$" : "\\]"
        var body = String(first.dropFirst(open.count))
        // 同一行内已闭合
        if let range = body.range(of: close) {
            return (String(body[body.startIndex..<range.lowerBound]).trimmingCharacters(in: .whitespaces), start + 1)
        }
        var idx = start + 1
        var parts = [body]
        while idx < lines.count {
            let line = lines[idx]
            if let range = line.range(of: close) {
                parts.append(String(line[line.startIndex..<range.lowerBound]))
                let latex = parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                return (latex, idx + 1)
            }
            parts.append(line)
            idx += 1
            if idx - start > 12 { break }   // 防止吞掉整篇文档
        }
        return nil
    }

    /// 水平分隔线：--- / *** / ___（也可写成 - - -），至少 3 个相同字符。
    /// 注意必须排除表格分隔行（含 |），否则表格会被误判成 hr。
    static func isHorizontalRule(_ t: String) -> Bool {
        let body = t.replacingOccurrences(of: " ", with: "")
        guard !body.contains("|"), body.count >= 3 else { return false }
        return body.allSatisfy { $0 == "-" } || body.allSatisfy { $0 == "*" } || body.allSatisfy { $0 == "_" }
    }

    static func inline(_ s: String, size: CGFloat = 15) -> Text {
        var attr = AttributedString(s.isEmpty ? " " : s)
        if let parsed = try? AttributedString(
            markdown: s,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) { attr = parsed }
        return Text(attr).font(.system(size: size, design: .serif))
    }
}

struct MarkdownView: View {
    let src: String
    var size: CGFloat = Typography.body
    var onSelection: ((String, String) -> Void)? = nil
    /// 表格是否用等宽纯文本回退（用于不支持横向滚动的窄容器）。
    var plainTables = false

    var body: some View {
        let blocks = Markdown.parse(src)
        VStack(alignment: .leading, spacing: Typography.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let t, let level):
                    VStack(alignment: .leading, spacing: 4) {
                        Markdown.inline(t, size: Typography.heading(level))
                            .bold()
                            .foregroundColor(level <= 2 ? Color.teal : Color.accent)
                        if level <= 2 { Divider().overlay(Color.line) }
                    }
                    .padding(.top, level <= 2 ? 4 : 0)
                case .paragraph(let lines):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                            // 行内公式参与排版：正文保持 Markdown 行内语法，公式按 LaTeX 渲染
                            RichLineView(text: l, size: size)
                        }
                    }
                case .quote(let lines):
                    HStack(alignment: .top, spacing: 10) {
                        RoundedRectangle(cornerRadius: 2).fill(Color.accent.opacity(0.5)).frame(width: 3)
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, l in
                                RichLineView(text: l, size: size - 0.5)
                            }
                        }
                    }
                    .foregroundColor(.secondary)
                    .padding(.vertical, 6).padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(red: 0.94, green: 0.92, blue: 0.87)))
                case .bullets(let items):
                    VStack(alignment: .leading, spacing: Typography.itemSpacing) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .top, spacing: 8) {
                                Text("•").foregroundColor(Color.accent)
                                RichLineView(text: item, size: size)
                            }
                        }
                    }
                case .ordered(let items):
                    VStack(alignment: .leading, spacing: Typography.itemSpacing) {
                        ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                            HStack(alignment: .top, spacing: 8) {
                                Text("\(i + 1).")
                                    .foregroundColor(.secondary)
                                    .font(.system(size: size - 1, design: .serif))
                                    .frame(minWidth: 18, alignment: .trailing)
                                RichLineView(text: item, size: size)
                            }
                        }
                    }
                case .mathBlock(let latex):
                    MathBlockView(latex: latex, size: max(14, size))
                case .table(let table):
                    if plainTables { MarkdownTablePlainView(table: table) }
                    else { MarkdownTableView(table: table, size: max(Typography.caption, size - 2)) }
                case .rule:
                    Divider().overlay(Color.line).padding(.vertical, 2)
                }
            }
        }
    }
}
