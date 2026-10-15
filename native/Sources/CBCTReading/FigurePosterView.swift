import SwiftUI
import PDFKit

// MARK: - 架构图海报式可视化

/// 图题定位：仅接受独立图题行，避免把正文中的 Figure N 引用当成图。
enum FigureLocator {
    struct Hit { var page: Int; var caption: String }
    static func find(in source: String) -> [Hit] {
        let pages = Evidence.pages(source)
        var hits: [Hit] = []
        let pattern = "(?im)^\\s*(?:fig\\.?|figure)\\s*\\d+\\s*[.:]?\\s*[^\\n]{0,180}"
        for page in pages {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let ns = page.text as NSString
            for match in regex.matches(in: page.text, range: NSRange(location: 0, length: ns.length)) {
                let text = ns.substring(with: match.range).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty { hits.append(Hit(page: page.number, caption: text)) }
            }
        }
        return Array(hits.prefix(12))
    }

    static func architecture(in source: String) -> Hit? {
        let preferred = ["architecture", "overview", "framework", "proposed", "network", "pipeline", "structure", "reconstruction"]
        return find(in: source).max { lhs, rhs in
            func score(_ hit: Hit) -> Int {
                let caption = hit.caption.lowercased()
                return preferred.reduce(0) { $0 + (caption.contains($1) ? 1 : 0) }
            }
            let a = score(lhs), b = score(rhs)
            return a == b ? lhs.page > rhs.page : a < b
        }
    }
}

/// 架构图卡片：随方法数据流自动解析；失败时仅展示目标图块裁剪 + 图题。
struct FigurePosterCard: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var showOriginal = false

    var body: some View {
        figurePane
            .frame(maxWidth: .infinity, alignment: .leading)
            .sheet(isPresented: $showOriginal) {
            VStack(alignment: .trailing, spacing: 12) {
                Button("关闭") { showOriginal = false }.buttonStyle(FunButtonStyle(small: true))
                if let image = session.figureImage {
                    Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                Text(session.figureTitle).font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(20).frame(minWidth: 900, minHeight: 650)
        }
    }

    // MARK: 左/上：图（结构图或原图）
    @ViewBuilder
    private var figurePane: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text(session.figureTitle.isEmpty ? "论文结构图" : session.figureTitle)
                    .font(serifFont(16, weight: .bold))
                Spacer()
                if session.figureImage != nil {
                    Button("放大原图") { showOriginal = true }.buttonStyle(FunButtonStyle(small: true))
                }
                if let page = session.figurePage {
                    Button("Page \(page)") { store.jumpToEvidence(session, page: page) }.buttonStyle(FunButtonStyle(small: true))
                }
            }
            if let image = session.figureImage {
                // 原图始终占满可用宽度，保持图文自然高度，不压进固定大小的卡片。
                Image(nsImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: .infinity)
            }
            if session.figureBusy {
                HStack { ProgressView(); Text(session.figurePhase).font(.system(size: 12)) }
            } else if let analysis = session.figureAnalysis, analysis.isUsable {
                DisclosureGroup("识别的模块与连接 · 对照上方原图") {
                    if analysis.nodes.count >= 2 && !analysis.edges.isEmpty {
                        PosterDiagram(analysis: analysis)
                            .frame(height: max(340, CGFloat(FigureLayout.layers(nodes: analysis.nodes, edges: analysis.edges).values.max() ?? 0) * 90 + 120))
                    }
                    Text("模块标签已与图中 OCR 文本核对；连线与层级需对照原图确认。")
                        .font(.system(size: 12)).foregroundColor(.inkSoft)
                }
                if analysis.panels.isEmpty {
                    Text("未定位到可由子图标记和局部 OCR 同时核实的面板；保留整图供阅读。")
                        .font(.system(size: 11)).foregroundColor(.inkSoft)
                } else {
                    DisclosureGroup("逐子图识别 · \(analysis.panels.count) 幅（整图仍保留在上方）") {
                        VStack(alignment: .leading, spacing: 16) {
                            ForEach(analysis.panels) { panel in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("子图 \(panel.label)").font(serifFont(15, weight: .bold))
                                    if let jpeg = panel.jpeg, let image = NSImage(data: jpeg) {
                                        Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
                                    }
                                    let names = Dictionary(uniqueKeysWithValues: panel.nodes.map { ($0.id, $0.label) })
                                    let flow = panel.edges.map { (names[$0.from] ?? $0.from) + " → " + (names[$0.to] ?? $0.to) }
                                    if !panel.nodes.isEmpty {
                                        Text("局部 OCR 核验模块：" + panel.nodes.map(\.label).joined(separator: "、"))
                                            .font(.system(size: 12)).textSelection(.enabled)
                                    }
                                    if !flow.isEmpty {
                                        Text("该子图可见连接（仍需对照箭头核验）：" + flow.joined(separator: "；"))
                                            .font(.system(size: 12)).foregroundColor(.inkSoft).textSelection(.enabled)
                                    }
                                    if !panel.note.isEmpty { Text(panel.note).font(.system(size: 11)).foregroundColor(.gold) }
                                    Text("OCR 文本：\(panel.ocrText)").font(.system(size: 10)).foregroundColor(.inkSoft).textSelection(.enabled)
                                }
                                Divider()
                            }
                        }
                    }
                }
                if !analysis.dropped.isEmpty { Text(analysis.note).font(.system(size: 12)).foregroundColor(.gold) }
            } else if session.figureImage != nil {
                degradeNote
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text(session.figureBusy ? "正在解析方法数据流与结构图…" : "结构图将在「解析数据流、模块、公式与几何」全流程中自动提取。")
                        .font(.system(size: 11)).foregroundColor(.inkSoft)
                    degradeNote
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var degradeNote: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let error = session.figureError {
                Text(userFacingFigureError(error)).font(.system(size: 10.5)).foregroundColor(.gold).textSelection(.enabled)
            }
            if let note = session.figureAnalysis?.note, !note.isEmpty {
                Text(note).font(.system(size: 10.5)).foregroundColor(.gold).textSelection(.enabled)
            }
            Text(session.figureImage == nil
                 ? "未取得可信图块，因此不展示整页 PDF，也未臆测模块或连线关系。"
                 : "当前仅展示目标图块裁剪与图题，未臆测模块或连线关系。")
                .font(.system(size: 10.5)).foregroundColor(.inkSoft)
        }
    }

    private func userFacingFigureError(_ error: String) -> String {
        if error.localizedCaseInsensitiveContains("data couldn’t be read") ||
            error.localizedCaseInsensitiveContains("data could not be read") {
            return "结构关系识别未完成；已保留论文图块与图题供核对。"
        }
        return error
    }
}

