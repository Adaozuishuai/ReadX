import SwiftUI
import AppKit

// MARK: - 主题色

extension Color {
    init(hex: UInt32) { self.init(red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255) }
    static let paper = Color(hex: 0xFFFDF8)
    static let card = Color.white
    static let ink = Color(hex: 0x222222)
    static let inkSoft = Color(hex: 0x666666)
    static let accent = Color(hex: 0x6C5CE7)
    static let accentSoft = Color(hex: 0xEFE9FF)
    static let teal = Color(hex: 0x336B78)
    static let tealSoft = Color(hex: 0xE6F7FF)
    static let gold = Color(hex: 0x8A6D00)
    static let line = Color(hex: 0x222222)
    static let funYellow = Color(hex: 0xFFF2A8)
    static let funPink = Color(hex: 0xFFE8EE)
    static let funMint = Color(hex: 0xB5F2C8)
    static let funBlue = Color(hex: 0x8BE9FD)
    static let funLavender = Color(hex: 0xF1ECFF)
    static let funPeach = Color(hex: 0xFFE08A)
}

extension ShapeStyle where Self == Color {
    static var paper: Color { .paper }
    static var card: Color { .card }
    static var ink: Color { .ink }
    static var inkSoft: Color { .inkSoft }
    static var accent: Color { .accent }
    static var accentSoft: Color { .accentSoft }
    static var teal: Color { .teal }
    static var tealSoft: Color { .tealSoft }
    static var gold: Color { .gold }
    static var line: Color { .line }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(22)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 20).fill(.card))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(.line, lineWidth: 1.6))
            .shadow(color: .ink.opacity(0.05), radius: 12, x: 0, y: 6)
    }
}

func serifFont(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .default)
}

// MARK: - 视图层级自检（写 macos/layout.log，用于排查渲染问题）

func dumpLayoutHierarchy() {
    var lines: [String] = []
    if let win = NSApp.windows.first(where: { $0.isVisible }) {
        lines.append("window: \(Int(win.frame.width))x\(Int(win.frame.height)) @(\(Int(win.frame.minX)),\(Int(win.frame.minY)))")
        func walk(_ v: NSView, depth: Int) {
            let pad = String(repeating: "  ", count: depth)
            lines.append("\(pad)\(String(describing: type(of: v))) \(Int(v.frame.width))x\(Int(v.frame.height)) @(\(Int(v.frame.minX)),\(Int(v.frame.minY)))")
            if depth < 12 { for c in v.subviews { walk(c, depth: depth + 1) } }
        }
            if let content = win.contentView {
                walk(content, depth: 1)
            }
    } else {
        lines.append("没有可见窗口")
    }
    let report = lines.joined(separator: "\n") + "\n"
    if let res = Bundle.main.resourceURL,
       let rootStr = try? String(contentsOf: res.appendingPathComponent("ROOT.txt"), encoding: .utf8) {
        let root = URL(fileURLWithPath: rootStr.trimmingCharacters(in: .whitespacesAndNewlines))
        try? report.write(to: root.appendingPathComponent("macos/layout.log"), atomically: true, encoding: .utf8)
    } else {
        try? report.write(to: URL(fileURLWithPath: "macos/layout.log"), atomically: true, encoding: .utf8)
    }
}

// MARK: - 根视图

struct RootView: View {
    @ObservedObject var store: Store

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.paper.ignoresSafeArea()
            if let s = store.session {
                ReaderView(store: store, session: s)
            } else {
                WorkspaceView(store: store)
            }
            if store.updateAvailable { UpdateBar(store: store) }
            if let t = store.toast { ToastView(text: t) }
        }
        .sheet(item: $store.ideaDraft) { idea in IdeaEditor(store: store, idea: idea) }
        .tint(.accent)
        .foregroundColor(.ink)
        .preferredColorScheme(.light)
    }
}

struct UpdateBar: View {
    @ObservedObject var store: Store
    var body: some View {
        HStack(spacing: 10) {
            Text("检测到应用更新").font(serifFont(13.5))
            Button("一键重启") { store.relaunch() }
                .buttonStyle(FunButtonStyle(small: true))
                .padding(.horizontal, 14).padding(.vertical, 5)
                .background(Capsule().fill(.card))
                .foregroundColor(.teal)
                .font(.system(size: 13, weight: .bold))
        }
        .padding(.leading, 18).padding(.trailing, 10).padding(.vertical, 8)
        .background(Capsule().fill(.teal).shadow(color: .black.opacity(0.2), radius: 8, y: 3))
        .foregroundColor(Color(red: 0.95, green: 0.97, blue: 0.96))
        .padding(.trailing, 20).padding(.top, 10)
    }
}

struct ToastView: View {
    let text: String
    var body: some View {
        Text(text)
            .font(serifFont(14))
            .padding(.horizontal, 20).padding(.vertical, 10)
            .background(Capsule().fill(.ink))
            .foregroundColor(Color(red: 0.97, green: 0.95, blue: 0.91))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 28)
            .allowsHitTesting(false)
    }
}

