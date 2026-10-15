import Foundation

// 引用导出（PRD 4.13「引用导出」/ 8.3「支持导出个人 Library」）。
// 纯字符串函数：不依赖 UI，便于回归测试；NSSavePanel 只在外层包装。

enum CitationExport {
    /// BibTeX 转义：这些字符在 BibTeX 里有特殊含义，必须转义或加花括号保护。
    static func bibtexEscaped(_ s: String) -> String {
        var out = ""
        for ch in s {
            switch ch {
            case "\\": out += "\\textbackslash{}"
            case "&": out += "\\&"
            case "%": out += "\\%"
            case "$": out += "\\$"
            case "#": out += "\\#"
            case "_": out += "\\_"
            case "{": out += "\\{"
            case "}": out += "\\}"
            case "~": out += "\\textasciitilde{}"
            case "^": out += "\\textasciicircum{}"
            default: out.append(ch)
            }
        }
        return out
    }

    /// 引用键：优先 arXiv 号，其次 id，最后回退到标题。去掉 BibTeX 不允许的字符。
    static func citationKey(_ paper: QueueEntry) -> String {
        let raw = paper.arxiv?.isEmpty == false ? paper.arxiv! : (paper.id ?? paper.title ?? "paper")
        let cleaned = raw.unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == ":" || $0 == "-" }
            .map(String.init).joined()
        let key = cleaned.isEmpty ? "paper" : cleaned
        // 只有「完全由数字组成」的键才有问题（部分工具会把它当数字处理）；
        // arXiv 号形如 2209.14540，含点号，是合法且惯用的引用键，不加前缀。
        return key.allSatisfy(\.isNumber) ? "ref" + key : key
    }

    /// 「First Last」→「Last, First」；已是「Last, First」则原样返回。
    static func bibtexAuthor(_ raw: String) -> String {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return "" }
        if name.contains(",") { return name }
        let parts = name.split(separator: " ").map(String.init)
        guard parts.count >= 2 else { return name }
        let last = parts[parts.count - 1]
        let first = parts.dropLast().joined(separator: " ")
        return last + ", " + first
    }

    /// arXiv 发布的 `2026-09-30` / `2026-09` / `2026` 统一取年份。
    static func year(_ paper: QueueEntry) -> String {
        for candidate in [paper.published, paper.year] {
            guard let c = candidate else { continue }
            let digits = c.prefix(4).filter(\.isNumber)
            if digits.count == 4 { return String(digits) }
        }
        return ""
    }

    static func isArxiv(_ paper: QueueEntry) -> Bool {
        guard let a = paper.arxiv else { return false }
        return !a.isEmpty
    }

    /// 一条 @misc/@article。字段为空则整行不输出，避免生成 `author = {}` 这类脏数据。
    static func bibtex(_ paper: QueueEntry) -> String {
        var fields: [(String, String)] = []
        let authors = (paper.authors ?? []).map(bibtexAuthor).filter { !$0.isEmpty }
        if !authors.isEmpty { fields.append(("author", authors.joined(separator: " and "))) }
        if let t = paper.title, !t.isEmpty { fields.append(("title", "{" + bibtexEscaped(t) + "}")) }
        if let v = paper.venue, !v.isEmpty, v != "arXiv" { fields.append(("journal", bibtexEscaped(v))) }
        let y = year(paper)
        if !y.isEmpty { fields.append(("year", y)) }
        if isArxiv(paper) {
            fields.append(("eprint", paper.arxiv!))
            fields.append(("archivePrefix", "arXiv"))
        }
        if let d = paper.doi, !d.isEmpty { fields.append(("doi", bibtexEscaped(d))) }
        if let u = paper.pdfUrl, !u.isEmpty { fields.append(("url", bibtexEscaped(u))) }

        let type = isArxiv(paper) ? "misc" : "article"
        let body = fields.map { "  \($0.0) = {\($0.1)}" }.joined(separator: ",\n")
        return "@\(type){\(citationKey(paper)),\n\(body)\n}"
    }

    /// RIS 没有标题字段时退化为 `TY - GEN`（generic），避免输出空 TI。
    static func ris(_ paper: QueueEntry) -> String {
        var lines: [String] = []
        let hasTitle = (paper.title?.isEmpty == false)
        lines.append("TY  - " + (isArxiv(paper) ? "JOUR" : (hasTitle ? "JOUR" : "GEN")))
        for a in (paper.authors ?? []).map(bibtexAuthor).filter({ !$0.isEmpty }) { lines.append("AU  - " + a) }
        if let t = paper.title, !t.isEmpty { lines.append("TI  - " + t) }
        if let v = paper.venue, !v.isEmpty { lines.append("JO  - " + v) }
        let y = year(paper)
        if !y.isEmpty { lines.append("PY  - " + y) }
        if let d = paper.doi, !d.isEmpty { lines.append("DO  - " + d) }
        if isArxiv(paper) {
            lines.append("AN  - arXiv:" + paper.arxiv!)
            lines.append("UR  - https://arxiv.org/abs/" + paper.arxiv!)
        } else if let u = paper.pdfUrl, !u.isEmpty {
            lines.append("UR  - " + u)
        }
        lines.append("ER  - ")
        return lines.joined(separator: "\n")
    }

    /// 多条合并；空集合返回空串，由调用方决定提示。
    static func bibtex(_ papers: [QueueEntry]) -> String {
        papers.map(bibtex).filter { !$0.isEmpty }.joined(separator: "\n\n") + (papers.isEmpty ? "" : "\n")
    }

    static func ris(_ papers: [QueueEntry]) -> String {
        papers.map(ris).joined(separator: "\n\n") + (papers.isEmpty ? "" : "\n")
    }

    /// 文件名：单篇用引用键，多篇用日期。
    static func suggestedFilename(_ papers: [QueueEntry], ext: String, today: String) -> String {
        if papers.count == 1 { return citationKey(papers[0]) + "." + ext }
        return "CBCT-citations-\(today).\(ext)"
    }
}