/// 海报式结构图：分层色块 + 箭头，风格简洁，随宽度切换横向/纵向布局。
private struct PosterDiagram: View {
    var analysis: FigureAnalysis

    var body: some View {
        GeometryReader { geo in
            let vertical = geo.size.width < 560
            let result = FigureLayout.layout(nodes: analysis.nodes, edges: analysis.edges, canvas: geo.size, vertical: vertical)
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Color(red: 0.988, green: 0.984, blue: 0.972))
                ForEach(result.arrows.indices, id: \.self) { i in
                    let arrow = result.arrows[i]
                    ArrowShape(from: arrow.from, to: arrow.to, vertical: vertical)
                        .stroke(Color.ink.opacity(0.55), lineWidth: 1.2)
                }
                ForEach(result.placed, id: \.id) { node in
                    NodeBox(node: node)
                        .frame(width: node.rect.width, height: node.rect.height)
                        .position(x: node.rect.midX, y: node.rect.midY)
                }
            }
        }
    }
}

private struct NodeBox: View {
    var node: FigureLayout.Placed
    var body: some View {
        Text(node.label)
            .font(.system(size: 11.5, weight: .medium))
            .multilineTextAlignment(.center)
            .lineLimit(3)
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 8).fill(FigurePalette.color(kind: node.kind)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.ink, lineWidth: 1.1))
    }
}

private struct ArrowShape: Shape {
    var from: CGPoint
    var to: CGPoint
    var vertical: Bool

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: from)
        if vertical {
            let mid = (from.y + to.y) / 2
            path.addLine(to: CGPoint(x: from.x, y: mid))
            path.addLine(to: CGPoint(x: to.x, y: mid))
            path.addLine(to: to)
        } else {
            let mid = (from.x + to.x) / 2
            path.addLine(to: CGPoint(x: mid, y: from.y))
            path.addLine(to: CGPoint(x: mid, y: to.y))
            path.addLine(to: to)
        }
        // 箭头头部
        let angle = atan2(to.y - from.y, to.x - from.x)
        let length: CGFloat = 7
        let spread: CGFloat = 0.42
        path.move(to: to)
        path.addLine(to: CGPoint(x: to.x - length * cos(angle - spread), y: to.y - length * sin(angle - spread)))
        path.move(to: to)
        path.addLine(to: CGPoint(x: to.x - length * cos(angle + spread), y: to.y - length * sin(angle + spread)))
        return path
    }
}

enum FigurePalette {
    static func color(kind: String) -> Color {
        switch kind.lowercased() {
        case "input": return Color.tealSoft
        case "output": return Color.funYellow
        case "loss": return Color.funPink
        case "data": return Color(red: 0.95, green: 0.93, blue: 0.86)
        default: return Color(red: 0.93, green: 0.96, blue: 1.0)
        }
    }
}
