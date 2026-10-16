import Foundation

// Opt-in integration check against the configured model. Only sends public
// papers and a synthetic profile; never loads personal notes, Ideas or profile.
// R-01：支持多篇验收集（模块×论文矩阵 + 引用追溯率汇总，SUMMARY.md）。
@main struct ModelAcceptance {
    struct ValidationPaper {
        let key: String      // library PDF 解析键
        let arxiv: String    // 无 arXiv 版本的论文留空
        let title: String
        let venue: String
    }
    // 验收集：PDF 已在 workspace/library（R-01）。新增论文时在 library 放入 PDF 并在此登记。
    static let validationSet: [ValidationPaper] = [
        ValidationPaper(key: "2209.14540", arxiv: "2209.14540", title: "Neural Attenuation Fields for Sparse-View CBCT Reconstruction", venue: "arXiv 2022"),
        ValidationPaper(key: "2312.15676", arxiv: "2312.15676", title: "3DGR-CT: Sparse-View CT Reconstruction with a 3D Gaussian Representation", venue: "arXiv 2023"),
        ValidationPaper(key: "intratomo-2021", arxiv: "", title: "IntraTomo: Self-supervised Learning-based Tomography via Sinogram Synthesis and Prediction", venue: "ICCV 2021"),
    ]
    // key → library 内实际文件名（解析失败时手工映射）
    static let libraryFiles: [String: String] = [
        "2209.14540": "2022-NAF-2209.14540.pdf",
        "2312.15676": "2023-2312.15676.pdf",
        "intratomo-2021": "intratomo-2021.pdf",
    ]

