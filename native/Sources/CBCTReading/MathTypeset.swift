import SwiftUI
import Foundation

// MARK: - 轻量 LaTeX 排版引擎（离线、无依赖）
//
// 设计原则（与项目"不猜、可核对"一致）：
// - 只排版能确定的结构；遇到不认识的命令立即标记 unsupported，整式降级为原始 LaTeX 展示，
//   绝不半渲染半猜测，避免把错的公式渲染得像对的；
// - 行内公式与独立公式块共用同一棵节点树，只是容器与缩放策略不同；
// - 宽度用纯函数估算（不依赖 SwiftUI 布局测量），据此决定缩放或横向滚动，保证不溢出容器。

indirect enum MathNode {
    case text(String)                              // 普通字符/数字/运算符（已做 Unicode 归一）
    case upright(String)                           // 正体：函数名、\text{}、单位
    case symbol(String)                            // 希腊字母等（斜体）
    case bigOp(String, sub: MathNode?, sup: MathNode?)   // ∑ ∫ ∏：上下限
    case script(base: MathNode, sub: MathNode?, sup: MathNode?)  // 上下标
    case frac(MathNode, MathNode)
    case root(MathNode, index: MathNode?)          // 根号（index 为 nil 时是平方根）
    case overline(MathNode)
    case group([MathNode])
    case accent(MathNode, String)                  // \hat \bar \tilde \vec
    case bold(MathNode)
    case blackboard(MathNode)
    case calligraphic(String)
    case unsupported(String)

    var isUnsupported: Bool {
        switch self {
        case .unsupported: return true
        case .text, .upright, .symbol, .calligraphic: return false
        case .bigOp(_, let sub, let sup): return (sub?.isUnsupported ?? false) || (sup?.isUnsupported ?? false)
        case .script(let base, let sub, let sup): return base.isUnsupported || (sub?.isUnsupported ?? false) || (sup?.isUnsupported ?? false)
        case .frac(let a, let b): return a.isUnsupported || b.isUnsupported
        case .root(let a, let i): return a.isUnsupported || (i?.isUnsupported ?? false)
        case .overline(let a): return a.isUnsupported
        case .group(let items): return items.contains { $0.isUnsupported }
        case .accent(let a, _): return a.isUnsupported
        case .bold(let a): return a.isUnsupported
        case .blackboard(let a): return a.isUnsupported
        }
    }
}

