import SwiftUI

struct ReproductionPanel: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("复现准备").font(serifFont(24, weight: .bold))
            Text("从资源、环境、训练成本、关键缺失和风险五个维度准备复现。当前分析依据论文材料；仓库、数据下载和训练需要实际核对。").font(.system(size: 13)).foregroundColor(.inkSoft)
            Button(session.readingKind == "reproduce" && !session.readingText(for: "reproduce").isEmpty ? "重新分析论文材料" : "分析复现条件") {
                store.openReading(session, kind: "reproduce", regenerate: true)
            }.buttonStyle(FunButtonStyle(primary: true)).disabled(session.readingBusy(for: "reproduce"))
            if session.readingKind == "reproduce" || session.readingBusy(for: "reproduce") {
                if session.readingBusy(for: "reproduce") { HStack { ProgressView(); Text(session.evidencePhase(for: "reproduce")) } }
                else if let error = session.readingError(for: "reproduce") { Text(error).foregroundColor(.accent).textSelection(.enabled) }
                else if let analysis = try? ReproductionAnalysis.decode(session.readingText(for: "reproduce")) {
                    let record = store.reproductionChecklists[session.ref.key]
                    let verified = record?.revisions[analysis.fingerprint]?.values.filter { $0.status == .verified }.count ?? 0
                    HStack {
                        Text("人工已核对 \(verified)/\(analysis.itemCount) 项 · \(analysis.itemCount - analysis.unknownCount) 条报告信息 / \(analysis.unknownCount) 条待查字段").font(.system(size: 12)).foregroundColor(.teal)
                        Spacer()
                        Button("导出复现清单") { store.exportReproduction(analysis, ref: session.ref) }.buttonStyle(FunButtonStyle())
                    }
                    Text("已核对表示记录了人工检查，复现是否成功需实验结果确认。重新分析后使用新的核对清单，旧版记录保留在研究资产导出中。").font(.system(size: 11)).foregroundColor(.inkSoft)
                    if store.reproductionLoadFailures.contains(session.ref.key) || store.reproductionDirectoryFailed {
                        Text("本地核对记录读取失败，已停止覆盖；请恢复原文件后重新打开应用。").font(.system(size: 12)).foregroundColor(.accent)
                    }
                    ForEach(analysis.groups, id: \.0) { group, label, items in
                        Card {
                            Text(label).font(serifFont(17, weight: .bold)).foregroundColor(.teal)
                            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(item.title).font(serifFont(15, weight: .bold))
                                    Text(item.isUnknown ? "当前材料未找到 · 请查原 PDF / 补充材料 / 代码" : "论文报告 · 尚需人工核对").font(.system(size: 11)).foregroundColor(item.isUnknown ? .gold : .teal)
                                    Text(item.finding.v).font(serifFont(14)).textSelection(.enabled)
                                    if let quote = item.finding.excerpt, let page = item.finding.page {
                                        HStack(alignment: .top) {
                                            Text("原文：" + quote).font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled)
                                            Spacer()
                                            Button("Page \(page)") { store.jumpToEvidence(session, page: page, excerpt: quote) }.buttonStyle(FunButtonStyle(small: true))
                                        }
                                    }
                                    MarkdownView(src: Evidence.linked("AI 分析 / 推断 · " + item.assessment), size: 13)
                                    MarkdownView(src: Evidence.linked("建议行动 · " + item.action), size: 13)
                                    Button("转为 Idea / 待实验计划") { store.ideaFromReproduction(item, ref: session.ref) }.buttonStyle(FunButtonStyle(small: true))
                                    ReproductionTaskEditor(store: store, key: session.ref.key, analysis: analysis, itemID: group + ":" + String(index))
                                        .id(analysis.fingerprint + group + String(index))
                                }.padding(.vertical, 10)
                                if index < items.count - 1 { Divider() }
                            }
                        }
                    }
                    // R-11：仓库依赖核对（复用代码快照，规则扫描，不执行仓库代码）
                    let repoChecks = store.repoChecks(for: session.ref.key)
                    if !repoChecks.isEmpty {
                        Card {
                            Text("仓库依赖核对 · 来自代码快照").font(serifFont(17, weight: .bold)).foregroundColor(.teal)
                            Text("规则扫描仓库快照得到的依赖声明与数据/权重下载指引；未访问网络、未执行仓库代码。核对后才可确认环境与素材可得性。").font(.system(size: 11)).foregroundColor(.inkSoft)
                            ForEach(repoChecks) { check in
                                RepoCheckRow(store: store, key: session.ref.key, check: check)
                                Divider()
                            }
                        }
                    }
                    ReadingAuditView(store: store, session: session)
                } else { Text("复现分析格式无效，请重新分析。").foregroundColor(.accent) }
            }
        }.padding(22)
        .onAppear {
            // 只在当前没有展示任何阅读产物时才回填复现分析；
            // 否则会抢走正在显示的迁移/结果等内容（readingKind 是全局单值，曾为线上 bug，勿放宽条件）
            if session.readingKind == nil, store.loadReadings(session.ref.key)?.reproductionJSON != nil {
                store.openReading(session, kind: "reproduce")
            }
        }
    }
}