// MARK: - 首页

// MARK: - AI 助教配置弹层

struct ConfigSheet: View {
    @ObservedObject var store: Store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("AI 助教配置").font(serifFont(18, weight: .bold)).foregroundColor(.ink)
            if store.config.hasKey {
                Text("已配置：\(store.config.model ?? "")")
                    .font(serifFont(15, weight: .medium)).foregroundColor(.teal)
                Text("「这里没懂」「挑毛病」都已可用：进入精读室，选中正文一句话点浮标提问，或点右上角「助教」自由对话。")
                    .font(serifFont(14)).foregroundColor(.ink)
                Text("可选：在 config.json 中填写 githubToken（GitHub 只读 token），可将代码扫描限额从匿名额度提升到 5000 次/小时；token 只用于请求头，不会进入 prompt、日志或导出。")
                    .font(serifFont(13)).foregroundColor(.inkSoft)
            } else {
                Text("未配置 API Key").font(serifFont(15, weight: .medium)).foregroundColor(.accent)
                Text("编辑 cbct-reading/app/config.json，填入 OpenAI 兼容 API 的 Key（GLM / DeepSeek / OpenAI 均可），保存即生效，无需重启。")
                    .font(serifFont(14)).foregroundColor(.ink)
            }
            HStack {
                Button("打开配置文件夹") {
                    NSWorkspace.shared.open(store.configURL.deletingLastPathComponent())
                }.buttonStyle(FunButtonStyle(small: true))
                Spacer()
                Button("完成") { dismiss() }
                    .buttonStyle(FunButtonStyle(primary: true))
            }
        }
        .padding(26)
        .frame(width: 500)
    }
}

// MARK: - 精读室

struct ReaderView: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    let stepNames = ["① 问题感", "② 读原文", "③ 挑毛病", "④ 留笔记"]

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                Divider().overlay(.line)
                ZStack {
                    switch session.step {
                    case 1: Step1View(store: store, session: session)
                    case 2: Step2View(store: store, session: session)
                    case 3: Step3View(store: store, session: session)
                    default: Step4View(store: store, session: session)
                    }
                }
            }
            if session.drawerOpen {
                Divider().overlay(.line)
                DrawerView(store: store, session: session)
                    .frame(width: 360)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "cbct-evidence", let page = Int(url.lastPathComponent) {
                store.jumpToEvidence(session, page: page); return .handled
            }
            return .systemAction
        })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Button("← 书桌") { store.goHome() }.buttonStyle(.plain).foregroundColor(.inkSoft)
                Text(session.title).font(serifFont(16, weight: .bold)).foregroundColor(.ink).lineLimit(1)
                if !session.ref.venue.isEmpty {
                    Text(session.ref.venue).font(serifFont(12)).foregroundColor(.inkSoft).lineLimit(1)
                }
                Spacer(minLength: 0)
                Button(store.state(session.ref.key).favorite ? "★" : "☆") { store.mutateLibrary(session.ref.key) { $0.favorite.toggle() } }.buttonStyle(.plain).foregroundColor(.gold)
                Button(session.drawerOpen ? "收起助教" : "助教") {
                    if session.drawerOpen { session.drawerOpen = false } else { store.openDrawer(mode: "chat") }
                }.buttonStyle(FunButtonStyle(primary: session.drawerOpen, small: true))
            }
            HStack(spacing: 8) {
                ForEach(1...4, id: \.self) { i in
                    Button(stepNames[i - 1]) { store.setStep(i) }
                        .buttonStyle(.plain).font(serifFont(13))
                        .padding(.horizontal, 13).padding(.vertical, 5)
                        .background(Capsule().fill(session.step == i ? .ink : .card))
                        .foregroundColor(session.step == i ? Color.paper : .inkSoft)
                        .overlay(Capsule().stroke(.line, lineWidth: 1))
                }
                Spacer(minLength: 0)
            }
        }.padding(.horizontal, 18).padding(.vertical, 10)
    }
}

// MARK: - 第①步 问题感