enum MathLex {
    /// 常见命令 → Unicode。未收录的命令返回 nil（调用方标记 unsupported）。
    static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε",
        "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
        "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ",
        "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
        "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "ell": "ℓ", "hbar": "ℏ", "imath": "ı", "jmath": "ȷ",
        "times": "×", "cdot": "⋅", "ast": "∗", "star": "⋆", "circ": "∘", "bullet": "•",
        "div": "÷", "pm": "±", "mp": "∓", "oplus": "⊕", "ominus": "⊖", "otimes": "⊗",
        "oslash": "⊘", "odot": "⊙", "dagger": "†", "ddagger": "‡",
        "leq": "≤", "geq": "≥", "le": "≤", "ge": "≥", "neq": "≠", "ne": "≠", "approx": "≈",
        "equiv": "≡", "sim": "∼", "simeq": "≃", "propto": "∝", "ll": "≪", "gg": "≫",
        "in": "∈", "notin": "∉", "ni": "∋", "subset": "⊂", "subseteq": "⊆", "supset": "⊃",
        "cup": "∪", "cap": "∩", "setminus": "∖", "emptyset": "∅",
        "rightarrow": "→", "leftarrow": "←", "leftrightarrow": "↔", "Rightarrow": "⇒",
        "Leftarrow": "⇐", "Leftrightarrow": "⇔", "mapsto": "↦", "to": "→",
        "uparrow": "↑", "downarrow": "↓",
        "nabla": "∇", "partial": "∂", "infty": "∞", "forall": "∀", "exists": "∃",
        "neg": "¬", "land": "∧", "lor": "∨", "perp": "⊥", "top": "⊤", "angle": "∠", "prime": "′",
        "dots": "…", "ldots": "…", "cdots": "⋯", "vdots": "⋮", "ddots": "⋱",
        "deg": "°", "lceil": "⌈", "rceil": "⌉", "lfloor": "⌊", "rfloor": "⌋",
        "langle": "⟨", "rangle": "⟩", "Vert": "‖", "vert": "∣", "|": "‖",
        "lVert": "‖", "rVert": "‖", "lvert": "∣", "rvert": "∣",
        "sum": "∑", "prod": "∏", "coprod": "∐", "int": "∫", "iint": "∬", "iiint": "∭",
        "oint": "∮", "bigcup": "⋃", "bigcap": "⋂", "bigoplus": "⨁", "bigodot": "⨀",
        "quad": "    ", "qquad": "        ", ",": " ", ";": " ", ":": " ", "!": "",
        "{": "{", "}": "}", "\\": "  ", "$": "$", "%": "%", "&": "  ", "#": "#", "_": "_",
    ]
    static let uprightFunctions: Set<String> = [
        "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
        "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
        "min", "max", "arg", "arginf", "sup", "inf", "lim", "limsup", "liminf",
        "det", "dim", "ker", "deg", "gcd", "Pr", "tr", "diag", "rank", "sgn",
    ]
    static let blackboard: [String: String] = ["R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "E": "𝔼", "P": "ℙ", "H": "ℍ"]
    static let calligraphicCharacters = Dictionary(uniqueKeysWithValues: zip(
        Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"),
        Array("𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏")
    ))
    static let blackboardCharacters: [Character: Character] = {
        let upperFrom = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        let upperTo = Array("𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ")
        let lowerFrom = Array("abcdefghijklmnopqrstuvwxyz")
        let lowerTo = Array("𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫")
        return Dictionary(uniqueKeysWithValues: zip(upperFrom + lowerFrom, upperTo + lowerTo))
    }()
    /// 需要上下限排布的大算子
    static let bigOps: Set<String> = ["sum", "prod", "coprod", "int", "iint", "iiint", "oint",
                                      "bigcup", "bigcap", "bigoplus", "bigodot"]
    static let accents: [String: String] = ["hat": "^", "bar": "‾", "tilde": "~", "vec": "→", "dot": "˙", "ddot": "¨"]
}

struct MathParser {
    private let chars: [Character]
    private var pos = 0

    private init(_ latex: String) { chars = Array(latex) }

    /// 解析一段 LaTeX。supported=false 时调用方必须降级展示原始源码。
    static func parse(_ latex: String) -> (nodes: [MathNode], supported: Bool) {
        var parser = MathParser(latex)
        let nodes = parser.parseGroup(until: nil)
        return (nodes, !nodes.contains { $0.isUnsupported })
    }

    private var current: Character? { pos < chars.count ? chars[pos] : nil }

    private mutating func parseGroup(until terminator: Character?) -> [MathNode] {
        var out: [MathNode] = []
        while let ch = current {
            if let terminator, ch == terminator { pos += 1; return out }
            if let node = parseNode() { out.append(node) }
        }
        return out
    }

    private mutating func parseNode() -> MathNode? {
        guard let ch = current else { return nil }
        switch ch {
        case "{":
            pos += 1
            let items = parseGroup(until: "}")
            return .group(items)
        case "}":
            pos += 1  // 多余右括号：忽略而不是崩
            return nil
        case "^", "_":
            pos += 1
            let script = parseSingle()
            // 孤立的上/下标（没有底数）：按上下标挂在空组上，保持视觉位置
            return ch == "^" ? .script(base: .group([]), sub: nil, sup: script) : .script(base: .group([]), sub: script, sup: nil)
        default:
            let node = parseSingle()
            // 处理紧跟的上下标
            if let next = current, next == "^" || next == "_" {
                var sub: MathNode?, sup: MathNode?
                while let n = current, n == "^" || n == "_" {
                    pos += 1
                    let value = parseSingle()
                    if n == "^" { sup = value } else { sub = value }
                }
                switch node {
                case .bigOp(let op, let s, let p):
                    return .bigOp(op, sub: sub ?? s, sup: sup ?? p)
                default:
                    return .script(base: node, sub: sub, sup: sup)
                }
            }
            return node
        }
    }

