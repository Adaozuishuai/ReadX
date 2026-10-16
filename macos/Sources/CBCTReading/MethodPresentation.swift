import SwiftUI

/// Visual transcription stays tied to its physical PDF page and original model output.
struct MethodFormulaPage: Codable, Equatable, Identifiable {
    var page: Int
    var source: String
    /// 视觉逐符号核对结果；nil = 旧缓存，未经核对（界面按「转写待核对」标注）
    var verified: Bool? = nil
    var recognizer: String? = nil
    var id: Int { page }
    var markdown: String { MethodMath.transcriptionMarkdown(source) }
}

enum MethodMath {
    /// Wrap raw visual LaTeX without changing operators or guessing missing symbols.
    /// Both the older `% Eq. …` format and fenced / delimited model responses are accepted.
    static func transcriptionMarkdown(_ raw: String) -> String {
        // Older visual responses persisted a JSON-escaped payload as plain text.
        // Decode only when escaped block delimiters prove it is that format;
        // ordinary LaTeX such as \nabla must retain its backslashes.
        var source = raw
        if !raw.contains("\n"), raw.contains("\\n$$") || raw.contains("\\n\\[") {
            if let decoded = try? JSONDecoder().decode(String.self, from: Data(("\"" + raw + "\"").utf8)) {
                source = decoded
            }
        }
        let lines = source.components(separatedBy: .newlines)
        var output: [String] = []
        var pending: [String] = []
        var delimited = false
        func flush() {
            let latex = pending.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !latex.isEmpty {
                if latex.range(of: "[=^_+∑∫]|\\\\[A-Za-z]", options: .regularExpression) != nil {
                    output.append("$$\n\(latex)\n$$")
                } else { output.append(latex) }
            }
            pending = []
        }
        for line in lines {
            let value = line.trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("```") { continue }
            if value.hasPrefix("%") {
                flush()
                output.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if value == "$$" || value == "\\[" || value == "\\]" {
                if delimited { flush() }
                delimited.toggle()
            } else if let latex = MathSegmenter.blockMathLine(value) {
                flush(); output.append("$$\n\(latex)\n$$")
            } else if value.isEmpty {
                if !delimited { flush() }
            } else {
                pending.append(line)
            }
        }
        flush()
        return output.joined(separator: "\n\n")
    }

    /// Method notes sometimes fence formulas as code; use the math renderer instead.
    /// Ordinary code fences and uncertain PDF text are kept unchanged.
    static func notesMarkdown(_ raw: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "(?is)```(?:latex|tex|math)\\s*\\n(.*?)```") else { return raw }
        let ns = raw as NSString
        var result = raw
        for match in regex.matches(in: raw, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let range = Range(match.range, in: result) else { continue }
            let body = ns.substring(with: match.range(at: 1))
            result.replaceSubrange(range, with: transcriptionMarkdown(body))
        }
        return result
    }

    /// Locate equation pages in the method section rather than using the page currently open.
    /// When section headings are unavailable, use method-note page references as the scope.
    static func pages(in source: String, method: String) -> [Int] {
        let pages = Evidence.pages(source)
        let startPattern = "(?im)^\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:methods?|methodology|materials and methods|proposed method|proposed approach|approach)\\s*$"
        let endPattern = "(?im)^\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s+)?(?:experiments?|results|evaluation|conclusion|references)\\s*$"
        func firstRange(_ pattern: String, _ text: String) -> Range<String.Index>? {
            text.range(of: pattern, options: .regularExpression)
        }
        let hasMethod = pages.contains { firstRange(startPattern, $0.text) != nil }
        let cited = Set(Evidence.citations(method))
        var inMethod = false
        var found: [Int] = []
        for page in pages {
            var text = page.text
            if hasMethod {
                if !inMethod {
                    guard let start = firstRange(startPattern, text) else { continue }
                    inMethod = true; text = String(text[start.upperBound...])
                }
                if let end = firstRange(endPattern, text) {
                    text = String(text[..<end.lowerBound]); inMethod = false
                }
                // If a page starts with the next section heading, its content
                // belongs to that section even when the previous page ended in
                // the middle of Method. Do not send the Results page to formula OCR.
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            } else if !cited.contains(page.number) { continue }
            // The PDF text layer commonly drops operators or superscripts. Use the
            // section boundary (or the generated method's cited pages) to decide
            // which page images the local formula detector should inspect; do not
            // require text extraction to have already found an equation.
            if hasMethod || cited.contains(page.number) { found.append(page.number) }
            if hasMethod && !inMethod { break }
        }
        return found
    }
}

