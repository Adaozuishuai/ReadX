import SwiftUI

struct IdeasWorkspace: View {
    @ObservedObject var store: Store
    @State private var search = ""
    @State private var status = "全部"
    @State private var deleting: ResearchIdea?
    var filtered: [ResearchIdea] {
        store.ideas.filter { idea in
            (status == "全部" || idea.status.rawValue == status) &&
            (search.isEmpty || [idea.question, idea.observation, idea.hypothesis, idea.method, idea.experiment, idea.evidence.map(\.paperTitle).joined(separator: " ")].joined(separator: " ").localizedCaseInsensitiveContains(search))
        }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("把阅读变成研究问题").font(serifFont(27, weight: .bold)).foregroundColor(.ink)
                    Spacer()
                    Button("导出 Markdown") { store.exportIdeas() }.disabled(store.ideas.isEmpty)
                    Button("新建 Idea") { store.ideaDraft = ResearchIdea() }.buttonStyle(FunButtonStyle(primary: true)).disabled(store.ideasLoadFailed)
                }
                Text("记录问题、观察、假设、方法草图和验证实验。原文摘录与 AI 解释、研究建议分开标识；假设需要实验验证。").font(serifFont(13)).foregroundColor(.inkSoft)
                HStack {
                    TextField("搜索研究问题、假设或关联论文", text: $search).textFieldStyle(.roundedBorder)
                    Picker("状态", selection: $status) { Text("全部").tag("全部"); ForEach(IdeaStatus.allCases, id: \.self) { Text($0.label).tag($0.rawValue) } }.frame(width: 160)
                }
                if filtered.isEmpty { Card { Text("还没有匹配的研究条目。可从精读室的原文选择、AI 回答或迁移建议创建 Idea。").foregroundColor(.inkSoft) } }
                ForEach(filtered) { idea in
                    Card {
                        HStack(alignment: .top) {
                            Text(idea.question).font(serifFont(18, weight: .bold)).foregroundColor(.ink)
                            Spacer()
                            Text(idea.status.label).font(.system(size: 12)).foregroundColor(.teal)
                        }
                        if !idea.hypothesis.isEmpty { Text("假设 · " + idea.hypothesis).font(serifFont(14)).foregroundColor(.inkSoft).lineLimit(3) }
                        if !idea.experiment.isEmpty { Text("验证实验 · " + idea.experiment).font(serifFont(13)).foregroundColor(.inkSoft).lineLimit(3) }
                        Text("\(idea.evidence.count) 条关联材料 · 更新 \(idea.updatedAt.prefix(10))").font(.system(size: 11)).foregroundColor(.inkSoft)
                        HStack {
                            Button("查看 / 编辑") { store.ideaDraft = idea }
                            ForEach(Array(idea.evidence.filter { $0.origin == .paper }.prefix(2))) { evidence in
                                Button("原文 Page \(evidence.page ?? 1)") { store.openIdeaEvidence(evidence) }.buttonStyle(FunButtonStyle(small: true))
                            }
                            Spacer()
                            Button("删除", role: .destructive) { deleting = idea }.buttonStyle(FunButtonStyle(small: true))
                        }
                    }
                }
            }.padding(28)
        }
        .confirmationDialog("删除此 Idea 及其个人内容？此操作无法撤销，论文和 PDF 会保留。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除 Idea", role: .destructive) { if let deleting { _ = store.deleteIdea(deleting.id) }; deleting = nil }.buttonStyle(FunButtonStyle(small: true))
        }
    }
}

