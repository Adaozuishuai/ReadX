import Foundation
import AppKit

extension Store {
    var reproductionDir: URL { dataDir.appendingPathComponent("reproduction") }
    func reproductionURL(_ key: String) -> URL { reproductionDir.appendingPathComponent(key + ".json") }
    func loadReproductionChecklists() {
        reproductionChecklists = [:]; reproductionLoadFailures = []; reproductionDirectoryFailed = false
        guard FileManager.default.fileExists(atPath: reproductionDir.path) else { return }
        do {
            for url in try FileManager.default.contentsOfDirectory(at: reproductionDir, includingPropertiesForKeys: nil) where url.pathExtension == "json" {
                let key = url.deletingPathExtension().lastPathComponent
                do {
                    let record = try JSONDecoder().decode(ReproductionChecklist.self, from: Data(contentsOf: url))
                    guard record.key == key else { throw NSError(domain: "reproduction", code: 2, userInfo: [NSLocalizedDescriptionKey: "论文标识不匹配"]) }
                    reproductionChecklists[key] = record
                } catch { reproductionLoadFailures.insert(key); dataError = "复现清单读取失败，已保留文件并停止覆盖：\(url.lastPathComponent)" }
            }
        } catch { reproductionDirectoryFailed = true; dataError = "复现清单目录读取失败，已停止写入：\(error.localizedDescription)" }
    }
    func reproductionTask(key: String, revision: String, itemID: String) -> ReproductionTask {
        reproductionChecklists[key]?.task(revision, itemID: itemID) ?? ReproductionTask()
    }
    // MARK: R-11 仓库依赖核对
    func repoChecks(for key: String) -> [RepoDependencyCheck] {
        guard let snapshot = codeSnapshots[key], !reproductionLoadFailures.contains(key), !reproductionDirectoryFailed else { return [] }
        return RepoAudit.checks(from: snapshot)
    }
    func repoCheckTask(key: String, checkID: String) -> ReproductionTask {
        reproductionChecklists[key]?.repoChecks[checkID] ?? ReproductionTask()
    }
    @discardableResult func saveRepoCheckTask(key: String, check: RepoDependencyCheck, task: ReproductionTask) -> Bool {
        guard !reproductionDirectoryFailed, !reproductionLoadFailures.contains(key) else { dataError = "复现清单读取失败，请恢复文件并重新加载后再编辑。"; return false }
        guard task.status == .todo || !task.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            dataError = "请记录核对结论、日志/commit 或受阻原因。"; return false
        }
        var record = reproductionChecklists[key] ?? ReproductionChecklist(key: key)
        var updated = task; updated.updatedAt = ISO8601DateFormatter().string(from: Date())
        record.repoChecks[check.id] = updated
        guard persist(record, to: reproductionURL(key)) else { return false }
        reproductionChecklists[key] = record; return true
    }
    @discardableResult func saveReproductionTask(key: String, analysis: ReproductionAnalysis, itemID: String, task: ReproductionTask) -> Bool {
        guard !reproductionDirectoryFailed, !reproductionLoadFailures.contains(key) else { dataError = "复现清单读取失败，请恢复文件并重新加载后再编辑。"; return false }
        let ids = analysis.groups.flatMap { group in group.2.indices.map { group.0 + ":" + String($0) } }
        guard ids.contains(itemID) else { dataError = "复现条目不属于当前分析。"; return false }
        guard task.status == .todo || !task.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            dataError = "请记录核对结论、日志/commit 或受阻原因。"; return false
        }
        var record = reproductionChecklists[key] ?? ReproductionChecklist(key: key)
        var updated = task; updated.updatedAt = ISO8601DateFormatter().string(from: Date())
        record.revisions[analysis.fingerprint, default: [:]][itemID] = updated
        var analyses = record.analyses ?? [:]; analyses[analysis.fingerprint] = analysis; record.analyses = analyses
        guard persist(record, to: reproductionURL(key)) else { return false }
        reproductionChecklists[key] = record; return true
    }
    func ideaFromReproduction(_ item: ReproductionItem, ref: PaperRef) {
        var idea = ResearchIdea()
        idea.question = "复现核对：" + item.title
        idea.observation = item.isUnknown ? "当前论文材料未找到该配置；待查原 PDF、补充材料或代码。" : item.finding.v
        idea.method = item.assessment; idea.experiment = item.action; idea.status = .planned
        if let page = item.finding.page, let excerpt = item.finding.excerpt {
            var evidence = IdeaEvidence(paperKey: ref.key, paperTitle: ref.title, origin: .paper, page: page, excerpt: excerpt)
            if (try? evidence.validate(source: cachedPDFText(ref.key) ?? "")) != nil {
                evidence.verifiedAt = ISO8601DateFormatter().string(from: Date()); idea.evidence.append(evidence)
            }
        }
        idea.evidence.append(IdeaEvidence(paperKey: ref.key, paperTitle: ref.title, origin: .suggestion, page: nil, excerpt: "AI 复现分析：\(item.assessment)\n建议行动：\(item.action)"))
        ideaDraft = idea
    }
    func exportReproduction(_ analysis: ReproductionAnalysis, ref: PaperRef) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "CBCT-reproduction-\(Self.nowISO()).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try Self.reproductionMarkdown(analysis, ref: ref, checklist: reproductionChecklists[ref.key], audit: loadReadings(ref.key)?.audit?["reproduce"], repoChecks: repoChecks(for: ref.key))
                .write(to: url, atomically: true, encoding: .utf8)
        } catch { dataError = "复现清单导出失败：\(error.localizedDescription)" }
    }
    static func reproductionMarkdown(_ analysis: ReproductionAnalysis, ref: PaperRef, checklist: ReproductionChecklist?, audit: ReadingAudit? = nil, repoChecks: [RepoDependencyCheck] = []) -> String {
        var output = "# 复现准备：\(ref.title)\n\n论文：\(ref.key)\n分析版本：\(analysis.fingerprint)\n\n范围：论文材料分析；未自动检查代码/数据可用性或运行训练。AI 分析与行动需核对；未知指当前材料未找到。人工已核对不等于复现成功。\n"
        if let audit { output += "\n模型：\(audit.model) · 生成：\(audit.generatedAt) · 解析：\(audit.extractionVersion)\n" }
        for (group, label, items) in analysis.groups {
            output += "\n## \(label)\n"
            for (index, item) in items.enumerated() {
                let task = checklist?.task(analysis.fingerprint, itemID: group + ":" + String(index)) ?? ReproductionTask()
                output += "\n### \(item.title)\n\n[\(item.isUnknown ? "当前材料未找到" : "论文报告 · 尚需人工核对")] \(item.finding.v)\n"
                if let page = item.finding.page, let quote = item.finding.excerpt { output += "\nPDF Page \(page) · 原文：\(quote)\n" }
                output += "\nAI 分析 / 推断：\(item.assessment)\n\n建议行动：\(item.action)\n\n人工核对：\(task.status.label)\n记录：\(task.note.isEmpty ? "尚无记录" : task.note)\n"
                if let updatedAt = task.updatedAt { output += "更新：\(updatedAt)\n" }
            }
        }
        if !repoChecks.isEmpty {
            output += "\n## 仓库依赖核对（来自代码快照 · 规则扫描）\n"
            for check in repoChecks {
                let task = checklist?.repoChecks[check.id] ?? ReproductionTask()
                output += "\n### [\(check.kind)] \(check.path)\(check.line.map { ":\($0)" } ?? "")\n\n\(check.detail)\n\n人工核对：\(task.status.label)\n记录：\(task.note.isEmpty ? "尚无记录" : task.note)\n"
            }
        }
        return output
    }
}
