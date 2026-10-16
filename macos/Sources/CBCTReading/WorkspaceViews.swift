import SwiftUI
import AppKit

struct WorkspaceView: View {
    @ObservedObject var store: Store
    var body: some View { FunWorkspace(store: store) }
}

struct PaperCard: View {
    @ObservedObject var store: Store
    let ranked: RankedPaper
    var paper: QueueEntry { ranked.paper }
    var body: some View {
        Card {
            HStack(alignment: .top) {
                Text(paper.title ?? paper.key).font(serifFont(18, weight: .semibold)).foregroundColor(.ink).textSelection(.enabled)
                Spacer()
                Text("\(ranked.score) / 100").font(.system(size: 12, weight: .semibold)).foregroundColor(.teal).padding(7).background(Capsule().fill(Color.tealSoft))
            }
            Text([paper.source ?? "手动入库", paper.venue ?? "", paper.published ?? paper.year ?? "日期未提供"].filter { !$0.isEmpty }.joined(separator: " · ")).font(serifFont(12)).foregroundColor(.inkSoft)
            if let authors = paper.authors, !authors.isEmpty { Text(authors.prefix(3).joined(separator: ", ") + (authors.count > 3 ? " 等" : "")).font(.system(size: 12)).foregroundColor(.inkSoft) }
            let readMinutes = max(8, min(30, (paper.abstract?.count ?? 1200) / 180))
            // 代码状态取自真实快照；「待核实」原先写死，扫描完成后首页仍提示未核。
            let codeState = store.codeSnapshots[paper.key] != nil ? "已扫描" : "待核实"
            Text("全文：" + ((paper.arxiv != nil || paper.pdfUrl != nil || store.findLibraryPDF(paper.key) != nil) ? "可获取" : "需导入") + " · 代码：\(codeState) · 精读约 \(readMinutes) 分钟（按摘要长度估计）").font(.system(size: 11)).foregroundColor(.inkSoft)
            ForEach(ranked.reasons, id: \.self) { reason in Label(reason, systemImage: "sparkle").font(.system(size: 13)).foregroundColor(.teal) }
            if let abstract = paper.abstract, !abstract.isEmpty { Text(abstract).font(serifFont(13)).foregroundColor(.inkSoft).lineLimit(3) }
            HStack(spacing: 12) {
                Button("精读 →") { store.openReader(store.reference(paper)) }.buttonStyle(FunButtonStyle(primary: true))
                Button("稍后读") { store.addToQueue(paper) }.buttonStyle(FunButtonStyle())
                Button(store.state(paper.key).favorite ? "已收藏 ★" : "收藏 ☆") { store.mutateLibrary(paper.key) { $0.favorite.toggle() } }.buttonStyle(FunButtonStyle())
                Menu("反馈") {
                    Button("相关") { store.mutateLibrary(paper.key) { $0.relevance = 1 } }
                    Button("不相关") { store.mutateLibrary(paper.key) { $0.relevance = -1 } }
                    Button("忽略") { store.mutateLibrary(paper.key) { $0.status = .ignored } }
                }.frame(width: 75)
                Spacer()
                Text(store.state(paper.key).status.label).font(.system(size: 12)).foregroundColor(.inkSoft)
            }
        }
    }
}

