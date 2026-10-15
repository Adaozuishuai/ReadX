import SwiftUI

/// Landscape, conference-poster presentation assembled from the paper's existing
/// abstract, reading notes, figure crop, and structured result extraction.
/// Missing material stays explicitly missing; this view does not invent sections.
struct PaperPosterView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState

    private var readings: ReadingFile? { store.loadReadings(session.ref.key) }
    private var abstract: String {
        let value = session.meta?.abstract ?? session.note?.meta["abstract"]?.str ?? ""
        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var deepNotes: String { readings?.deep ?? "" }
    private var methodText: String { readings?.method ?? session.readingText(for: "method") }
    private var resultsText: String { readings?.resultsJSON ?? "" }
    private var motivation: String {
        readings?.motivation ?? PosterCopy.section(in: deepNotes, matching: ["motivation", "研究动机", "背景"])
            ?? PosterCopy.sentences(abstract, limit: 3)
    }
    private var contribution: String {
        PosterCopy.section(in: deepNotes, matching: ["contribution", "贡献", "创新点", "key idea"])
            ?? PosterCopy.contributions(in: session.sourceText)
            ?? PosterCopy.section(in: methodText, matching: ["贡献", "核心思想", "创新"])
            ?? "精读笔记中尚无可核对的贡献小节。"
    }

    var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(spacing: 14) {
                masthead
                HStack(alignment: .top, spacing: 10) {
                    leftColumn.frame(width: 300)
                    Rectangle().fill(PosterPalette.olive.opacity(0.35)).frame(width: 1)
                    methodColumn.frame(width: 370)
                    Rectangle().fill(PosterPalette.olive.opacity(0.35)).frame(width: 1)
                    resultsColumn.frame(width: 360)
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(16)
            .frame(minWidth: 1104, alignment: .top)
            .background(PosterPalette.paper)
        }
        .background(PosterPalette.paper)
    }

    private var masthead: some View {
        VStack(spacing: 5) {
            Text(session.title)
                .font(.system(size: 24, weight: .bold, design: .serif))
                .foregroundColor(PosterPalette.navy)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(session.meta?.authors.joined(separator: " · ") ?? "")
                if !session.ref.venue.isEmpty { Text("·  \(session.ref.venue)") }
                if let year = session.meta?.published.split(separator: "-").first { Text("·  \(year)") }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(PosterPalette.inkSoft)
            Text("CBCT DAILY · EVIDENCE-GROUNDED PAPER READING")
                .font(.system(size: 9, weight: .bold, design: .rounded)).tracking(2)
                .foregroundColor(PosterPalette.olive)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .overlay(alignment: .bottom) { Rectangle().fill(PosterPalette.olive).frame(height: 2) }
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Label("关闭", systemImage: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Capsule().fill(.white.opacity(0.9)))
                    .overlay(Capsule().stroke(PosterPalette.olive.opacity(0.55), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .help("关闭会议海报")
            .padding(.top, 2).padding(.trailing, 2)
        }
    }

    private var leftColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            PosterSection(title: "1. Motivation", subtitle: "研究动机") {
                if motivation.isEmpty {
                    PosterMissing("尚无摘要或动机精读内容。")
                } else {
                    Text(motivation).font(.system(size: 11.5, design: .serif)).lineSpacing(2)
                        .textSelection(.enabled)
                }
            }
            PosterSection(title: "2. Contributions", subtitle: "核心贡献") {
                if contribution.contains("尚无可核对") {
                    PosterMissing(contribution)
                } else {
                    MarkdownView(src: contribution, size: 11)
                }
            }
        }
    }

    private var methodColumn: some View {
        PosterSection(title: "3. Method", subtitle: "沿架构图逐模块讲解") {
            FigurePosterCard(store: store, session: session)
            let formulas = session.methodFormulas.isEmpty ? (readings?.methodFormulas ?? []) : session.methodFormulas
            if methodText.isEmpty {
                PosterMissing("先在“方法与公式”中运行数据流解析。")
            } else {
                MarkdownView(src: Evidence.linked(MethodMath.integratedMarkdown(methodText, pages: formulas)), size: 13)
            }
        }
    }

    private var resultsColumn: some View {
        VStack(alignment: .leading, spacing: 10) {
            PosterSection(title: "4. Results", subtitle: "实验结果与对比") {
                if (try? ResultsAnalysis.decode(resultsText)) != nil {
                    ResultsCard(jsonText: resultsText, onEvidence: { page, excerpt in
                        store.jumpToEvidence(session, page: page, excerpt: excerpt)
                    }, visuals: session.resultVisuals.isEmpty ? (readings?.resultVisuals ?? []) : session.resultVisuals)
                } else if !resultsText.isEmpty {
                    PosterMissing("结果解析格式暂不可用，请在“结果分析”页重新生成。")
                } else {
                        VStack(alignment: .leading, spacing: 8) {
                            PosterMissing("结果表尚未抽取。海报不会补造指标或数值。")
                            Button(session.readingBusy(for: "results") ? "正在解析…" : "从论文抽取结果表") {
                                store.openReading(session, kind: "results")
                            }
                            .buttonStyle(FunButtonStyle(small: true))
                            .disabled(session.readingBusy(for: "results"))
                        }
                }
            }
            PosterSection(title: "Evidence & limits", subtitle: "证据与核对边界") {
                VStack(alignment: .leading, spacing: 5) {
                    Text("结论、表格与图像均来自当前论文材料及精读解析。图中模块标签须通过图内 OCR 核验；结构关系请回到原图核对。")
                    if let error = session.figureError, !error.isEmpty {
                        Text(error).foregroundColor(PosterPalette.olive)
                    }
                }
                .font(.system(size: 10.5, design: .serif)).lineSpacing(2)
            }
        }
    }

}