struct IdeaEditor: View {
    @ObservedObject var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var draft: ResearchIdea
    @State private var paperKey = ""
    @State private var page = ""
    @State private var excerpt = ""
    @State private var origin: EvidenceOrigin = .paper
    @State private var error: String?
    @State private var busy = false
    init(store: Store, idea: ResearchIdea) { self.store = store; _draft = State(initialValue: idea) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Idea / 实验假设").font(serifFont(22, weight: .bold)).foregroundColor(.ink)
                Spacer()
                Picker("状态", selection: $draft.status) { ForEach(IdeaStatus.allCases, id: \.self) { Text($0.label).tag($0) } }.frame(width: 180)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    field("Research Question · 研究问题", $draft.question, height: 50)
                    field("Observation · 观察（注明来源）", $draft.observation)
                    field("Hypothesis · 假设，尚需验证", $draft.hypothesis)
                    field("Method Sketch · 方法草图 / 模块", $draft.method)
                    field("Experiment · 要补的实验与评测协议", $draft.experiment)
                    Text("Evidence · 关联材料").font(serifFont(15, weight: .bold)).foregroundColor(.teal)
                    ForEach(draft.evidence) { evidence in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(evidence.origin.rawValue + " · " + evidence.paperTitle).font(.system(size: 12, weight: .medium)).foregroundColor(evidence.origin == .paper ? .teal : .gold)
                                Spacer()
                                if let page = evidence.page {
                                    Button("保存并查看 Page \(page)") {
                                        if store.saveIdea(draft) { dismiss(); store.openIdeaEvidence(evidence) }
                                        else { error = store.dataError }
                                    }.buttonStyle(FunButtonStyle(small: true))
                                }
                                Button("移除") { draft.evidence.removeAll { $0.id == evidence.id } }.buttonStyle(FunButtonStyle(small: true))
                            }
                            Text(evidence.excerpt).font(serifFont(13)).textSelection(.enabled)
                            if evidence.origin == .paper { Text("逐字摘录与页码已核对；对事实含义的解释仍需人工判断。").font(.system(size: 10)).foregroundColor(.inkSoft) }
                        }.padding(10).background(RoundedRectangle(cornerRadius: 8).fill(Color.tealSoft.opacity(0.5)))
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("关联论文", selection: $paperKey) { Text("请选择论文").tag(""); ForEach(store.savedPapers, id: \.key) { Text($0.title ?? $0.key).tag($0.key) } }
                        HStack {
                            Picker("材料类型", selection: $origin) { ForEach(EvidenceOrigin.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                            if origin == .paper { TextField("PDF 物理页码", text: $page).textFieldStyle(.roundedBorder).frame(width: 130) }
                        }
                        TextEditor(text: $excerpt).frame(height: 75).border(Color.line)
                        Text(origin == .paper ? "从 PDF 粘贴逐字摘录；附着前会核对该页文字。" : "此材料作为思考线索保存，不作为论文原文事实。").font(.system(size: 11)).foregroundColor(.inkSoft)
                        Button(busy ? "正在核对…" : "附着材料") { attach() }.buttonStyle(FunButtonStyle(teal: true, small: true)).disabled(busy || paperKey.isEmpty || excerpt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }.padding(12).background(Color.card)
                }.padding(.trailing, 6)
            }
            if let error { Text(error).font(.system(size: 12)).foregroundColor(.accent).fixedSize(horizontal: false, vertical: true) }
            HStack {
                Text("保存在本机；保存按钮提交本次编辑。").font(.system(size: 11)).foregroundColor(.inkSoft)
                Spacer()
                Button("取消") { dismiss() }.disabled(busy)
                Button("保存 Idea") { if store.saveIdea(draft) { dismiss() } else { error = store.dataError } }.buttonStyle(FunButtonStyle(primary: true)).disabled(busy || draft.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(24).frame(width: 720, height: 730).background(Color.paper).disabled(store.ideasLoadFailed)
    }
    func field(_ label: String, _ text: Binding<String>, height: CGFloat = 65) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(label).font(.system(size: 12, weight: .medium)).foregroundColor(.inkSoft); TextEditor(text: text).frame(height: height).border(Color.line) }
    }
    func attach() {
        guard let paper = store.savedPapers.first(where: { $0.key == paperKey }) else { return }
        let selectedOrigin = origin
        var evidence = IdeaEvidence(paperKey: paper.key, paperTitle: paper.title ?? paper.key, origin: selectedOrigin, page: selectedOrigin == .paper ? Int(page) : nil, excerpt: excerpt)
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                if selectedOrigin == .paper {
                    let source = try await store.ensurePDFText(for: store.reference(paper))
                    try evidence.validate(source: source)
                    evidence.verifiedAt = ISO8601DateFormatter().string(from: Date())
                }
                draft.evidence.append(evidence); excerpt = ""
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct ApplicationPanel: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("迁移到我的研究").font(serifFont(22, weight: .bold)).foregroundColor(.ink)
            Text(store.profile.context).font(.system(size: 12)).foregroundColor(.inkSoft)
            HStack {
                Button("基于画像生成建议") { store.openReading(session, kind: "apply", regenerate: true) }.buttonStyle(FunButtonStyle(primary: true)).disabled(session.readingBusy(for: "apply"))
                Text("AI 研究建议 · 尚未经过实验验证").font(.system(size: 11)).foregroundColor(.gold)
            }
            if session.readingKind == "apply" || session.readingBusy(for: "apply") {
                if session.readingBusy(for: "apply") { HStack { ProgressView(); Text(session.evidencePhase(for: "apply")) } }
                else if let error = session.readingError(for: "apply") { Text(error).foregroundColor(.accent) }
                else if let application = try? ResearchApplication.decode(session.readingText(for: "apply")) {
                    if let snapshot = store.loadReadings(session.ref.key)?.applicationProfile, snapshot != store.profile {
                        Text("画像已变更；以下为旧画像下的建议，可重新生成。").font(.system(size: 12)).foregroundColor(.accent)
                    }
                    ForEach(application.groups, id: \.0) { _, label, items in
                        Card {
                            Text(label).font(serifFont(16, weight: .bold)).foregroundColor(.teal)
                            if items.isEmpty { Text("尚无足够依据的建议").font(.system(size: 12)).foregroundColor(.inkSoft) }
                            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(item.title).font(serifFont(15, weight: .bold))
                                    MarkdownView(src: Evidence.linked("研究建议 · " + item.suggestion), size: 14)
                                    MarkdownView(src: Evidence.linked("约束 / 前提 · " + item.constraint), size: 12)
                                    MarkdownView(src: Evidence.linked("验证实验 · " + item.verification), size: 12)
                                    ForEach(Array(item.evidence.enumerated()), id: \.offset) { _, field in
                                        HStack(alignment: .top) {
                                            Text("论文依据：\(field.k) · \(field.v)\n\(field.excerpt ?? "")").font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled)
                                            Spacer()
                                            if let page = field.page { Button("Page \(page)") { store.jumpToEvidence(session, page: page, excerpt: field.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true)) }
                                        }
                                    }
                                    Button("转为 Idea / 实验计划") { store.ideaFromAdvice(item, ref: session.ref) }.buttonStyle(FunButtonStyle(small: true))
                                }.padding(.vertical, 8)
                            }
                        }
                    }
                    ReadingAuditView(store: store, session: session)
                }
            }
        }.padding(22)
    }
}
