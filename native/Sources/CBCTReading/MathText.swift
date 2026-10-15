import SwiftUI

// MARK: - 文本与公式的分段、行内混排

enum MathSegment: Equatable {
    case text(String)
    case inlineMath(String)
    case blockMath(String)
}

enum MathSegmenter {
    /// 把一段文本切成 正文 / 行内公式 / 独立公式块。
    /// 支持 $$…$$、\[…\]、\(…\)、$…$；未闭合的定界符按普通文本处理（不吞掉正文）。
    static func split(_ text: String) -> [MathSegment] {
        var out: [MathSegment] = []
        var buffer = ""
        var i = text.startIndex
        func flushText() {
            if !buffer.isEmpty { out.append(.text(buffer)); buffer = "" }
        }
        while i < text.endIndex {
            let ch = text[i]
            if ch == "$" {
                let after = text.index(after: i)
                if after < text.endIndex, text[after] == "$" {
                    // $$ … $$ 独立公式块
                    let bodyStart = text.index(after: after)
                    if let end = text.range(of: "$$", range: bodyStart..<text.endIndex) {
                        flushText()
                        out.append(.blockMath(String(text[bodyStart..<end.lowerBound]).trimmingCharacters(in: .whitespaces)))
                        i = end.upperBound
                        continue
                    }
                    buffer.append("$$"); i = bodyStart; continue
                }
                // $ … $ 行内公式：不允许跨行，且 $ 后不能紧跟空白（避免误判货币/占位）
                if let end = text.range(of: "$", range: after..<text.endIndex) {
                    let body = String(text[after..<end.lowerBound])
                    if !body.isEmpty, body.first?.isWhitespace != true, !body.contains("\n") {
                        flushText()
                        out.append(.inlineMath(body))
                        i = end.upperBound
                        continue
                    }
                }
                buffer.append("$"); i = after; continue
            }
            if ch == "\\" {
                let after = text.index(after: i)
                if after < text.endIndex, text[after] == "[" {
                    let bodyStart = text.index(after: after)
                    if let end = text.range(of: "\\]", range: bodyStart..<text.endIndex) {
                        flushText()
                        out.append(.blockMath(String(text[bodyStart..<end.lowerBound]).trimmingCharacters(in: .whitespaces)))
                        i = end.upperBound
                        continue
                    }
                    buffer.append("\\["); i = bodyStart; continue
                }
                if after < text.endIndex, text[after] == "(" {
                    let bodyStart = text.index(after: after)
                    if let end = text.range(of: "\\)", range: bodyStart..<text.endIndex) {
                        flushText()
                        out.append(.inlineMath(String(text[bodyStart..<end.lowerBound])))
                        i = end.upperBound
                        continue
                    }
                    buffer.append("\\("); i = bodyStart; continue
                }
            }
            buffer.append(ch)
            i = text.index(after: i)
        }
        flushText()
        return out
    }