    /// 解析一个"原子"：命令、单个字符，或 {...} 组
    private mutating func parseSingle() -> MathNode {
        guard let ch = current else { return .text("") }
        if ch == "\\" { return parseCommand() }
        if ch == "{" { pos += 1; return .group(parseGroup(until: "}")) }
        pos += 1
        return .text(String(ch))
    }

    private mutating func readCommand() -> String {
        pos += 1 // 跳过反斜杠
        var name = ""
        while let ch = current, ch.isLetter { name.append(ch); pos += 1 }
        if name.isEmpty, let ch = current, !ch.isWhitespace, !ch.isNewline {
            // 单字符命令（\, \; \{ 等）
            name = String(ch); pos += 1
        }
        return name
    }

    private mutating func parseCommand() -> MathNode {
        let name = readCommand()
        guard !name.isEmpty else { return .text("") }
        switch name {
        case "frac", "dfrac", "tfrac", "cfrac":
            let a = parseSingle(); let b = parseSingle()
            return .frac(a, b)
        case "sqrt":
            // \sqrt[n]{x} 形式：可选的方括号参数
            if current == "[" {
                pos += 1
                var raw = ""
                while let ch = current, ch != "]" { raw.append(ch); pos += 1 }
                if current == "]" { pos += 1 }
                let index = MathParser.parse(raw).nodes
                return .root(parseSingle(), index: .group(index))
            }
            return .root(parseSingle(), index: nil)
        case "overline":
            return .overline(parseSingle())
        case "underline":
            return .overline(parseSingle())   // 视觉上同为一条线，标注为待核对由外层负责
        case "mathbf", "bm", "boldsymbol":
            return .bold(parseSingle())
        case "mathbb":
            let inner = flatten(parseSingle())
            return .text(inner.map { String(MathLex.blackboardCharacters[$0] ?? $0) }.joined())
        case "mathcal", "mathscr":
            let inner = flatten(parseSingle())
            return .calligraphic(inner.map { String(MathLex.calligraphicCharacters[$0] ?? $0) }.joined())
        case "mathit":
            return .text(flatten(parseSingle()))
        case "mathrm", "mathsf", "mathtt", "text", "textrm", "operatorname", "mbox":
            let inner = parseSingle()
            return .upright(flatten(inner))
        case "bmod", "mod":
            return .upright("mod")
        case "left", "right", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr":
            // 定界符：跳过命令本身，正常渲染后面的括号/符号
            if let node = parseSingleOrDelimiter() { return node }
            return .group([])
        case "begin", "end":
            // 矩阵/多行环境：不作猜测，标记不支持
            return .unsupported("\\" + name)
        default:
            if let accent = MathLex.accents[name] { return .accent(parseSingle(), accent) }
            if let symbol = MathLex.symbols[name] {
                if MathParser.bigOps.contains(name) { return .bigOp(symbol, sub: nil, sup: nil) }
                return .symbol(symbol)
            }
            if MathLex.uprightFunctions.contains(name) { return .upright(name) }
            if let bb = MathLex.blackboard[name] { return .text(bb) }
            return .unsupported("\\" + name)
        }
    }

    private static let bigOps: Set<String> = ["sum", "prod", "coprod", "int", "iint", "iiint", "oint",
                                              "bigcup", "bigcap", "bigoplus", "bigodot"]

    private mutating func parseSingleOrDelimiter() -> MathNode? {
        guard let ch = current else { return nil }
        if ch == "\\" { return parseCommand() }
        if ch == "." { pos += 1; return .group([]) }  // \left. 空定界符
        pos += 1
        return .text(String(ch))
    }