struct Step1View: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("第 ① 步 · 建立问题感").font(serifFont(12.5, weight: .bold)).tracking(3).foregroundColor(.gold)
                if let m = session.meta, !m.authors.isEmpty {
                    Text(m.authors.joined(separator: ", ")).font(serifFont(13.5)).foregroundColor(.inkSoft)
                }
                Text("这篇论文想解决什么").font(serifFont(15.5, weight: .bold)).foregroundColor(.accent)
                if let setup = session.note?.sections["setup"] {
                    MarkdownView(src: setup)
                } else if let abs = session.meta?.abstract {
                    Text(abs).font(serifFont(15)).lineSpacing(5).foregroundColor(.ink)
                } else {
                    Text("正在加载摘要…").font(serifFont(14)).foregroundColor(.inkSoft)
                }
                let why = session.ref.why.isEmpty ? (session.note?.sections["summary"] ?? "") : session.ref.why
                if !why.isEmpty {
                    MarkdownView(src: "**为什么值得读：** \(why)")
                        .padding(.vertical, 10).padding(.horizontal, 16)
                        .background(Color(red: 0.984, green: 0.965, blue: 0.914))
                        .overlay(HStack { Rectangle().fill(.gold).frame(width: 3); Spacer() })
                }
                Text("带着这三个问题读").font(serifFont(15.5, weight: .bold)).foregroundColor(.accent)
                ForEach(Array(store.stepQuestions(for: session).enumerated()), id: \.offset) { _, q in
                    Text(q).font(serifFont(15)).foregroundColor(.ink)
                        .padding(.vertical, 10).padding(.horizontal, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 0.984, green: 0.965, blue: 0.914)))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.gold.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4])))
                }
                Text("分层 AI 精读").font(serifFont(15.5, weight: .bold)).foregroundColor(.accent)
                HStack(spacing: 10) {
                    readingChip("30 秒 TL;DR", "tldr")
                    readingChip("5 分钟精读", "deep")
                    readingChip("Critical View", "critical")
                }
                if let kind = session.readingKind, !["experiment", "apply", "reproduce"].contains(kind) {
                    readingPanel(kind)
                } else if let busyKind = ["tldr", "deep", "critical"].first(where: { session.readingBusy(for: $0) }) {
                    // 某个分层精读在后台解析（当前展开的是其他种类）：仍显示其进行中面板
                    readingPanel(busyKind)
                }
                HStack(spacing: 12) {
                    Button("我准备好了，开始读 →") { store.setStep(2) }
                        .buttonStyle(FunButtonStyle(primary: true))
                    Button("先让助教给个 3 分钟导览") {
                        store.openDrawer(mode: "problem")
                        store.sendChat(session, text: "请开始：帮我建立这篇论文的问题感。")
                    }
                    .buttonStyle(FunButtonStyle())
                }
                .padding(.top, 4)
            }
            .padding(22)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    private func readingChip(_ label: String, _ kind: String) -> some View {
        Button(label) { store.openReading(session, kind: kind) }
            .buttonStyle(.plain)
            .font(serifFont(13.5))
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(Capsule().fill(session.readingKind == kind ? .accent : .card))
            .foregroundColor(session.readingKind == kind ? Color(red: 1, green: 0.97, blue: 0.94) : .ink)
            .overlay(Capsule().stroke(session.readingKind == kind ? .accent : .line, lineWidth: 1))
    }

    @ViewBuilder
    private func readingPanel(_ kind: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if session.readingBusy(for: kind) {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(session.evidencePhase(for: kind) + "…").font(serifFont(13.5)).foregroundColor(.inkSoft)
                }
            } else if let err = session.readingError(for: kind) {
                Text(err).font(serifFont(13.5)).foregroundColor(.accent)
                Button("重试") { store.openReading(session, kind: kind, regenerate: true) }.buttonStyle(FunButtonStyle(small: true))
            } else {
                MarkdownView(src: Evidence.linked(session.readingText(for: kind)))
                ReadingAuditView(store: store, session: session)
                Button("重新生成") { store.openReading(session, kind: kind, regenerate: true) }.buttonStyle(FunButtonStyle(small: true))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 1, green: 0.996, blue: 0.976)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.line))
    }
}

// MARK: - 第②步 读原文

