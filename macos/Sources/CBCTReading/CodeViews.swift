import SwiftUI

struct CodePanel: View {
    @ObservedObject var store: Store
    @ObservedObject var session: SessionState
    @State private var repositoryURL = ""
    @State private var selectedPath = ""
    @State private var confirming: String?
    @State private var confirmationNote = ""
    var snapshot: CodeSnapshot? { store.codeSnapshots[session.ref.key] }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Paper ↔ Code").font(serifFont(21, weight: .bold))
            Text("读取公开 GitHub 仓库并固定 commit。展示文件/行证据；AI 映射先标为推测，人工核对后记录为明确。代码只用于阅读分析。").font(.system(size: 12)).foregroundColor(.inkSoft)
            Text("论文摘录中的公式来自文本抽取，符号/上下标仍需核对原 PDF。").font(.system(size: 11)).foregroundColor(.gold)
            TextField("https://github.com/owner/repo", text: $repositoryURL).textFieldStyle(.roundedBorder)
            HStack {
                Button("扫描仓库") { store.scanRepository(session, url: repositoryURL) }.buttonStyle(FunButtonStyle(primary: true)).disabled(session.codeBusy || repositoryURL.isEmpty)
                Button("建立论文代码映射") { store.generateCodeMapping(session) }.buttonStyle(FunButtonStyle(primary: true)).disabled(session.codeBusy || snapshot == nil)
            }
            if session.codeBusy { HStack { ProgressView(); Text(store.codePhases[session.ref.key] ?? "处理中") }.font(.system(size: 12)) }
            if let error = store.codeErrors[session.ref.key] { Text(error).font(.system(size: 12)).foregroundColor(.accent) }
            if let snapshot {
                Text("\(snapshot.repository.slug) · commit \(snapshot.commit)\n扫描 \(snapshot.scannedAt) · 读取 \(snapshot.files.count)/\(snapshot.paths.count) 个文件").font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                Button("导出快照与映射") { store.exportCodeSnapshot(snapshot) }.buttonStyle(FunButtonStyle())
                ForEach(snapshot.warnings, id: \.self) { Text($0).font(.system(size: 11)).foregroundColor(.gold) }
                Picker("查看文件", selection: $selectedPath) { Text("请选择已读取文件").tag(""); ForEach(snapshot.files) { Text($0.category + " · " + $0.path).tag($0.path) } }
                if let file = snapshot.files.first(where: { $0.path == selectedPath }) {
                    DisclosureGroup("文件内容 · \(file.lines.count) 行") { Text(file.numbered).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
                    if let url = snapshot.fileURL(path: file.path) { Link("查看固定 commit 原文件", destination: url) }
                }
                if let raw = snapshot.mappingJSON, let analysis = try? CodeMappingAnalysis.decode(raw) {
                    ForEach(analysis.mappings, id: \.id) { mapping in
                        Card {
                            Text(mapping.concept).font(serifFont(15, weight: .bold))
                            Text(snapshot.confirmations?[mapping.id] == nil ? "AI 推测映射 · 模型置信度 \(Int(mapping.confidence * 100))%" : "明确映射 · 人工核对").font(.system(size: 11)).foregroundColor(.teal)
                            Text(mapping.reasoning).font(.system(size: 12)).textSelection(.enabled)
                            Text("论文：" + mapping.paper.v).font(.system(size: 12))
                            if let page = mapping.paper.page { Button("原文 Page \(page)") { store.jumpToEvidence(session, page: page, excerpt: mapping.paper.excerpt ?? "") }.buttonStyle(FunButtonStyle(small: true)) }
                            DisclosureGroup("论文逐字摘录") { Text(mapping.paper.excerpt ?? "").font(.system(size: 11)).foregroundColor(.inkSoft).textSelection(.enabled) }
                            if let url = snapshot.fileURL(path: mapping.path, line: mapping.startLine) { Link("\(mapping.path):\(mapping.startLine)–\(mapping.endLine) · \(mapping.symbol)", destination: url) }
                            DisclosureGroup("代码逐字摘录 · 行 \(mapping.startLine)–\(mapping.endLine)") { Text(mapping.codeExcerpt).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
                            if let note = snapshot.confirmations?[mapping.id] { Text("人工记录：" + note).font(.system(size: 11)).foregroundColor(.teal) }
                            Button("记录人工核对 / 明确映射") { confirming = mapping.id; confirmationNote = snapshot.confirmations?[mapping.id] ?? "" }.buttonStyle(FunButtonStyle(small: true))
                            if confirming == mapping.id {
                                TextEditor(text: $confirmationNote).frame(height: 60).border(Color.line)
                                Button("保存核对依据") { if store.confirmCodeMapping(key: session.ref.key, mappingID: mapping.id, note: confirmationNote) { confirming = nil } }.buttonStyle(FunButtonStyle(small: true))
                            }
                        }
                    }
                    if !analysis.missing.isEmpty { Text("未映射 / 待确认：\n" + analysis.missing.joined(separator: "\n")).font(.system(size: 12)).foregroundColor(.gold) }
                    if let audit = snapshot.mappingAudit { Text("\(audit.model) · \(audit.generatedAt) · \(audit.extractionVersion)").font(.system(size: 10)).foregroundColor(.inkSoft) }
                }
            }
        }.onAppear {
            if let snapshot { repositoryURL = snapshot.repository.url }
            else if let text = store.cachedPDFText(session.ref.key) {
                let pattern = "https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
                if let range = text.range(of: pattern, options: .regularExpression) { repositoryURL = String(text[range]).trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
            }
        }
    }
}