// MARK: - R-11 仓库依赖核对行

private struct RepoCheckRow: View {
    @ObservedObject var store: Store
    let key: String
    let check: RepoDependencyCheck
    @State private var task: ReproductionTask
    @State private var error: String?
    @State private var saved = false
    init(store: Store, key: String, check: RepoDependencyCheck) {
        self.store = store; self.key = key; self.check = check
        _task = State(initialValue: store.repoCheckTask(key: key, checkID: check.id))
    }
    private var hasUnsavedChanges: Bool {
        let persisted = store.repoCheckTask(key: key, checkID: check.id)
        return persisted.status != task.status || persisted.note != task.note
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("[\(check.kind)]").font(.system(size: 12, weight: .bold)).foregroundColor(check.kind == "依赖" ? .teal : .gold)
                Text(check.path + (check.line.map { ":\($0)" } ?? "")).font(.system(size: 12, weight: .semibold)).textSelection(.enabled)
                Spacer()
                Text(store.repoCheckTask(key: key, checkID: check.id).status.label + (hasUnsavedChanges ? " · 未保存" : "")).font(.system(size: 11)).foregroundColor(.inkSoft)
            }
            Text(check.detail).font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled)
            HStack {
                Picker("核对状态", selection: $task.status) { ForEach(ReproductionTaskStatus.allCases, id: \.self) { Text($0.label).tag($0) } }.pickerStyle(.segmented).frame(width: 220)
                TextField("核对记录（结论 / commit / 受阻原因）", text: $task.note).textFieldStyle(.roundedBorder).font(.system(size: 11))
                Button("保存") {
                    if store.saveRepoCheckTask(key: key, check: check, task: task) { error = nil; saved = true } else { error = store.dataError; saved = false }
                }.buttonStyle(FunButtonStyle(small: true))
                if saved { Text("已保存").font(.system(size: 11)).foregroundColor(.teal) }
            }
            if let error { Text(error).font(.system(size: 11)).foregroundColor(.accent) }
        }.padding(.vertical, 6)
        .disabled(store.reproductionLoadFailures.contains(key) || store.reproductionDirectoryFailed)
        .onChange(of: task.status) { _ in saved = false }
        .onChange(of: task.note) { _ in saved = false }
    }
}

private struct ReproductionTaskEditor: View {
    @ObservedObject var store: Store
    let key: String
    let analysis: ReproductionAnalysis
    let itemID: String
    @State private var task: ReproductionTask
    @State private var error: String?
    @State private var saved = false
    init(store: Store, key: String, analysis: ReproductionAnalysis, itemID: String) {
        self.store = store; self.key = key; self.analysis = analysis; self.itemID = itemID
        _task = State(initialValue: store.reproductionTask(key: key, revision: analysis.fingerprint, itemID: itemID))
    }
    private var hasUnsavedChanges: Bool {
        let persisted = store.reproductionTask(key: key, revision: analysis.fingerprint, itemID: itemID)
        return persisted.status != task.status || persisted.note != task.note
    }
    var body: some View {
        DisclosureGroup("人工核对记录 · " + task.status.label + (hasUnsavedChanges ? "（未保存）" : "")) {
            VStack(alignment: .leading, spacing: 8) {
                Picker("核对状态", selection: $task.status) {
                    ForEach(ReproductionTaskStatus.allCases, id: \.self) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented)
                TextEditor(text: $task.note).frame(height: 65).border(Color.line)
                Text("填写核对结论、日志 / commit 或受阻原因；保存在本机，不加入 AI 分析请求。").font(.system(size: 11)).foregroundColor(.inkSoft)
                HStack {
                    Button("保存核对记录") {
                        if store.saveReproductionTask(key: key, analysis: analysis, itemID: itemID, task: task) { error = nil; saved = true }
                        else { error = store.dataError; saved = false }
                    }
                    if saved { Text("已保存").font(.system(size: 11)).foregroundColor(.teal) }
                }
                if let error { Text(error).font(.system(size: 12)).foregroundColor(.accent) }
            }.padding(.top, 6)
        }.font(.system(size: 12))
        .disabled(store.reproductionLoadFailures.contains(key) || store.reproductionDirectoryFailed)
        .onChange(of: task.status) { _ in saved = false }
        .onChange(of: task.note) { _ in saved = false }
    }
}