    private func flatten(_ node: MathNode) -> String {
        switch node {
        case .text(let s), .upright(let s), .symbol(let s), .calligraphic(let s): return s
        case .group(let items): return items.map(flatten).joined()
        case .bold(let a), .blackboard(let a), .overline(let a): return flatten(a)
        case .accent(let a, _): return flatten(a)
        case .script(let base, _, _): return flatten(base)
        case .frac(let a, _): return flatten(a)
        case .root(let a, _): return flatten(a)
        case .bigOp(let op, _, _): return op
        case .unsupported(let raw): return raw
        }
    }
}

// MARK: - 宽度估算（纯函数，供缩放与滚动决策）

enum MathMetrics {
    /// 估算节点在给定字号下的宽度（点）。用于"不溢出容器"的缩放判断，不追求精确。
    static func width(_ nodes: [MathNode], size: CGFloat) -> CGFloat {
        nodes.reduce(0) { $0 + width($1, size: size) }
    }
    static func width(_ node: MathNode, size: CGFloat) -> CGFloat {
        switch node {
        case .text(let s), .upright(let s), .symbol(let s), .calligraphic(let s):
            return CGFloat(s.count) * size * 0.52
        case .bigOp(let op, let sub, let sup):
            let limits = max(sub.map { width($0, size: size * 0.7) } ?? 0, sup.map { width($0, size: size * 0.7) } ?? 0)
            return max(size * 0.9, limits)
        case .script(let base, let sub, let sup):
            let b = width(base, size: size)
            let s = max(sub.map { width($0, size: size * 0.7) } ?? 0, sup.map { width($0, size: size * 0.7) } ?? 0)
            return b + s * 0.85
        case .frac(let a, let b):
            return max(width(a, size: size * 0.95), width(b, size: size * 0.95)) + size * 0.3
        case .root(let a, let index):
            return width(a, size: size) + size * 0.8 + (index.map { width($0, size: size * 0.6) } ?? 0)
        case .overline(let a), .bold(let a), .blackboard(let a):
            return width(a, size: size) + size * 0.1
        case .accent(let a, _):
            return width(a, size: size)
        case .group(let items):
            return width(items, size: size)
        case .unsupported(let raw):
            return CGFloat(raw.count) * size * 0.5
        }
    }
    /// 估算高度（用于独立公式块的留白）
    static func height(_ nodes: [MathNode], size: CGFloat) -> CGFloat {
        nodes.reduce(0) { max($0, height($1, size: size)) }
    }
    static func height(_ node: MathNode, size: CGFloat) -> CGFloat {
        switch node {
        case .frac(let numerator, let denominator):
            return height(numerator, size: size * 0.92) + height(denominator, size: size * 0.92) + size * 0.3
        case .root(let radicand, let index):
            return max(height(radicand, size: size) + size * 0.3, index.map { height($0, size: size * 0.55) + size * 0.6 } ?? 0)
        case .bigOp(_, let sub, let sup):
            return size * 1.7 + (sub.map { height($0, size: size * 0.7) } ?? 0) + (sup.map { height($0, size: size * 0.7) } ?? 0) + size * 0.15
        case .script(let base, let sub, let sup):
            let scripts = max(sub.map { height($0, size: size * 0.7) } ?? 0, sup.map { height($0, size: size * 0.7) } ?? 0)
            return max(height(base, size: size), scripts + size * 0.9) + size * 0.6
        case .group(let items): return height(items, size: size)
        case .bold(let inner), .blackboard(let inner): return height(inner, size: size)
        case .overline(let inner): return height(inner, size: size) + size * 0.15
        case .accent(let inner, _): return height(inner, size: size) + size * 0.75
        default: return size * 1.25
        }
    }
}

// MARK: - 渲染

struct MathView: View {
    var latex: String
    var size: CGFloat = 15
    var color: Color = .ink

    private var parsed: (nodes: [MathNode], supported: Bool) { MathParser.parse(latex) }

    var body: some View {
        let result = parsed
        Group {
            if !result.supported || result.nodes.isEmpty {
                // 降级：不猜测结构，直接展示原始 LaTeX（等宽、可选中可复制）
                MathFallbackView(latex: latex, size: size)
            } else {
                MathRow(nodes: Array(result.nodes), size: size, color: color)
            }
        }
    }
}