    @MainActor static func main() async throws {
        guard ProcessInfo.processInfo.environment["CBCT_MODEL_TESTS"] == "1" else {
            print("Set CBCT_MODEL_TESTS=1 to send the public validation papers to the configured API."); return
        }
        let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).deletingLastPathComponent()
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("cbct-model-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary.appendingPathComponent("library"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        // 选定论文子集（CBCT_MODEL_PAPERS=逗号分隔 key，默认全部验收集）
        let wanted = ProcessInfo.processInfo.environment["CBCT_MODEL_PAPERS"]?.split(separator: ",").map(String.init) ?? validationSet.map(\.key)
        let papers = validationSet.filter { wanted.contains($0.key) }
        guard !papers.isEmpty else { print("No validation papers selected."); return }
        // 搭建临时工作区：验收集 PDF + 合成队列
        var queuePapers: [[String: String]] = []
        for paper in papers {
            let srcName = libraryFiles[paper.key] ?? paper.key + ".pdf"
            let src = workspace.appendingPathComponent("library/" + srcName)
            guard FileManager.default.fileExists(atPath: src.path) else { print("Missing PDF for \(paper.key): \(srcName); skipped."); continue }
            try FileManager.default.copyItem(at: src, to: temporary.appendingPathComponent("library/" + paper.key + ".pdf"))
            queuePapers.append(["arxiv": paper.arxiv, "id": paper.key, "title": paper.title, "venue": paper.venue])
        }
        guard !queuePapers.isEmpty else { return }
        let queueJSON = try JSONSerialization.data(withJSONObject: ["papers": queuePapers])
        try queueJSON.write(to: temporary.appendingPathComponent("queue.json"))

        let store = Store(root: temporary, startTimers: false)
        store.config = try JSONDecoder().decode(Config.self, from: Data(contentsOf: workspace.appendingPathComponent("app/config.json")))
        guard store.config.hasKey else { print("No configured API key; skipped."); return }
        let output = workspace.appendingPathComponent("macos/acceptance/" + Store.nowISO() + "/" + (ProcessInfo.processInfo.environment["CBCT_ACCEPTANCE_RUN"] ?? "initial"))
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        // module → paper → (passed, citeOK, citeTotal)
        let jsonModules: Set<String> = ["experiment", "apply", "reproduce", "results"]
        let requestedModules = ProcessInfo.processInfo.environment["CBCT_MODEL_MODULES"]?.split(separator: ",").map(String.init) ?? ["tldr", "deep", "method", "critical", "experiment", "apply"]
        var matrix: [String: [String: (Bool, Int, Int)]] = [:]

        for paper in papers where FileManager.default.fileExists(atPath: temporary.appendingPathComponent("library/" + paper.key + ".pdf").path) {
            print("\n=== \(paper.key) · \(paper.title) ===")
            guard let entry = store.queue.first(where: { $0.key == paper.key || $0.arxiv == paper.arxiv }) else { print("queue entry missing; skipped."); continue }
            let ref = store.reference(entry)
            let source = try await store.ensurePDFText(for: ref)
            try source.write(to: output.appendingPathComponent("\(paper.key)-source.txt"), atomically: true, encoding: .utf8)
            if ProcessInfo.processInfo.environment["CBCT_SOURCE_ONLY"] == "1" { print("Extracted public PDF only; no API request."); continue }
            let session = SessionState(ref: ref, step: 1)
            session.sourceText = source
            let availablePages = Set(Evidence.pages(source).map(\.number))
            print("Model: \(store.config.model ?? "unknown") · \(Evidence.pages(source).count) pages")

            var outcomes: [[String: String]] = []
            for module in requestedModules {
                let began = Date()
                store.openReading(session, kind: module, regenerate: true)
                while session.readingBusy(for: module) && Date().timeIntervalSince(began) < 300 { try await Task.sleep(nanoseconds: 100_000_000) }
                let failure = session.readingBusy(for: module) ? "Request timed out" : session.readingError(for: module)
                let passed = failure == nil
                let status = passed ? "structural validation passed; semantic review pending" : "failed: " + failure!
                let text = session.readingText(for: module)
                try text.write(to: output.appendingPathComponent("\(paper.key)-\(module).\((jsonModules.contains(module) ? "json" : "md"))"), atomically: true, encoding: .utf8)
                // 引用追溯率：输出中的 Page N 引用必须存在于原文页码集合
                let cites = Evidence.citations(text)
                let valid = cites.filter { availablePages.contains($0) }.count
                if !cites.isEmpty { matrix[module, default: [:]][paper.key] = (passed, valid, cites.count) }
                outcomes.append(["module": module, "status": status, "seconds": String(Int(Date().timeIntervalSince(began)))])
                print("\(module): \(status)")
                if session.readingBusy(for: module) { break }
            }
            if ProcessInfo.processInfo.environment["CBCT_SKIP_CHAT"] != "1" {
                let questions = [
                    ("unknown", "这篇论文的患者身份证号码、伦理审批编号和测试集患者性别比例分别是什么？只依据原文；没有信息就明确说论文中未找到，禁止猜测。"),
                    ("geometry", "论文实际用了多少 views、什么投影尺寸、什么指标？sparse-view 与 low-mAs 是否同一种策略？区分本篇论文事实与领域解释，每个论文事实给 Page N。")
                ]
                for (name, question) in questions {
                    session.chat = []; session.chatMode = "chat"
                    let began = Date()
                    store.sendChat(session, text: question)
                    while session.streamBusy && Date().timeIntervalSince(began) < 300 { try await Task.sleep(nanoseconds: 100_000_000) }
                    let response = session.chat.last?.text ?? ""
                    try response.write(to: output.appendingPathComponent("\(paper.key)-chat-\(name).md"), atomically: true, encoding: .utf8)
                    let cites = Evidence.citations(response)
                    let structural = !session.streamBusy && !response.isEmpty && (response.contains("论文中未找到") || !cites.isEmpty)
                    if !cites.isEmpty { matrix["chat-" + name, default: [:]][paper.key] = (structural, cites.filter { availablePages.contains($0) }.count, cites.count) }
                    outcomes.append(["module": "chat-" + name, "status": structural ? "response received; semantic review pending" : "failed / rejected", "seconds": String(Int(Date().timeIntervalSince(began)))])
                    print("chat-\(name): \(structural ? "received" : "failed / rejected")")
                    if session.streamBusy { break }
                }
            }
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(outcomes).write(to: output.appendingPathComponent("\(paper.key)-run.json"), options: .atomic)
            if let reading = store.loadReadings(ref.key) { try encoder.encode(reading).write(to: output.appendingPathComponent("\(paper.key)-readings.json"), options: .atomic) }
        }

        // 汇总：模块×论文矩阵 + 引用追溯率
        try writeSummary(matrix: matrix, papers: papers, modules: requestedModules, output: output)
        print("\nSaved validation outputs for manual review: \(output.path)")
    }

    @MainActor static func writeSummary(matrix: [String: [String: (Bool, Int, Int)]], papers: [ValidationPaper], modules: [String], output: URL) throws {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
        var lines = ["# 多篇验收集运行摘要", "", "生成：\(f.string(from: Date())) · 论文：\(papers.map(\.key).joined(separator: ", "))", "", "| 模块 | " + papers.map(\.key).joined(separator: " | ") + " | 引用追溯 |", "|---|---|---|"]
        var allModules = modules + ["chat-unknown", "chat-geometry"]
        for module in allModules {
            guard let row = matrix[module] else { continue }
            var cells: [String] = []; var citeValid = 0; var citeAll = 0
            for paper in papers {
                if let cell = row[paper.key] {
                    cells.append(cell.0 ? "✓" : "✗")
                    citeValid += cell.1; citeAll += cell.2
                } else { cells.append("–") }
            }
            let rate = citeAll == 0 ? "–" : "\(citeValid)/\(citeAll) = \(Int(Double(citeValid) / Double(citeAll) * 100))%"
            lines.append("| \(module) | " + cells.joined(separator: " | ") + " | \(rate) |")
        }
        lines.append("")
        lines.append("口径：✓ = 结构校验通过（semantic review pending）；引用追溯 = 输出中 Page N 引用存在于原文页码的比例。逐次运行原始记录见各 `*-run.json`。")
        try lines.joined(separator: "\n").write(to: output.appendingPathComponent("SUMMARY.md"), atomically: true, encoding: .utf8)
        print("Summary written: SUMMARY.md")
    }
}