struct LibraryWorkspace: View {
    @ObservedObject var store: Store
    var search: String { store.workspaceSearch }
    @State private var filter = "全部"
    @State private var editing: SelectedPaper?
    @State private var purgeConfirm: String?
    let filters = ["全部", "收藏", "未读", "稍后读", "精读中", "已读", "忽略", "不相关"]
    var papers: [QueueEntry] {
        let followedTopics = TopicNavigation.topics(store)
        return store.savedPapers.filter { paper in
            let state = store.state(paper.key)
            let haystack = [paper.title ?? "", paper.abstract ?? "", state.tags.joined(separator: " "), state.notes].joined(separator: " ")
            return TopicNavigation.matchesLibraryFilter(paper, topic: store.workspaceTopic, followedTopics: followedTopics) && (search.isEmpty || haystack.localizedCaseInsensitiveContains(search)) &&
                (filter == "全部" || (filter == "收藏" && state.favorite) || (filter == "不相关" && state.relevance == -1) || state.status.label == filter)
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(store.workspaceTopic.map { "论文库 · " + $0 } ?? "你的研究论文库").font(serifFont(27, weight: .bold)).foregroundColor(.ink)
                Text("阅读状态、标签、笔记与纠错随时保存；原有 Markdown 精读笔记独立保留。").font(serifFont(13)).foregroundColor(.inkSoft)
                if store.workspaceTopic != nil { Button("清除主题筛选") { store.workspaceTopic = nil }.buttonStyle(FunButtonStyle(small: true)) }
                HStack { TextField("搜索标题、摘要、标签或笔记", text: $store.workspaceSearch).textFieldStyle(.roundedBorder); Picker("状态", selection: $filter) { ForEach(filters, id: \.self) { Text($0).tag($0) } }.frame(width: 190) }
                HStack(spacing: 10) {
                    Menu("导出全部引用（\(papers.count) 篇）") {
                        Button("BibTeX (.bib)…") { store.exportCitations(papers, format: "bibtex") }
                        Button("RIS (.ris)…") { store.exportCitations(papers, format: "ris") }
                    }.disabled(papers.isEmpty)
                    Text("导出当前筛选结果；含 arXiv 号、DOI、作者与年份。").font(.system(size: 11)).foregroundColor(.inkSoft)
                }
                if papers.isEmpty { Card { Text("没有匹配的论文。可调整筛选或导入 PDF。").foregroundColor(.inkSoft) } }
                ForEach(papers, id: \.key) { paper in
                    Card {
                        HStack {
                            Text(paper.title ?? paper.key).font(serifFont(17, weight: .semibold)).foregroundColor(.ink)
                            Spacer()
                            Button(store.selectedComparison.contains(paper.key) ? "已选对比 ✓" : "加入对比") {
                                if store.selectedComparison.contains(paper.key) { store.selectedComparison.remove(paper.key) }
                                else if store.selectedComparison.count < 8 { store.selectedComparison.insert(paper.key) }
                                else { store.showToast("最多选择 8 篇论文") }
                            }.buttonStyle(FunButtonStyle())
                        }
                        Text("\(paper.venue ?? "") · \(store.state(paper.key).status.label)\(store.state(paper.key).favorite ? " · ★ 收藏" : "")").font(.system(size: 12)).foregroundColor(.inkSoft)
                        let tags = store.state(paper.key).tags
                        if !tags.isEmpty { Text(tags.map { "#" + $0 }.joined(separator: "  ")).font(.system(size: 12)).foregroundColor(.teal) }
                        HStack {
                            Button("打开精读") { store.openReader(store.reference(paper)) }.buttonStyle(FunButtonStyle(primary: true))
                            Button("状态 / 标签 / 笔记 / 纠错") { editing = SelectedPaper(paper: paper) }.buttonStyle(FunButtonStyle())
                            if let note = store.noteForQueue(paper) { Button("原有精读笔记 ↗") { NSWorkspace.shared.open(store.papersDir.appendingPathComponent(note.file)) }.buttonStyle(FunButtonStyle()) }
                            Menu("引用") {
                                Button("复制 BibTeX") {
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(CitationExport.bibtex(paper), forType: .string)
                                    store.showToast("已复制 BibTeX")
                                }
                                Button("导出 BibTeX…") { store.exportCitation(for: paper, format: "bibtex") }
                                Button("导出 RIS…") { store.exportCitation(for: paper, format: "ris") }
                            }.frame(width: 70)
                            Spacer()
                            Button("删除") { store.deletePaper(paper.key) }.buttonStyle(FunButtonStyle(small: true))
                        }
                    }
                }
                // 回收站（PRD 8.3：支持删除与恢复个人论文库）
                let deleted = store.deletedPapers
                if !deleted.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("回收站 · \(deleted.count) 篇").font(serifFont(19, weight: .bold)).foregroundColor(.ink)
                        Text("删除的论文保留标签/笔记/纠错，可恢复；「彻底删除」移除全部本地记录且不可恢复（精读记录与 Markdown 笔记保留）。").font(.system(size: 12)).foregroundColor(.inkSoft)
                        ForEach(deleted, id: \.key) { paper in
                            Card {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(paper.title ?? paper.key).font(serifFont(15, weight: .semibold)).foregroundColor(.inkSoft)
                                        Text(paper.venue ?? "").font(.system(size: 11)).foregroundColor(.inkSoft)
                                    }
                                    Spacer()
                                    Button("恢复") { store.restorePaper(paper.key) }.buttonStyle(FunButtonStyle(small: true))
                                    if purgeConfirm == paper.key {
                                        Button("确认彻底删除？") { store.purgePaper(paper.key); purgeConfirm = nil }.buttonStyle(FunButtonStyle(primary: true, small: true))
                                        Button("取消") { purgeConfirm = nil }.buttonStyle(FunButtonStyle(small: true))
                                    } else {
                                        Button("彻底删除") { purgeConfirm = paper.key }.buttonStyle(FunButtonStyle(small: true))
                                    }
                                }
                            }
                        }
                    }
                }
            }.padding(28)
        }
        .sheet(item: $editing) { selected in LibraryEditor(store: store, paper: selected.paper) }
    }
}