struct MathFallbackView: View {
    var latex: String
    var size: CGFloat
    @State private var showSource = false
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("该公式无法完整排版，已收起源码；请对照原文核对").font(.system(size: 10)).foregroundColor(.gold)
            // 用户要求公式不明文展示：源码默认收起，需要时手动展开
            DisclosureGroup(isExpanded: $showSource) {
                Text(latex)
                    .font(.system(size: max(11, size - 1), design: .monospaced))
                    .foregroundColor(.ink)
                    .textSelection(.enabled)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
            } label: {
                Text(showSource ? "收起源码" : "查看源码").font(.system(size: 10, weight: .medium)).foregroundColor(.inkSoft)
            }
        }
    }
}

struct MathRow: View {
    var nodes: [MathNode]
    var size: CGFloat
    var color: Color

    var body: some View {
        HStack(alignment: .center, spacing: size * 0.06) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { _, node in
                MathNodeView(node: node, size: size, color: color)
            }
        }
    }
}

struct MathNodeView: View {
    var node: MathNode
    var size: CGFloat
    var color: Color

    // This recursive syntax tree needs a type-erasure boundary. SwiftUI otherwise
    // recursively queries _viewListCount through MathNodeView's static body type
    // before even inspecting the current node, overflowing the main-thread stack.
    var body: AnyView { AnyView(content) }

    @ViewBuilder private var content: some View {
        switch node {
        case .text(let s):
            mathText(s, italic: true)
        case .symbol(let s):
            mathText(s, italic: true)
        case .calligraphic(let s):
            Text(s).font(.system(size: size, design: .serif)).foregroundColor(color)
        case .upright(let s):
            mathText(s, italic: false)
        case .group(let items):
            MathRow(nodes: items, size: size, color: color)
        case .bold(let inner):
            MathNodeView(node: inner, size: size, color: color).fontWeight(.bold)
        case .blackboard(let inner):
            MathNodeView(node: inner, size: size, color: color)
        case .accent(let inner, let accent):
            VStack(spacing: 0) {
                Text(accent).font(.system(size: size * 0.62, design: .serif)).foregroundColor(color)
                    .scaleEffect(y: 0.9)
                MathNodeView(node: inner, size: size, color: color).offset(y: -size * 0.12)
            }
        case .script(let base, let sub, let sup):
            scriptView(base: base, sub: sub, sup: sup)
        case .bigOp(let op, let sub, let sup):
            bigOpView(op: op, sub: sub, sup: sup)
        case .frac(let a, let b):
            fracView(a: a, b: b)
        case .root(let a, let index):
            rootView(a: a, index: index)
        case .overline(let a):
            VStack(spacing: 1) {
                Rectangle().fill(color).frame(height: max(0.6, size * 0.05))
                    .padding(.horizontal, size * 0.02)
                MathNodeView(node: a, size: size, color: color)
            }
        case .unsupported(let raw):
            Text(raw).font(.system(size: size * 0.85, design: .monospaced)).foregroundColor(.gold)
        }
    }

    private func mathText(_ s: String, italic: Bool) -> some View {
        Text(s)
            .font(.system(size: size, design: .serif))
            .italic(italic && s.rangeOfCharacter(from: .letters) != nil)
            .foregroundColor(color)
    }

    private func scriptView(base: MathNode, sub: MathNode?, sup: MathNode?) -> some View {
        HStack(alignment: .center, spacing: 0) {
            MathNodeView(node: base, size: size, color: color)
            ZStack(alignment: .leading) {
                if let sup { MathNodeView(node: sup, size: size * 0.7, color: color).offset(y: -size * 0.45) }
                if let sub { MathNodeView(node: sub, size: size * 0.7, color: color).offset(y: size * 0.45) }
            }
            .frame(height: max(sub.map { MathMetrics.height($0, size: size * 0.7) } ?? 0,
                               sup.map { MathMetrics.height($0, size: size * 0.7) } ?? 0))
        }
        .padding(.vertical, size * 0.3)
    }

