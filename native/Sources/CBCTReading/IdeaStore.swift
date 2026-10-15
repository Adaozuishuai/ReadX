import Foundation
import AppKit

extension Store {
    var ideasURL: URL { dataDir.appendingPathComponent("ideas.json") }

    func loadIdeas() {
        guard FileManager.default.fileExists(atPath: ideasURL.path) else { ideas = []; ideasLoadFailed = false; return }
        do {
            // 兼容两种落盘格式：裸数组（应用写入）与 {"ideas":[...]} 信封（外部迁移脚本曾写出，
            // 只认裸数组会让整个 Ideas 进入停写保护）。两种都解析失败才进入停写保护。
            let data = try Data(contentsOf: ideasURL)
            struct IdeaEnvelope: Decodable { var ideas: [ResearchIdea]? }
            if let envelope = try? JSONDecoder().decode(IdeaEnvelope.self, from: data), let list = envelope.ideas {
                ideas = list
            } else {
                ideas = try JSONDecoder().decode([ResearchIdea].self, from: data)
            }
            ideasLoadFailed = false
        } catch { ideasLoadFailed = true; dataError = "Ideas 读取失败，已保留原文件并停止写入：\(error.localizedDescription)" }
    }
    @discardableResult func saveIdea(_ draft: ResearchIdea) -> Bool {
        guard !ideasLoadFailed else { dataError = "Ideas 文件读取失败，请先恢复文件后重新加载。"; return false }
        guard !draft.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { dataError = "请填写 Research Question。"; return false }
        do {
            for evidence in draft.evidence where evidence.origin == .paper {
                try evidence.validate(source: cachedPDFText(evidence.paperKey) ?? "")
            }
        } catch { dataError = error.localizedDescription; return false }
        var updated = draft; updated.updatedAt = ISO8601DateFormatter().string(from: Date())
        var next = ideas
        if let index = next.firstIndex(where: { $0.id == draft.id }) { next[index] = updated } else { next.insert(updated, at: 0) }
        guard persist(next, to: ideasURL) else { return false }
        ideas = next; return true
    }
    @discardableResult func deleteIdea(_ id: String) -> Bool {
        guard !ideasLoadFailed else { return false }
        let next = ideas.filter { $0.id != id }
        guard persist(next, to: ideasURL) else { return false }
        ideas = next; return true
    }
    func newIdea(from s: SessionState, text: String = "", origin: EvidenceOrigin = .note) {
        var idea = ResearchIdea()
        idea.observation = text.isEmpty ? s.freeNoteDraft : text
        if !s.selectedPDFExcerpt.isEmpty, let page = s.selectedPDFPage {
            var evidence = IdeaEvidence(paperKey: s.ref.key, paperTitle: s.title, origin: .paper, page: page, excerpt: s.selectedPDFExcerpt)
            if (try? evidence.validate(source: s.sourceText)) != nil {
                evidence.verifiedAt = ISO8601DateFormatter().string(from: Date())
                idea.evidence = [evidence]
            } else { showToast("当前选择跨页或未匹配原文，可在 Idea 内按页附着证据。") }
        }
        if !text.isEmpty {
            idea.evidence.append(IdeaEvidence(paperKey: s.ref.key, paperTitle: s.title, origin: origin, page: nil, excerpt: text))
        }
        // Also link the paper for empty drafts without asserting any paper fact.
        if idea.evidence.isEmpty { idea.evidence = [IdeaEvidence(paperKey: s.ref.key, paperTitle: s.title, origin: .note, page: nil, excerpt: "关联论文；待附着原文证据")] }
        ideaDraft = idea
    }
    func ideaFromAdvice(_ advice: ApplicationAdvice, ref: PaperRef) {
        var idea = ResearchIdea()
        idea.question = advice.title; idea.hypothesis = advice.suggestion; idea.method = advice.constraint; idea.experiment = advice.verification
        let source = cachedPDFText(ref.key) ?? ""
        for field in advice.evidence {
            guard let page = field.page, let quote = field.excerpt else { continue }
            var evidence = IdeaEvidence(paperKey: ref.key, paperTitle: ref.title, origin: .paper, page: page, excerpt: quote)
            if (try? evidence.validate(source: source)) != nil { evidence.verifiedAt = ISO8601DateFormatter().string(from: Date()); idea.evidence.append(evidence) }
        }
        idea.evidence.append(IdeaEvidence(paperKey: ref.key, paperTitle: ref.title, origin: .suggestion, page: nil, excerpt: advice.suggestion))
        ideaDraft = idea
    }
    func openIdeaEvidence(_ evidence: IdeaEvidence) {
        let paper = allPapers.first { $0.key == evidence.paperKey } ?? QueueEntry(id: evidence.paperKey, title: evidence.paperTitle)
        guard openReader(reference(paper)) else { return }
        if let s = session, let page = evidence.page { jumpToEvidence(s, page: page, excerpt: evidence.origin == .paper ? evidence.excerpt : "") }
    }
    func exportIdeas() {
        let panel = NSSavePanel(); panel.nameFieldStringValue = "CBCT-ideas-\(Self.nowISO()).md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try Self.ideasMarkdown(ideas).write(to: url, atomically: true, encoding: .utf8) }
        catch { dataError = "导出 Ideas 失败：\(error.localizedDescription)" }
    }
    static func ideasMarkdown(_ ideas: [ResearchIdea]) -> String {
        var sections: [String] = []
        for idea in ideas {
            let fields = [("Research Question", idea.question), ("Observation", idea.observation), ("Hypothesis · 待验证", idea.hypothesis), ("Method Sketch", idea.method), ("Experiment", idea.experiment)]
            let body = fields.map { "### \($0.0)\n\n\($0.1)\n" }.joined(separator: "\n")
            var quotes: [String] = []
            for evidence in idea.evidence {
                let location = evidence.page.map { " · PDF Page \($0)" } ?? ""
                let excerpt = evidence.excerpt.replacingOccurrences(of: "\n", with: "\n  ")
                quotes.append("- [\(evidence.origin.rawValue)] \(evidence.paperTitle) (\(evidence.paperKey))\(location)\n  \(excerpt)")
            }
            sections.append("## \(idea.question)\n\n状态：\(idea.status.rawValue) · 更新：\(idea.updatedAt)\n\n" + body + "\n### Evidence\n\n" + quotes.joined(separator: "\n"))
        }
        return "# CBCT Research Ideas\n\n" + sections.joined(separator: "\n\n---\n\n")
    }
}