struct SelectedPaper: Identifiable { var paper: QueueEntry; var id: String { paper.key } }

struct LibraryEditor: View {
    @ObservedObject var store: Store
    let paper: QueueEntry
    @Environment(\.dismiss) var dismiss
    @State private var tags = ""
    @State private var personalNote = ""
    @State private var correction = ""
    @State private var loaded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(paper.title ?? paper.key).font(serifFont(20, weight: .bold)).lineLimit(3)
            HStack {
                Picker("阅读状态", selection: Binding(get: { store.state(paper.key).status }, set: { value in store.mutateLibrary(paper.key) { $0.status = value } })) { ForEach(LibraryStatus.allCases.filter { $0 != .deleted }, id: \.self) { Text($0.label).tag($0) } }
                Toggle("收藏", isOn: Binding(get: { store.state(paper.key).favorite }, set: { value in store.mutateLibrary(paper.key) { $0.favorite = value } }))
            }
            Picker("推荐反馈", selection: Binding(get: { store.state(paper.key).relevance }, set: { value in store.mutateLibrary(paper.key) { $0.relevance = value } })) { Text("未评价").tag(0); Text("相关").tag(1); Text("不相关").tag(-1) }.pickerStyle(.segmented)
            TextField("自定义标签，用逗号分隔", text: $tags).textFieldStyle(.roundedBorder)
                .onChange(of: tags) { value in if loaded { store.mutateLibrary(paper.key) { $0.tags = value.replacingOccurrences(of: "，", with: ",").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } } } }
            systemTagSection
            Text("个人笔记 · 自动保存").font(.system(size: 12, weight: .medium)).foregroundColor(.teal)
            TextEditor(text: $personalNote).frame(height: 110).border(Color.line)
                .onChange(of: personalNote) { value in if loaded { store.mutateLibrary(paper.key) { $0.notes = value } } }
            Text("AI 纠错反馈 · 重新生成时作为待核对问题，仍以原文为准").font(.system(size: 12)).foregroundColor(.inkSoft)
            TextEditor(text: $correction).frame(height: 75).border(Color.line)
                .onChange(of: correction) { value in if loaded { store.mutateLibrary(paper.key) { $0.corrections = value } } }
            HStack { Button("为该论文导入全文 PDF") { store.importPDF(for: paper) }; Spacer(); Button("完成") { dismiss() }.buttonStyle(FunButtonStyle(primary: true)) }
        }.padding(26).frame(width: 640)
        .onAppear { let state = store.state(paper.key); tags = state.tags.joined(separator: ", "); personalNote = state.notes; correction = state.corrections; loaded = true }
    }
    /// 系统标签（PRD 7.2）：八类只读派生标签 + 命中依据 + 类别覆盖情况。
    @ViewBuilder
    private var systemTagSection: some View {
        let sys = store.systemTags(for: paper)
        VStack(alignment: .leading, spacing: 6) {
            Text("系统标签（自动派生，可核对依据）").font(.system(size: 12, weight: .medium)).foregroundColor(.gold)
            if sys.isEmpty {
                Text("未从标题/摘要/实验字段中匹配到系统标签。").font(.system(size: 11)).foregroundColor(.inkSoft)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(sys.enumerated()), id: \.offset) { _, tag in
                        Text("\(tag.category.label) · \(tag.value)")
                            .font(.system(size: 11))
                            .help("命中依据：「\(tag.evidence)」")
                    }
                }
            }
            // PRD 7.2 要求「至少覆盖」八类：明确列出未覆盖的类别，而不是假装都有
            let missing = SystemTags.coverage(sys).filter { $0.1 == 0 }.map { $0.0.label }
            if !missing.isEmpty {
                Text("未涉及：" + missing.joined(separator: "、")).font(.system(size: 10)).foregroundColor(.inkSoft)
            }
        }
    }
}