    private func bigOpView(op: String, sub: MathNode?, sup: MathNode?) -> some View {
        VStack(spacing: size * 0.02) {
            if let sup { MathNodeView(node: sup, size: size * 0.7, color: color) }
            Text(op).font(.system(size: size * 1.35, design: .serif)).foregroundColor(color)
            if let sub { MathNodeView(node: sub, size: size * 0.7, color: color) }
        }
    }

    private func fracView(a: MathNode, b: MathNode) -> some View {
        VStack(spacing: size * 0.08) {
            MathNodeView(node: a, size: size * 0.92, color: color)
            Rectangle().fill(color).frame(height: max(0.7, size * 0.055))
            MathNodeView(node: b, size: size * 0.92, color: color)
        }
        .frame(minWidth: size * 0.7)
    }

    private func rootView(a: MathNode, index: MathNode?) -> some View {
        HStack(alignment: .center, spacing: 0) {
            if let index {
                MathNodeView(node: index, size: size * 0.55, color: color).offset(x: size * 0.14, y: -size * 0.28)
            }
            Text("√").font(.system(size: size * 1.15, design: .serif)).foregroundColor(color)
            VStack(spacing: 0) {
                Rectangle().fill(color).frame(height: max(0.6, size * 0.05)).padding(.top, size * 0.12)
                MathNodeView(node: a, size: size, color: color).padding(.horizontal, size * 0.06)
            }
        }
    }
}

/// 独立公式块：居中、不溢出（放不下则横向滚动）、可复制与查看原始 LaTeX。
/// 高度必须由内容自然决定：旧版用 MathMetrics 估算值 + GeometryReader 定框，
/// 上下标/分式/大算子的真实高度超过估算，宽屏（scale≈1）时公式会叠到按钮与后文上。
struct MathBlockView: View {
    var latex: String
    var size: CGFloat = 16
    @State private var copied = false

    var body: some View {
        let parsed = MathParser.parse(latex)
        VStack(alignment: .center, spacing: 6) {
            if parsed.supported && !parsed.nodes.isEmpty {
                // 宽度放得下就按原始大小居中；放不下走横向滚动兜底（ViewThatFits 未命中时用最后一个子视图）。
                // 不再做估算缩放：缩放比依赖估算宽度，且定框高度永远跟不上真实渲染高度。
                ViewThatFits(in: .horizontal) {
                    MathRow(nodes: parsed.nodes, size: size, color: .ink)
                        .fixedSize()
                        .frame(maxWidth: .infinity, alignment: .center)
                    ScrollView(.horizontal, showsIndicators: false) {
                        MathRow(nodes: parsed.nodes, size: size, color: .ink)
                            .fixedSize()
                            .padding(.vertical, 2)
                    }
                }
            } else {
                // 必须整式回退；不能把树中可识别的片段单独渲染出来。
                MathFallbackView(latex: latex, size: size)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 8) {
                Button(copied ? "已复制" : "复制") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(latex, forType: .string)
                    copied = true
                }.buttonStyle(FunButtonStyle(small: true))
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 0.985, green: 0.978, blue: 0.955)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.line, lineWidth: 1))
    }
}

/// 行内公式：与正文同基线排布，超宽时逐级缩小字号（缩字号而非 scaleEffect，
/// 高度始终由真实排版决定，不依赖估算），仍放不下则横向滚动。
struct MathInlineView: View {
    var latex: String
    var size: CGFloat = 14
    var body: some View {
        let parsed = MathParser.parse(latex)
        if parsed.supported && !parsed.nodes.isEmpty {
            ViewThatFits(in: .horizontal) {
                MathRow(nodes: parsed.nodes, size: size, color: .ink).fixedSize()
                MathRow(nodes: parsed.nodes, size: size * 0.85, color: .ink).fixedSize()
                MathRow(nodes: parsed.nodes, size: size * 0.72, color: .ink).fixedSize()
                ScrollView(.horizontal, showsIndicators: false) {
                    MathRow(nodes: parsed.nodes, size: size, color: .ink).fixedSize()
                }
            }
        } else {
                MathFallbackView(latex: latex, size: size)
        }
    }
}