struct Step2View: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var showPaperPoster = false
    @State private var showMethodPDF = false

    var body: some View {
        VStack(spacing: 0) {
            Text("第 ② 步 · 精读论文 —— 动机 → 方法 → 实验 → 结果")
                .font(serifFont(12.5, weight: .bold)).tracking(2).foregroundColor(.gold)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.top, 10)
            HSplitView {
                VStack(spacing: 10) {
                    Picker("精读面板", selection: $session.readerTab) { Text("论文动机").tag("动机"); Text("方法与公式").tag("方法"); Text("实验配置").tag("实验"); Text("结果分析").tag("结果"); Text("论文与代码").tag("代码") }.pickerStyle(.segmented).padding(.top, 10)
                    if session.readerTab == "代码" {
                        ScrollView { CodePanel(store: store, session: session).padding(12) }
                    } else {
                        ScrollView {
                            VStack(alignment: .leading, spacing: 12) {
                                let kind = session.readerTab == "动机" ? "motivation" : session.readerTab == "方法" ? "method" : session.readerTab == "结果" ? "results" : "experiment"
                                Button(session.readerTab == "动机" ? "解析论文动机" : session.readerTab == "方法" ? "解析数据流、模块、公式与几何" : session.readerTab == "结果" ? "解析结果图表与逐项解读" : "抽取实验配置") { store.openReading(session, kind: kind) }.buttonStyle(FunButtonStyle(primary: true))
                                    .disabled(session.readingBusy(for: kind) || (kind == "method" && (session.figureBusy || session.formulaBusy)))
                                if session.readerTab == "动机" {
                                    Text("研究问题 → 现有局限 → 核心思路 → 实验验证")
                                        .font(serifFont(13)).foregroundColor(.inkSoft)
                                    if session.readingKind != "motivation" {
                                        Text("结合原文解析作者为什么开展这项研究，以及方法、实验和结果应回答哪些问题。")
                                            .font(serifFont(14)).foregroundColor(.inkSoft)
                                    }
                                    Divider()
                                }
                                if session.readerTab == "方法" {
                                    HStack {
                                        Text("一次解析：原图 → 数据流与模块 → LaTeX 公式与符号解释")
                                            .font(.system(size: 11)).foregroundColor(.inkSoft)
                                        Spacer()
                                        Button(showMethodPDF ? "收起原文" : "打开原文") { showMethodPDF.toggle() }
                                            .buttonStyle(FunButtonStyle(small: true))
                                        Button("会议海报视图") { showPaperPoster = true }
                                            .buttonStyle(FunButtonStyle(small: true))
                                    }
                                    Divider()
                                    MethodExplanationView(store: store, session: session)
                                }
                                if session.readerTab == "结果" {
                                    HStack {
                                        Text("原图与原表 → 对照基线 → 逐项解读与结论边界").font(.system(size: 12)).foregroundColor(.inkSoft)
                                        Spacer()
                                        Button(showMethodPDF ? "收起原文" : "打开原文") { showMethodPDF.toggle() }.buttonStyle(FunButtonStyle(small: true))
                                    }
                                    if session.resultVisualBusy {
                                        HStack { ProgressView(); Text(session.resultVisualPhase).font(.system(size: 12)) }
                                    }
                                    if let error = session.resultVisualError {
                                        Text(error).font(.system(size: 12)).foregroundColor(.gold)
                                    }
                                    Divider()
                                }
                                if session.readingKind == kind || session.readingBusy(for: kind) {
                                    if session.readingBusy(for: kind) { HStack { ProgressView(); Text(session.evidencePhase(for: kind) + "…").font(.system(size: 12)) } }
                                    else if let error = session.readingError(for: kind) { Text(error).foregroundColor(.accent); Button("重试") { store.openReading(session, kind: kind, regenerate: true) }.buttonStyle(FunButtonStyle(small: true)) }
                                    else {
                                        if kind == "experiment" { ExperimentCard(jsonText: session.readingText(for: kind), onEvidence: { store.jumpToEvidence(session, page: $0, excerpt: $1) }) }
                                        else if kind == "results" { ResultsCard(jsonText: session.readingText(for: kind), onEvidence: { store.jumpToEvidence(session, page: $0, excerpt: $1) }, visuals: session.resultVisuals) }
                                        else if kind != "method" { MarkdownView(src: Evidence.linked(session.readingText(for: kind))) }
                                        ReadingAuditView(store: store, session: session)
                                        Button("重新生成") { store.openReading(session, kind: kind, regenerate: true) }.buttonStyle(FunButtonStyle(small: true))
                                            .disabled(kind == "method" && (session.figureBusy || session.formulaBusy))
                                    }
                                }
                            }.frame(maxWidth: ["方法", "结果"].contains(session.readerTab) ? 1100 : .infinity, alignment: .leading)
                                .frame(maxWidth: .infinity).padding(["方法", "结果"].contains(session.readerTab) ? 24 : 12)
                        }
                    }
                }.frame(minWidth: 280, idealWidth: ["方法", "结果"].contains(session.readerTab) ? 820 : 450, maxWidth: .infinity)
                if !["方法", "结果"].contains(session.readerTab) || showMethodPDF {
                    pdfPane.frame(minWidth: 280, idealWidth: 420, maxHeight: .infinity)
                }
            }
            .frame(maxHeight: .infinity)
            .padding(.horizontal, 14).padding(.bottom, 10)
            footer(next: "下一步：一起挑毛病") { store.setStep(3) }
        }
        .onAppear {
            #if DEBUG
            // 自检：进第②步时把真实视图层级尺寸写进日志（仅调试构建）
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { dumpLayoutHierarchy() }
            #endif
        }
        .onChange(of: session.evidenceRequest) { _ in
            if ["方法", "结果"].contains(session.readerTab) { showMethodPDF = true }
        }
        .sheet(isPresented: $showPaperPoster) {
            PaperPosterView(store: store, session: session)
                .frame(minWidth: 1120, minHeight: 760)
        }
    }

    @ViewBuilder
    private var pdfPane: some View {
        VStack(spacing: 8) {
            Text("论文原文 PDF").font(serifFont(14, weight: .bold)).foregroundColor(.accent).frame(maxWidth: .infinity, alignment: .leading)
            if !session.evidencePhase.isEmpty {
                Text("证据状态：\(session.evidencePhase)").font(.system(size: 11)).foregroundColor(session.evidencePhase.contains("就绪") ? .teal : .inkSoft).frame(maxWidth: .infinity, alignment: .leading)
            }
            switch session.pdfState {
            case .idle, .loading:
                VStack(spacing: 8) {
                    ProgressView()
                    Text("第一次读这篇，正在把 PDF 存进论文库…").font(serifFont(13)).foregroundColor(.inkSoft)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            case .ready(let url):
                PDFKitView(url: url, page: session.evidencePage, requestID: session.evidenceRequest, excerpt: session.evidenceExcerpt,
                           onSelection: { text, page in session.selectedPDFExcerpt = text; session.selectedPDFPage = page },
                           onAsk: { sel, ctx in store.askExplain(selection: sel, context: ctx) },
                           onPage: { current, total in session.pdfCurrentPage = current; session.pdfTotalPage = total })
            case .failed(let msg):
                VStack(spacing: 8) {
                    Text("自动下载失败：\(msg)").font(serifFont(13)).foregroundColor(.inkSoft)
                    if !session.ref.arxiv.isEmpty, let arxivURL = URL(string: "https://arxiv.org/pdf/\(session.ref.arxiv)") {
                        Link("去 arXiv 下载 ↗", destination: arxivURL)
                            .font(serifFont(13))
                        Button("重试下载") { Task { await store.preparePDF(session) } }.buttonStyle(FunButtonStyle(small: true))
                    }
                    Button("导入全文 PDF") { if let p = store.allPapers.first(where: { $0.key == session.ref.key }) { store.importPDF(for: p) } }.buttonStyle(FunButtonStyle())
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 10) {
                if session.selectedPDFExcerpt.isEmpty {
                    Text("在 PDF 中选中一段原文，可存为 Idea 证据").font(serifFont(12)).foregroundColor(.inkSoft)
                } else {
                    Text("已选 Page \(session.selectedPDFPage ?? 1)").font(serifFont(12, weight: .medium)).foregroundColor(.teal)
                    Button("保存为 Idea 证据") { store.newIdea(from: session) }
                        .buttonStyle(FunButtonStyle(teal: true, small: true))
                }
                Spacer()
                if let current = session.pdfCurrentPage, let total = session.pdfTotalPage, total > 0 {
                    Text("Page \(current) / \(total)").font(serifFont(12)).foregroundColor(.inkSoft)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
    }

    @ViewBuilder
    private func footer(next: String, action: @escaping () -> Void) -> some View {
        HStack {
            Spacer()
            Button(next) { action() }
                .buttonStyle(FunButtonStyle(primary: true))
        }
        .padding(.horizontal, 18).padding(.bottom, 10)
    }
}

// MARK: - 第③步 挑毛病

struct Step3View: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var doubt = ""

    var body: some View {
        VStack(spacing: 0) {
            Text("第 ③ 步 · 一起挑毛病 —— 实验能支持作者的结论吗？")
                .font(serifFont(12.5, weight: .bold)).tracking(2).foregroundColor(.gold)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.top, 10)
            HSplitView {
                ScrollView {
                    if let exp = session.note?.sections["experiments"] {
                        MarkdownView(src: exp).padding(14)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("还没有精读笔记").font(serifFont(15, weight: .bold)).foregroundColor(.accent)
                            Text("把你在 PDF 里读到的实验设定讲给助教听（用了多少 views、什么数据、和谁比），让它帮你一起挑毛病。").font(serifFont(14.5)).foregroundColor(.ink)
                        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .frame(minWidth: 280, idealWidth: 520)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("审稿人对话").font(serifFont(15, weight: .bold)).foregroundColor(.accent)
                        HStack(spacing: 10) {
                            Button("让助教先挑三个刺") { store.startCritique(session) }
                                .buttonStyle(FunButtonStyle(primary: true))
                            Button("自己接着聊") { store.openDrawer(mode: "critique") }
                                .buttonStyle(FunButtonStyle())
                        }
                        Button {
                            store.openReading(session, kind: "experiment")
                        } label: {
                            Text(session.readingBusy(for: "experiment") ? "正在抽取实验配置…" : "抽取实验配置（结构化）")
                                .font(serifFont(13.5))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(RoundedRectangle(cornerRadius: 10).fill(.tealSoft))
                                .foregroundColor(.teal)
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(.teal.opacity(0.4), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        if session.readingKind == "experiment" || session.readingBusy(for: "experiment") {
                            Group {
                                if session.readingBusy(for: "experiment") {
                                    HStack(spacing: 8) { ProgressView(); Text("正在从原文抽取实验配置…").font(serifFont(13)).foregroundColor(.inkSoft) }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                } else if let err = session.readingError(for: "experiment") {
                                    Text(err).font(serifFont(13)).foregroundColor(.accent)
                                    Button("重试") { store.openReading(session, kind: "experiment", regenerate: true) }.buttonStyle(FunButtonStyle(small: true))
                                } else {
                                    ExperimentCard(jsonText: session.readingText(for: "experiment"), onEvidence: { store.jumpToEvidence(session, page: $0, excerpt: $1) })
                                }
                            }
                        }
                        if let log = store.progress[session.ref.key]?.critiqueLog, !log.isEmpty {
                            Text("上次的对话").font(serifFont(14, weight: .bold)).foregroundColor(.accent).padding(.top, 4)
                            ForEach(Array(log.suffix(4).enumerated()), id: \.offset) { _, m in
                                Text(m.t.prefix(300) + (m.t.count > 300 ? "…" : ""))
                                    .font(serifFont(13))
                                    .padding(9)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(RoundedRectangle(cornerRadius: 10).fill(m.r == "ai" ? Color(red: 0.957, green: 0.937, blue: 0.89) : .tealSoft))
                            }
                        }
                        Text("我的存疑清单").font(serifFont(14, weight: .bold)).foregroundColor(.accent).padding(.top, 4)
                        TextEditor(text: $doubt)
                            .font(serifFont(14))
                            .scrollContentBackground(.hidden)
                            .frame(minHeight: 70)
                            .padding(6)
                            .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 1, green: 0.996, blue: 0.976)))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.line))
                        Text("读的过程中冒出的问号，先记在这里（自动保存）").font(serifFont(12)).foregroundColor(.inkSoft)
                    }
                    .padding(14)
                }
                .frame(minWidth: 280, idealWidth: 400)
            }
            .padding(.horizontal, 14).padding(.bottom, 8)
            HStack {
                Spacer()
                Button("下一步：留下我的理解 →") { store.setStep(4) }
                    .buttonStyle(FunButtonStyle(primary: true))
            }
            .padding(.horizontal, 18).padding(.bottom, 10)
        }
        .onAppear { doubt = store.progress[session.ref.key]?.reflections?["doubt"] ?? "" }
        .onChange(of: doubt) { v in
            session.drafts["doubt"] = v
            store.saveProgress(key: session.ref.key) { $0.reflections = ($0.reflections ?? [:]).merging(["doubt": v]) { _, n in n } }
        }
    }
}