    /// 整行是否为独立公式（$$…$$ / \[…\]），供 Markdown 分块使用。
    static func blockMathLine(_ trimmed: String) -> String? {
        let t = trimmed.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("$$"), t.hasSuffix("$$"), t.count > 4 {
            return String(t.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
        }
        if t.hasPrefix("\\["), t.hasSuffix("\\]"), t.count > 4 {
            return String(t.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }
}

/// 把"简单"公式压成带 Unicode 上下标的纯文本，从而能放进 Text 里随正文换行。
/// 复杂结构（分数/根号/求和）返回 nil，改由行内视图排布。
enum MathFlatten {
    static let subscriptMap: [Character: Character] = [
        "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅",
        "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋",
        "a": "ₐ", "e": "ₑ", "o": "ₒ", "x": "ₓ", "h": "ₕ", "k": "ₖ",
        "l": "ₗ", "m": "ₘ", "n": "ₙ", "p": "ₚ", "s": "ₛ", "t": "ₜ",
        "i": "ᵢ", "j": "ⱼ", "r": "ᵣ", "u": "ᵤ", "v": "ᵥ",
    ]
    static let superscriptMap: [Character: Character] = [
        "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵",
        "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻",
        "n": "ⁿ", "i": "ⁱ", "T": "ᵀ", "t": "ᵗ", "*": "＊",
    ]

    static func unicode(_ nodes: [MathNode]) -> String? {
        var out = ""
        for node in nodes {
            guard let piece = flatten(node) else { return nil }
            out += piece
        }
        return out.isEmpty ? nil : out
    }

    private static func flatten(_ node: MathNode) -> String? {
        switch node {
        case .text(let s), .symbol(let s), .upright(let s), .calligraphic(let s):
            return s
        case .group(let items):
            return unicode(items)
        case .bold(let inner), .blackboard(let inner), .overline(let inner):
            return flatten(inner)
        case .accent(let inner, _):
            return flatten(inner)
        case .script(let base, let sub, let sup):
            guard var text = flatten(base) else { return nil }
            // LaTeX 惯例：下标在前、上标在后（x_i^2 显示为 xᵢ²）
            if let sub {
                guard let s = flatten(sub), let mapped = map(s, subscriptMap) else { return nil }
                text += mapped
            }
            if let sup {
                guard let s = flatten(sup), let mapped = map(s, superscriptMap) else { return nil }
                text += mapped
            }
            return text
        case .unsupported:
            return nil
        case .frac, .root, .bigOp:
            return nil   // 交给行内视图渲染
        }
    }

    private static func map(_ s: String, _ table: [Character: Character]) -> String? {
        var out = ""
        for ch in s {
            guard let mapped = table[ch] else { return nil }
            out.append(mapped)
        }
        return out.isEmpty ? nil : out
    }
}

extension Store {
    /// 从方法说明文本中提取 LaTeX 公式源码（行内 $…$ 与独立 $$…$$），供图旁就近排版。
    static func formulas(in text: String) -> [String] {
        MathSegmenter.split(text).compactMap { segment in
            switch segment {
            case .inlineMath(let latex), .blockMath(let latex):
                let trimmed = latex.trimmingCharacters(in: .whitespacesAndNewlines)
                return trimmed.isEmpty ? nil : trimmed
            case .text: return nil
            }
        }
    }

    /// 供图旁展示的文字摘要：取方法说明中前若干非空正文行。
    static func figureSummary(_ text: String, limit: Int = 3) -> String {
        let sourceLines = text.components(separatedBy: .newlines)
        var inFlow = false
        var lines: [String] = []
        for line in sourceLines {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty || trimmed == "---" { continue }
            if trimmed.hasPrefix("#") {
                if inFlow { break }
                inFlow = trimmed.localizedCaseInsensitiveContains("数据流") || trimmed.localizedCaseInsensitiveContains("pipeline")
                continue
            }
            guard inFlow else { continue }
            lines.append(trimmed)
            if lines.count >= limit { break }
        }
        // Legacy notes may not have an explicitly titled data-flow section. In that
        // case skip the generated title/disclaimer and use the first substantive line.
        if lines.isEmpty {
            lines = sourceLines.compactMap { line in
                let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !value.isEmpty, !value.hasPrefix("#"), value != "---",
                      !value.hasPrefix("以下严格按论文原文整理") else { return nil }
                return value
            }.prefix(limit).map { $0 }
        }
        let joined = lines.joined(separator: " ")
            .replacingOccurrences(of: "\\*\\*|`", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard joined.count > 160 else { return joined }
        return String(joined.prefix(160)) + "…"
    }
}

/// 行内混排布局：正文片段可自由换行，公式片段作为原子块，放不下时换到下一行。
/// 折行与高度必须出自同一套算法：sizeThatFits 与 placeSubviews 各自用「自己的宽度」
/// 重新计算，绝不跨调用缓存几何。SwiftUI 会用不同 proposal 多次探测 sizeThatFits，
/// 旧实现把最后一次探测的几何留给 placeSubviews 复用，宽度不一致时行高与真实折行
/// 对不上，相邻文字互相叠字（方法页签拉宽后暴露）。
struct FlowLayout: Layout {
    var spacing: CGFloat = 2
    var lineSpacing: CGFloat = 3

    private struct Arrangement { var height: CGFloat = 0; var frames: [CGRect] = [] }

    private func arranged(subviews: Subviews, maxWidth: CGFloat) -> Arrangement {
        var out = Arrangement(frames: Array(repeating: .zero, count: subviews.count))
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            let natural = subview.sizeThatFits(.unspecified)
            var width = natural.width
            if x > 0, x + width > maxWidth {
                x = 0
                y += rowHeight + lineSpacing
                rowHeight = 0
            }
            if width > maxWidth { width = maxWidth }
            let fitted = subview.sizeThatFits(ProposedViewSize(width: width, height: nil))
            out.frames[index] = CGRect(x: x, y: y, width: fitted.width, height: fitted.height)
            x += fitted.width + spacing
            rowHeight = max(rowHeight, fitted.height)
        }
        out.height = y + rowHeight
        return out
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        // 理想尺寸探测（无宽度提案）：按单行自然宽度计，不折行
        guard let proposedWidth = proposal.width, proposedWidth > 0, proposedWidth.isFinite else {
            let naturals = subviews.map { $0.sizeThatFits(.unspecified) }
            return CGSize(width: naturals.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, subviews.count - 1)),
                          height: naturals.map(\.height).max() ?? 0)
        }
        return CGSize(width: proposedWidth, height: arranged(subviews: subviews, maxWidth: proposedWidth).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let arrangement = arranged(subviews: subviews, maxWidth: bounds.width)
        for (index, frame) in arrangement.frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                proposal: ProposedViewSize(CGSize(width: frame.width, height: frame.height))
            )
        }
    }
}

/// 单行富文本：正文（保留 **粗体** 等 Markdown 行内语法）+ 行内公式，自动换行且不溢出。
struct RichLineView: View {
    var text: String
    var size: CGFloat = 15
    var color: Color = .ink

    private var segments: [MathSegment] { MathSegmenter.split(text) }

    var body: some View {
        FlowLayout(spacing: size * 0.08, lineSpacing: size * 0.18) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let s):
                    Markdown.inline(s, size: size)
                        .lineSpacing(Typography.bodyLineSpacing)
                        .fixedSize(horizontal: false, vertical: true)
                case .inlineMath(let latex):
                    inlineMath(latex)
                case .blockMath(let latex):
                    // 段落里出现独立公式时折行展示，避免挤在同一行
                    MathBlockView(latex: latex, size: size)
                }
            }
        }
    }

    @ViewBuilder
    private func inlineMath(_ latex: String) -> some View {
        let parsed = MathParser.parse(latex)
        if let plain = MathFlatten.unicode(parsed.nodes) {
            Text(plain)
                .font(.system(size: size, design: .serif).italic())
                .foregroundColor(color)
                .lineLimit(1).minimumScaleFactor(0.62)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            MathInlineView(latex: latex, size: size * 0.95)
        }
    }
}