struct ProfileWorkspace: View {
    @ObservedObject var store: Store
    @State private var draft = ResearchProfile()
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("让推荐更贴近你的研究").font(serifFont(27, weight: .bold)).foregroundColor(.ink)
                Text("关闭不关注的主题，或提高权重。画像用于推荐与建议，论文事实始终以原文为准。").font(serifFont(13)).foregroundColor(.inkSoft)
                Card {
                    Text("主题订阅与权重").font(serifFont(17, weight: .bold)).foregroundColor(.teal)
                    ForEach(ResearchProfile.keywords.keys.sorted(), id: \.self) { topic in
                        HStack { Text(topic).frame(width: 140, alignment: .leading); Picker("关注权重", selection: Binding(get: { draft.topics[topic] ?? 0 }, set: { draft.topics[topic] = $0 })) { Text("关闭").tag(0); Text("关注").tag(1); Text("重点").tag(2); Text("核心").tag(3) }.pickerStyle(.segmented) }
                    }
                }
                Card {
                    field("当前研究任务", $draft.task)
                    field("常用数据集（逗号分隔）", $draft.datasets)
                    field("技术偏好", $draft.methods)
                    field("评价指标", $draft.metrics)
                    field("硬件与算力约束", $draft.hardware)
                }
                Button("保存画像并更新推荐") { store.saveProfile(draft) }.buttonStyle(FunButtonStyle(primary: true))
            }.padding(28).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }.onAppear { draft = store.profile }
    }
    func field(_ label: String, _ binding: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(label).font(.system(size: 12, weight: .medium)).foregroundColor(.inkSoft); TextField(label, text: binding).textFieldStyle(.roundedBorder) }
    }
}