/// Visual formulas are inserted exactly where the generated module explanation refers to them.
struct MethodEquation: Identifiable {
    var id: String
    var page: Int
    var label: String
    var latex: String
    var token: String { "[[formula:\(id)]]" }
}

extension MethodMath {
    static func equations(_ pages: [MethodFormulaPage]) -> [MethodEquation] {
        pages.flatMap { page in
            var label = "未编号公式"
            var equations: [MethodEquation] = []
            for block in Markdown.parse(page.markdown) {
                switch block {
                case .paragraph(let lines): label = lines.joined(separator: " ")
                case .mathBlock(let latex):
                    equations.append(MethodEquation(id: "p\(page.page)-e\(equations.count + 1)", page: page.page, label: label, latex: latex))
                    label = "未编号公式"
                default: break
                }
            }
            return equations
        }
    }

    static func catalog(_ pages: [MethodFormulaPage]) -> String {
        equations(pages).map { "\($0.token) · \($0.label) · Page \($0.page)\n\($0.latex)" }.joined(separator: "\n\n")
    }

    static func integratedMarkdown(_ notes: String, pages: [MethodFormulaPage]) -> String {
        var output = notesMarkdown(notes)
        for equation in equations(pages) {
            let page = pages.first { $0.page == equation.page }
            let checkNote = page?.verified == true ? "转写经核对" : ((page?.recognizer == "Pix2Text-local") ? "本地 OCR 转写，待核对" : "转写待核对")
            output = output.replacingOccurrences(of: equation.token,
                with: "\n\n\(equation.label) · \(checkNote) (Page \(equation.page))\n\n$$\n\(equation.latex)\n$$\n\n")
        }
        // Never show an invented or unresolved formula reference as if it had rendered.
        return output.replacingOccurrences(of: "\\[\\[formula:[^\\]]+\\]\\]", with: "该公式未取得可靠转写，请核对原文。", options: .regularExpression)
    }

    static func validateReferences(_ notes: String, pages: [MethodFormulaPage]) throws {
        let entries = equations(pages)
        let regex = try NSRegularExpression(pattern: "\\[\\[formula:([^\\]]+)\\]\\]")
        let ns = notes as NSString
        let used = regex.matches(in: notes, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
        guard Set(used) == Set(entries.map(\.id)), used.count == entries.count else {
            let expected = Set(entries.map(\.id))
            let missing = expected.subtracting(used).sorted().joined(separator: ", ")
            let unknown = Set(used).subtracting(expected).sorted().joined(separator: ", ")
            let duplicates = Set(used.filter { token in used.filter { $0 == token }.count > 1 }).sorted().joined(separator: ", ")
            throw NSError(domain: "method", code: 8, userInfo: [NSLocalizedDescriptionKey: "公式引用未正确绑定。遗漏：[\(missing)]；未知：[\(unknown)]；重复：[\(duplicates)]。每条视觉转写公式应在对应模块中出现一次。"])
        }
        var section = "", previousToken = false
        for line in notes.components(separatedBy: .newlines) {
            let value = line.trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("#") { section = value; previousToken = false }
            if value.contains("[[formula:") {
                guard !section.isEmpty,
                      section.range(of: "(?i)公式(?:汇总|总览|合集|列表)|(?:all|key)\\s+equations|equations\\s+(?:summary|list)", options: .regularExpression) == nil,
                      !previousToken else {
                    throw NSError(domain: "method", code: 9, userInfo: [NSLocalizedDescriptionKey: "公式必须位于对应模块小节且紧邻说明，不能集中列在公式汇总节。"])
                }
                previousToken = true
            } else if !value.isEmpty { previousToken = false }
        }
    }
}

struct MethodExplanationView: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            FigurePosterCard(store: store, session: session)
            if session.formulaBusy {
                HStack { ProgressView(); Text(session.formulaPhase).font(.system(size: 13)) }
            }
            if let error = session.formulaError {
                Text("公式转写待核对：" + error).font(.system(size: 12)).foregroundColor(.gold).textSelection(.enabled)
            }
            if session.readingKind == "method" || session.readingBusy(for: "method"), !session.readingText(for: "method").isEmpty {
                let raw = session.readingText(for: "method")
                // 流式期间跳过公式整合与链接化（每个刷新都重跑会占满主线程）；完成后再做完整处理
                let src = session.readingBusy(for: "method")
                    ? raw
                    : Evidence.linked(MethodMath.integratedMarkdown(raw, pages: session.methodFormulas))
                MarkdownView(src: src, size: 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