// MARK: - 第④步 留笔记

struct Step4View: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var loaded = false

    let questions = [
        "用自己的话讲一遍这篇论文的核心管线（表示 → 投影 → 比较 → 优化）。",
        "你最存疑的结论是哪个？为什么？",
        "和你课题或已读论文最相关的连接点是什么？（第一篇可写：它适合当你研究里的什么角色）",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("第 ④ 步 · 留下自己的理解").font(serifFont(12.5, weight: .bold)).tracking(3).foregroundColor(.gold)
                Text("写完会存进进度，并追加到精读笔记的「我的批注」——这就是以后跨论文比较时，你的底牌。")
                    .font(serifFont(13.5)).foregroundColor(.inkSoft)
                Picker("研究沉淀", selection: $session.notesMode) { Text("个人笔记").tag("笔记"); Text("迁移到我的研究").tag("迁移"); Text("复现准备").tag("复现") }.pickerStyle(.segmented)
                if session.notesMode == "迁移" { ApplicationPanel(store: store, session: session) }
                else if session.notesMode == "复现" { ReproductionPanel(store: store, session: session) }
                else {
                ForEach(0..<3, id: \.self) { i in
                    Text("问题 \(i + 1)").font(serifFont(14.5, weight: .bold)).foregroundColor(.accent)
                    Text(questions[i]).font(serifFont(13.5)).foregroundColor(.inkSoft)
                    bindingEditor(i)
                }
                Text("自由批注").font(serifFont(14.5, weight: .bold)).foregroundColor(.accent)
                TextEditor(text: $session.freeNoteDraft)
                    .font(serifFont(14))
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 60)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 1, green: 0.996, blue: 0.976)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.line))
                HStack {
                    Button("完成今天的精读") { store.finishReading(session) }
                        .buttonStyle(FunButtonStyle(primary: true))
                }
                .padding(.top, 4)
                // R-03：精读完成后的下一步引导（Ideas/复现/代码映射真实产出为 0，功能在但缺入口提示）
                VStack(alignment: .leading, spacing: 8) {
                    Text("精读完成后，下一步可以…").font(serifFont(14.5, weight: .bold)).foregroundColor(.accent)
                    Button("① 把批注沉淀为研究 Idea") { store.newIdea(from: session) }
                        .buttonStyle(FunButtonStyle(small: true))
                    Button("② 评估这篇论文的复现可行性") { session.notesMode = "复现" }
                        .buttonStyle(FunButtonStyle(small: true))
                    Button("③ 映射官方代码仓库") { store.setStep(2); session.readerTab = "代码" }
                        .buttonStyle(FunButtonStyle(small: true))
                    Text("三项都做完的论文，才是真正「吃透」的论文。不强制，按这篇的价值决定。")
                        .font(serifFont(12)).foregroundColor(.inkSoft)
                }
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color(red: 0.984, green: 0.965, blue: 0.914)))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.gold.opacity(0.5), style: StrokeStyle(lineWidth: 1, dash: [4])))
                }
            }
            .padding(22)
            .frame(maxWidth: 860, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .onChange(of: session.readingKind) {
            if $0 == "apply" { session.notesMode = "迁移" }
            if $0 == "reproduce" { session.notesMode = "复现" }
        }
        .onAppear {
            if session.readingKind == "apply" { session.notesMode = "迁移" }
            if session.readingKind == "reproduce" { session.notesMode = "复现" }
            guard !loaded else { return }
            loaded = true
            let r = store.progress[session.ref.key]?.reflections ?? [:]
            for i in 1...3 where session.drafts["q\(i)"] == nil { session.drafts["q\(i)"] = r["q\(i)"] ?? "" }
            if session.freeNoteDraft.isEmpty { session.freeNoteDraft = store.progress[session.ref.key]?.freeNote ?? "" }
        }
    }

    @ViewBuilder
    private func bindingEditor(_ i: Int) -> some View {
        let key = "q\(i + 1)"
        TextEditor(text: Binding(
            get: { session.drafts[key] ?? "" },
            set: { session.drafts[key] = $0 }
        ))
        .font(serifFont(14))
        .scrollContentBackground(.hidden)
        .frame(minHeight: 64)
        .padding(6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(red: 1, green: 0.996, blue: 0.976)))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(.line))
    }
}