private struct PosterSection<Content: View>: View {
    var title: String
    var subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title).font(.system(size: 15, weight: .bold, design: .serif)).foregroundColor(PosterPalette.olive)
                Spacer(minLength: 4)
                Text(subtitle).font(.system(size: 9, weight: .medium)).foregroundColor(PosterPalette.inkSoft)
            }
            Rectangle().fill(PosterPalette.olive.opacity(0.55)).frame(height: 1)
            content
            .font(.system(size: 11, design: .serif))
                .foregroundColor(PosterPalette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(9)
        .background(PosterPalette.panel)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(PosterPalette.olive.opacity(0.6), lineWidth: 1))
    }
}

private struct PosterMissing: View {
    var bodyText: String
    init(_ bodyText: String) { self.bodyText = bodyText }
    var body: some View {
        Text(bodyText).font(.system(size: 10.5, design: .serif)).foregroundColor(PosterPalette.inkSoft)
            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(PosterPalette.paper.opacity(0.8))
    }
}

private enum PosterPalette {
    static let olive = Color(hex: 0x78833C)
    static let navy = Color(hex: 0x28516A)
    static let inkSoft = Color(hex: 0x65664F)
    static let ink = Color(hex: 0x34352D)
    static let paper = Color(hex: 0xFBFAF1)
    static let panel = Color(hex: 0xF4F3E6)
}

private enum PosterCopy {
    static func section(in markdown: String, matching names: [String]) -> String? {
        let lines = markdown.components(separatedBy: .newlines)
        var selected = false
        var result: [String] = []
        for line in lines {
            let clean = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let heading = clean.trimmingCharacters(in: CharacterSet(charactersIn: "#* _`"))
            let isHeading = clean.hasPrefix("#") || (clean.count < 90 && clean.hasSuffix("**"))
            if isHeading {
                if selected { break }
                let normalized = heading.lowercased()
                selected = names.contains { normalized.contains($0.lowercased()) }
                continue
            }
            if selected { result.append(line) }
        }
        let value = result.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static func sentences(_ text: String, limit: Int) -> String {
        let compact = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        guard !compact.isEmpty else { return "" }
        let pieces = compact.components(separatedBy: .init(charactersIn: ".。！？!?"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return pieces.prefix(limit).joined(separator: "。") + (pieces.count > 0 ? "。" : "")
    }

    static func contributions(in source: String) -> String? {
        let marker = "main contributions of this work are:"
        guard let range = source.range(of: marker, options: .caseInsensitive) else { return nil }
        var text = String(source[range.upperBound...])
        if let end = text.range(of: "2 Method", options: .caseInsensitive) { text = String(text[..<end.lowerBound]) }
        text = text.replacingOccurrences(of: "[–—]", with: "\n• ", options: .regularExpression)
        text = text.replacingOccurrences(of: "([A-Za-z])-[ \\n]+([a-z])", with: "$1$2", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "• ", with: "\n• ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return String(text.prefix(700))
    }
}