struct CompareWorkspace: View {
    @ObservedObject var store: Store
    @State private var dimension = "全部"
    /// 固定列持久化在 store（app/data/compare.json），重启后恢复（PRD 4.8 对比可保存）
    var pinnedKey: String? { store.comparePinned }
    var selected: [QueueEntry] { store.allPapers.filter { store.selectedComparison.contains($0.key) } }
    /// 固定列优先：被固定的论文排到最前，其余保持原顺序（PRD 5.3「可固定列」）。
    var orderedSelected: [QueueEntry] {
        let map = Dictionary(uniqueKeysWithValues: selected.map { ($0.key, $0) })
        return CompareLayout.orderedKeys(selected.map(\.key), pinned: pinnedKey).compactMap { map[$0] }
    }
    var rows: [(String, [String])] {
        let fields = dimension == "模型结构" ? ["task", "volume_repr", "projection_use", "key_modules"] : dimension == "实验协议" ? ["views", "geometry", "dataset", "acquisition", "training", "loss", "baselines", "metrics", "results"] : ["task", "volume_repr", "projection_use", "geometry", "views", "dataset", "training", "baselines", "metrics", "results", "code"]
        return fields.map { field in
            let labels = ["task": "任务", "volume_repr": "表示 / 网络", "projection_use": "输入输出与投影约束", "geometry": "几何", "views": "视角数", "dataset": "数据集", "acquisition": "采集设置", "training": "训练与硬件", "loss": "损失", "baselines": "对比基线", "metrics": "指标", "results": "结果", "code": "代码", "key_modules": "核心模块"]
            return (labels[field] ?? field, orderedSelected.map { paper in
                let note = store.noteForQueue(paper)
                if let experiment = store.loadReadings(paper.key)?.experimentJSON, let extraction = try? ExperimentExtraction.decode(experiment) {
                    let fields: [ExperimentField]
                    if field == "views" { fields = extraction.acquisition.filter { $0.k.localizedCaseInsensitiveContains("view") || $0.k.contains("投影数") || $0.k.contains("投影总数") } }
                    else if field == "geometry" { fields = extraction.acquisition.filter { item in ["几何", "角度", "范围", "SOD", "SDD", "分辨率"].contains { item.k.localizedCaseInsensitiveContains($0) } } }
                    else { fields = extraction.groups.first(where: { $0.0 == field })?.2 ?? [] }
                    if !fields.isEmpty { return fields.map { "\($0.k)：\($0.v)" + ($0.page.map { " (Page \($0))" } ?? "") }.joined(separator: "；") }
                }
                let key = field == "dataset" ? "data" : field
                if let value = note?.meta[key]?.str { return value + " [研究笔记，需核对]" }; return "论文未说明 / 尚未抽取"
            })
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("方法与实验对比").font(serifFont(27, weight: .bold)).foregroundColor(.ink); Spacer(); Button("选择论文") { store.workspacePage = "Library" }.buttonStyle(FunButtonStyle()) }
                Text("在论文库选择 2–8 篇。选择集与固定列自动保存，重启后恢复。").font(serifFont(13)).foregroundColor(.inkSoft)
                // 跨协议可比性检查（PRD 12）：views/几何/数据集已知值不一致时显式警示，不做自动排名
                ForEach(Comparability.warnings(rows: rows), id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle").font(.system(size: 12)).foregroundColor(.gold)
                }
                HStack { Picker("维度", selection: $dimension) { ForEach(["全部", "模型结构", "实验协议"], id: \.self) { Text($0).tag($0) } }.pickerStyle(.segmented); Button("Markdown") { export("md") }.buttonStyle(FunButtonStyle(small: true)).disabled(selected.count < 2); Button("CSV") { export("csv") }.buttonStyle(FunButtonStyle(small: true)).disabled(selected.count < 2) }
                if selected.count < 2 { Card { Text("请选择至少两篇论文开始对比。").foregroundColor(.inkSoft) } }
                else {
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(alignment: .top) {
                                Text("维度").frame(width: 120, alignment: .leading)
                                ForEach(orderedSelected, id: \.key) { paper in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(paper.title ?? paper.key).font(.system(size: 13, weight: .bold)).lineLimit(2)
                                        // PRD 5.3「可固定列」：固定后该列排到最前，再点一次取消
                                        Button(CompareLayout.isPinned(paper.key, pinned: pinnedKey) ? "已固定 📌" : "固定此列") {
                                            store.comparePinned = CompareLayout.toggled(paper.key, current: pinnedKey)
                                        }.buttonStyle(FunButtonStyle(small: true)).font(.system(size: 11))
                                    }.frame(width: 250, alignment: .leading)
                                }
                            }.padding(12).background(Color.tealSoft)
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                                HStack(alignment: .top) {
                                    Text(row.0).font(.system(size: 13, weight: .semibold)).frame(width: 120, alignment: .leading)
                                    ForEach(Array(row.1.enumerated()), id: \.offset) { i, text in
                                        MarkdownView(src: Evidence.linked(text), size: 13).frame(width: 250, alignment: .leading)
                                            .environment(\.openURL, OpenURLAction { url in
                                                if url.scheme == "cbct-evidence", let page = Int(url.lastPathComponent) {
                                                    guard store.openReader(store.reference(orderedSelected[i])) else { return .handled }
                                                    if let s = store.session { store.jumpToEvidence(s, page: page) }
                                                    return .handled
                                                }
                                                return .systemAction
                                            })
                                    }
                                }.padding(12).background(index % 2 == 0 ? Color.card : Color.paper)
                            }
                        }
                    }
                }
                HStack(spacing: 12) {
                    Button("清空选择") { store.selectedComparison.removeAll() }.buttonStyle(FunButtonStyle(small: true))
                    if pinnedKey != nil { Button("取消固定") { store.comparePinned = nil }.buttonStyle(FunButtonStyle(small: true)) }
                }
            }.padding(28)
        }
    }
    func export(_ format: String) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "CBCT-comparison.\(format)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let matrix = [["维度"] + orderedSelected.map { $0.title ?? $0.key }] + rows.map { [$0.0] + $0.1 }
        let text: String
        if format == "csv" { text = "\u{FEFF}" + matrix.map { $0.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: ",") }.joined(separator: "\r\n") }
        else {
            let lines = matrix.map { "| " + $0.map { $0.replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: "<br>") }.joined(separator: " | ") + " |" }
            text = ([lines[0], "| " + Array(repeating: "---", count: orderedSelected.count + 1).joined(separator: " | ") + " |"] + lines.dropFirst() + ["\n注：不同实验协议的指标不可直接排名；研究笔记字段需要回原文核对。"]).joined(separator: "\n")
        }
        do { try text.write(to: url, atomically: true, encoding: .utf8) } catch { store.dataError = error.localizedDescription }
    }
}
