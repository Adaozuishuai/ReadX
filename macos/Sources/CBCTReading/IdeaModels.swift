import Foundation

enum IdeaStatus: String, Codable, CaseIterable {
    case idea = "Idea", planned = "Planned", running = "Running", rejected = "Rejected", adopted = "Adopted"
    var label: String {
        switch self { case .idea: return "想法"; case .planned: return "待实验"; case .running: return "实验中"; case .rejected: return "已否定"; case .adopted: return "已采纳" }
    }
}

enum EvidenceOrigin: String, Codable, CaseIterable {
    case paper = "论文原文", interpretation = "AI 解释", suggestion = "研究建议", note = "个人笔记"
}

struct IdeaEvidence: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var paperKey: String
    var paperTitle: String
    var origin: EvidenceOrigin
    var page: Int?
    var excerpt: String
    var verifiedAt: String? = nil

    func validate(source: String) throws {
        guard origin == .paper else { return }
        guard let page, let text = Evidence.pages(source).first(where: { $0.number == page })?.text,
              Evidence.normalized(excerpt).count >= 8,
              Evidence.normalized(text).contains(Evidence.normalized(excerpt)) else {
            throw NSError(domain: "idea", code: 1, userInfo: [NSLocalizedDescriptionKey: "原文证据须包含有效页码和该页至少 8 个非空白字符的逐字摘录。"])
        }
    }
}

struct ResearchIdea: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var question = ""
    var observation = ""
    var hypothesis = ""
    var method = ""
    var experiment = ""
    var status: IdeaStatus = .idea
    var evidence: [IdeaEvidence] = []
    var createdAt = ISO8601DateFormatter().string(from: Date())
    var updatedAt = ISO8601DateFormatter().string(from: Date())
}

struct ApplicationAdvice: Codable {
    var title: String
    var suggestion: String
    var constraint: String
    var verification: String
    var evidence: [ExperimentField]
}

struct ResearchApplication: Codable {
    var reusable: [ApplicationAdvice]
    var adaptation: [ApplicationAdvice]
    var conflicts: [ApplicationAdvice]
    var validation: [ApplicationAdvice]
    var groups: [(String, String, [ApplicationAdvice])] {
        [("reusable", "可直接复用 · 仍需确认前提", reusable), ("adaptation", "需要适配", adaptation),
         ("conflicts", "存在冲突 / 潜在冲突", conflicts), ("validation", "需要验证", validation)]
    }
    static func decode(_ text: String) throws -> Self {
        let raw = JSONExtract.object(from: text)
        return try JSONDecoder().decode(Self.self, from: Data(raw.utf8))
    }
    func validate(source: String) throws {
        let items = groups.flatMap { $0.2 }
        guard !items.isEmpty else { throw NSError(domain: "apply", code: 1, userInfo: [NSLocalizedDescriptionKey: "迁移分析没有返回建议。"] ) }
        var problems: [String] = []
        for item in items {
            guard !item.title.isEmpty, !item.suggestion.isEmpty, !item.constraint.isEmpty, !item.verification.isEmpty, !item.evidence.isEmpty else {
                problems.append("\(item.title)：缺少依据、研究约束或验证实验"); continue
            }
            do { try ExperimentExtraction(dataset: item.evidence, acquisition: [], training: [], loss: [], metrics: [], results: []).validate(source: source) }
            catch { problems.append("\(item.title)：\(error.localizedDescription)") }
            if !item.evidence.contains(where: { $0.page != nil }) {
                problems.append("\(item.title)：只有未知字段，没有原文依据")
            }
        }
        if !problems.isEmpty { throw NSError(domain: "apply", code: 2, userInfo: [NSLocalizedDescriptionKey: problems.joined(separator: "；")]) }
    }
}

extension Evidence {
    // Map normalized quotes back to the UTF-16 ranges required by PDFKit.
    static func quoteRange(_ quote: String, in text: String) -> NSRange? {
        let needle = normalized(quote)
        guard needle.count >= 8 else { return nil }
        var characters: [Character] = [], ranges: [NSRange] = []
        let regex = try! NSRegularExpression(pattern: "(?<=\\p{L})-[ \\t]*\\n[ \\t]*(?=\\p{L})")
        let lineHyphens = Set(regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { $0.range.location })
        text.enumerateSubstrings(in: text.startIndex..., options: .byComposedCharacterSequences) { substring, range, _, _ in
            guard let substring else { return }
            if lineHyphens.contains(NSRange(range, in: text).location) { return }
            for character in substring.precomposedStringWithCompatibilityMapping.lowercased().replacingOccurrences(of: "−", with: "-") where !character.isWhitespace {
                characters.append(character); ranges.append(NSRange(range, in: text))
            }
        }
        var canonical: [Character] = [], canonicalRanges: [NSRange] = []
        for index in characters.indices {
            let insideWord = characters[index] == "-" && index >= 2 && index + 2 < characters.count &&
                characters[index - 1].isLetter && characters[index - 2].isLetter && characters[index + 1].isLetter && characters[index + 2].isLetter
            if !insideWord { canonical.append(characters[index]); canonicalRanges.append(ranges[index]) }
        }
        ranges = canonicalRanges
        let normalizedText = String(canonical)
        guard let match = normalizedText.range(of: needle) else { return nil }
        let start = normalizedText.distance(from: normalizedText.startIndex, to: match.lowerBound)
        let end = normalizedText.distance(from: normalizedText.startIndex, to: match.upperBound) - 1
        return NSRange(location: ranges[start].location, length: ranges[end].upperBound - ranges[start].location)
    }
}