// MARK: - AI 助教面板

struct DrawerView: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var input = ""
    @FocusState private var inputFocus: Bool

    var modeName: String {
        ["explain": "讲解", "problem": "导览", "critique": "挑毛病", "chat": "自由问"][session.chatMode] ?? "自由问"
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                HStack(spacing: 6) {
                    Text("AI 助教").font(serifFont(15, weight: .bold)).foregroundColor(.ink)
                    Text(modeName).font(.system(size: 12)).padding(.horizontal, 9).padding(.vertical, 1)
                        .background(Capsule().fill(.accentSoft)).foregroundColor(.accent)
                }
                Spacer()
                Button("收起 ✕") { session.drawerOpen = false }.buttonStyle(.plain).font(serifFont(13)).foregroundColor(.inkSoft)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider().overlay(.line)
            HStack {
                Picker("范围", selection: $session.chatScope) { ForEach(["全文", "Method", "Experiment", "Appendix", "Figure"], id: \.self) { Text($0).tag($0) } }
                Picker("解释", selection: $session.chatStyle) { ForEach(["直觉解释", "公式解释", "代码解释"], id: \.self) { Text($0).tag($0) } }
            }.font(.system(size: 11)).padding(8).disabled(session.streamBusy)
            Text(session.evidencePhase).font(.system(size: 11)).foregroundColor(.inkSoft)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(session.chat) { m in
                            HStack {
                                if m.role == "user" { Spacer(minLength: 30) }
                                MarkdownView(src: Evidence.linked(m.text.isEmpty && m.pending ? "…" : m.text), size: 14)
                                    .font(serifFont(14))
                                    .textSelection(.enabled)
                                    .padding(.horizontal, 14).padding(.vertical, 9)
                                    .background(RoundedRectangle(cornerRadius: 12).fill(m.role == "user" ? .teal : Color(red: 0.957, green: 0.937, blue: 0.89)))
                                    .foregroundColor(m.role == "user" ? Color(red: 0.95, green: 0.97, blue: 0.96) : .ink)
                                if m.role == "ai" { Spacer(minLength: 30) }
                            }
                            .id(m.id)
                            if m.role == "ai", !m.pending, !m.text.isEmpty {
                                Button("保存为 Idea 线索") { store.newIdea(from: session, text: m.text, origin: .interpretation) }.buttonStyle(FunButtonStyle(small: true)).font(.system(size: 11)).frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(14)
                }
                .onChange(of: session.chat.last?.text ?? "") { _ in
                    if let last = session.chat.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
                .onChange(of: session.chat.count) { _ in
                    if let last = session.chat.last { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
            Divider().overlay(.line)
            HStack(spacing: 8) {
                TextField("问点什么…（或去正文选中一句话）", text: $input)
                    .textFieldStyle(.plain)
                    .font(serifFont(14))
                    .focused($inputFocus)
                    .onSubmit(send)
                Button("送出") { send() }
                    .buttonStyle(FunButtonStyle(primary: true))
                    .disabled(session.streamBusy)
            }
            .padding(12)
        }
        .background(Color.card.ignoresSafeArea())
        .onAppear { inputFocus = true }
    }

    private func send() {
        let v = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty, !session.streamBusy else { return }
        input = ""
        store.sendChat(session, text: v)
    }
}

// MARK: - 实验配置抽取卡（PRD 4.5）

struct ExperimentCard: View {
    let jsonText: String
    var onEvidence: ((Int, String) -> Void)? = nil
    var body: some View {
        if let extraction = try? ExperimentExtraction.decode(jsonText) {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(extraction.groups.filter { $0.0 != "results" }, id: \.0) { key, label, fields in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(key == "training" ? "实现细节 · 环境、超参数与训练设置" : label)
                            .font(serifFont(17, weight: .bold)).foregroundColor(.teal)
                        if fields.isEmpty {
                            Text("当前材料未定位到该项配置，请核对原文与补充材料。")
                                .font(.system(size: 12)).foregroundColor(.inkSoft)
                        } else {
                            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                                GridRow {
                                    Text("配置项").font(.system(size: 12, weight: .semibold))
                                    Text("论文报告的设置").font(.system(size: 12, weight: .semibold))
                                    Text("依据").font(.system(size: 12, weight: .semibold))
                                }
                                ForEach(Array(fields.enumerated()), id: \.offset) { _, item in
                                    Divider().gridCellColumns(3)
                                    GridRow(alignment: .top) {
                                        Text(item.k).font(serifFont(14, weight: .medium)).fixedSize(horizontal: false, vertical: true).frame(maxWidth: 160, alignment: .leading)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(item.v).font(serifFont(14)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                            if let excerpt = item.excerpt {
                                                DisclosureGroup("原文摘录") {
                                                    Text(excerpt).font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled)
                                                }
                                            }
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                        if let page = item.page {
                                            Button("P\(page)") { onEvidence?(page, item.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true))
                                        } else { Text("待核对").font(.system(size: 11)).foregroundColor(.gold) }
                                    }
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.card))
                }
                Text("AI 抽取 · 摘录经过排版归一化校验；点击页码核对事实。未知表示当前材料未找到，图表与补充材料仍需核对。").font(.system(size: 11)).foregroundColor(.inkSoft)
                DisclosureGroup("对比基线 · 领域方法参考") { baselineSection(extraction) }
            }
        } else {
            Text("结构化数据格式无效，请重新生成。").font(.system(size: 13)).foregroundColor(.accent)
        }
    }

    /// 基线方法参考：把论文提到的基线与领域知识对照。
    /// 明确区分「领域常识」与「待核对」，并对未命中的卡片如实说明「未见」。
    @ViewBuilder
    private func baselineSection(_ extraction: ExperimentExtraction) -> some View {
        let names = (extraction.baselines ?? []).map { $0.v.isEmpty ? $0.k : $0.v }
        let hits = BaselineLibrary.matches(baselineNames: names)
        VStack(alignment: .leading, spacing: 8) {
            Text("基线方法参考").font(serifFont(14, weight: .bold)).foregroundColor(.teal)
            if hits.isEmpty {
                Text("当前抽取到的基线字段为空，无法匹配方法卡片。可先重新抽取实验配置。")
                    .font(.system(size: 12)).foregroundColor(.inkSoft)
            } else {
                ForEach(Array(hits.enumerated()), id: \.offset) { _, pair in
                    let card = pair.0
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(card.name).font(serifFont(13, weight: .bold))
                            Text(card.kind.rawValue).font(.system(size: 10))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(card.kind.isNeuralNetwork ? Color.tealSoft : Color.accentSoft))
                            Text(card.source.label).font(.system(size: 10)).foregroundColor(.gold)
                        }
                        if let origin = card.origin { Text("来源：" + origin).font(.system(size: 11)).foregroundColor(.inkSoft) }
                        Text("任务：" + card.task).font(.system(size: 11))
                        Text("输入输出：" + card.inputOutput).font(.system(size: 11))
                        Text("核心思想：" + card.coreIdea).font(.system(size: 11))
                        Text("适用设置：" + card.applicableSettings).font(.system(size: 11)).foregroundColor(.inkSoft)
                        if let lim = card.knownLimitations { Text("已知局限：" + lim).font(.system(size: 11)).foregroundColor(.inkSoft) }
                        Text(BaselineLibrary.relation(card, baselineNames: names)).font(.system(size: 11)).foregroundColor(.teal)
                        Text("卡片为领域常识（非本文抽取结果）；代码链接与逐篇设置请回原文核对。")
                            .font(.system(size: 10)).foregroundColor(.inkSoft)
                    }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.card))
                }
            }
        }
    }
}

struct ReadingAuditView: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    var body: some View {
        if let kind = session.readingKind, let audit = store.loadReadings(session.ref.key)?.audit?[kind] {
            Text("AI 生成 · \(audit.model) · \(audit.generatedAt.prefix(19)) · \(audit.extractionVersion)\n页码已校验；事实与解释仍需结合原文核对。公式转写可能缺符号，请核对 PDF 原式。").font(.system(size: 11)).foregroundColor(.inkSoft)
        } else { Text("历史输出缺少模型与证据审计记录，可重新生成。").font(.system(size: 11)).foregroundColor(.inkSoft) }
    }
}
