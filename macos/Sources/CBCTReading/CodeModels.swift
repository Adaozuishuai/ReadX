import Foundation

struct RepositoryID: Codable, Equatable {
    var owner: String
    var name: String
    var slug: String { owner + "/" + name }
    var url: String { "https://github.com/" + slug }
    static func parse(_ raw: String) throws -> Self {
        guard let url = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host?.lowercased() == "github.com", url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.port == nil else { throw CodeError.invalidRepository }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count == 2, parts.allSatisfy({ $0.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil && $0 != "." && $0 != ".." }) else { throw CodeError.invalidRepository }
        let name = parts[1].hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
        guard !name.isEmpty, name != ".", name != ".." else { throw CodeError.invalidRepository }
        return Self(owner: parts[0], name: name)
    }
}
enum CodeError: LocalizedError {
    case invalidRepository, invalidSnapshot, invalidEvidence(String), http(Int), limited, empty
    var errorDescription: String? {
        switch self {
        case .invalidRepository: return "请输入不含凭据的公开 GitHub 仓库 URL：https://github.com/owner/repo"
        case .invalidSnapshot: return "仓库快照格式无效；未覆盖已保存结果。"
        case .invalidEvidence(let why): return "代码映射证据无效：" + why
        case .http(let code): return "GitHub 返回 HTTP \(code)，请核对公开仓库地址并重试。"
        case .limited: return "GitHub 读取限额已用尽，请稍后重试；已保留旧快照。"
        case .empty: return "未读取到可分析的文本文件；PDF 阅读与其他模块仍可使用。"
        }
    }
}
struct CodeFile: Codable, Identifiable {
    var path: String
    var sha: String
    var category: String
    var text: String
    var truncated: Bool
    var id: String { path }
    var lines: [String] { text.components(separatedBy: "\n") }
    var numbered: String { lines.enumerated().map { "\($0.offset + 1):\($0.element)" }.joined(separator: "\n") }
}
struct CodeSnapshot: Codable {
    var paperKey: String
    var repository: RepositoryID
    var commit: String
    var scannedAt: String
    var paths: [String]
    var files: [CodeFile]
    var warnings: [String]
    var mappingJSON: String? = nil
    var mappingAudit: ReadingAudit? = nil
    var confirmations: [String: String]? = nil
    // Keep the exact, page-marked paper material used for mapping so a snapshot
    // can be checked again even after its PDF text cache is cleared.
    var mappingSource: String? = nil
    func validateSnapshot() throws {
        guard !paperKey.isEmpty, !paperKey.contains("/"), paperKey != ".", paperKey != "..",
              commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              (try? RepositoryID.parse(repository.url)) == repository,
              Set(files.map(\.path)).count == files.count, !files.isEmpty,
              files.allSatisfy({ paths.contains($0.path) && !$0.path.hasPrefix("/") && !$0.path.split(separator: "/").contains("..") }) else { throw CodeError.invalidSnapshot }
        if let mappingJSON {
            let analysis = try CodeMappingAnalysis.decode(mappingJSON)
            try analysis.validateCode(snapshot: self)
            if let mappingSource { try analysis.validate(source: mappingSource, snapshot: self) }
            guard (confirmations ?? [:]).allSatisfy({ key, note in
                analysis.mappings.contains(where: { $0.id == key }) && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) else { throw CodeError.invalidSnapshot }
        } else if !(confirmations ?? [:]).isEmpty { throw CodeError.invalidSnapshot }
    }
    func fileURL(path: String, line: Int? = nil) -> URL? {
        guard paths.contains(path), path.split(separator: "/").allSatisfy({ $0 != ".." }) else { return nil }
        let encoded = path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "#?"))) ?? "" }.joined(separator: "/")
        return URL(string: repository.url + "/blob/" + commit + "/" + encoded + (line.map { "#L\($0)" } ?? ""))
    }
    var context: String { "仓库：\(repository.url)\ncommit：\(commit)\n读取范围：\(files.count)/\(paths.count) 个文件\n" + files.map { "=== File \($0.path) [\($0.category)] ===\n\($0.numbered)" }.joined(separator: "\n\n") }
}
struct CodeMapping: Codable {
    var concept: String
    var paper: ExperimentField
    var path: String
    var startLine: Int
    var endLine: Int
    var codeExcerpt: String
    var symbol: String
    var reasoning: String
    var confidence: Double
    var id: String { concept + "|" + path + "|" + String(startLine) }
}
struct CodeMappingAnalysis: Codable {
    var mappings: [CodeMapping]
    var missing: [String]
    static func codeNormalized(_ text: String) -> String {
        // Preserve operators and string contents; only normalize line indentation.
        text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func decode(_ raw: String) throws -> Self {
        let text = JSONExtract.object(from: raw)
        return try JSONDecoder().decode(Self.self, from: Data(text.utf8))
    }
    func validate(source: String, snapshot: CodeSnapshot) throws {
        try validateCode(snapshot: snapshot)
        for mapping in mappings {
            try ExperimentExtraction(dataset: [mapping.paper], acquisition: [], training: [], loss: [], metrics: [], results: []).validate(source: source)
        }
    }
    // This part is independent of the PDF cache and must also run on reload.
    func validateCode(snapshot: CodeSnapshot) throws {
        guard !mappings.isEmpty else { throw CodeError.invalidEvidence("没有可核对的映射") }
        guard Set(mappings.map(\.id)).count == mappings.count else { throw CodeError.invalidEvidence("重复映射") }
        for mapping in mappings {
            guard !mapping.concept.isEmpty, !mapping.reasoning.isEmpty, mapping.confidence.isFinite,
                  (0...1).contains(mapping.confidence), mapping.paper.page != nil else { throw CodeError.invalidEvidence(mapping.concept + " 缺少论文依据或有效置信度") }
            guard let file = snapshot.files.first(where: { $0.path == mapping.path }), mapping.startLine > 0,
                  mapping.endLine >= mapping.startLine, mapping.endLine <= file.lines.count else { throw CodeError.invalidEvidence(mapping.path + " 不存在或行号超出范围") }
            let slice = file.lines[(mapping.startLine - 1)..<mapping.endLine].joined(separator: "\n")
            guard Self.codeNormalized(mapping.codeExcerpt).count >= 8, Self.codeNormalized(slice).contains(Self.codeNormalized(mapping.codeExcerpt)),
                  mapping.symbol.isEmpty || mapping.symbol == "未知" || file.text.contains(mapping.symbol) else { throw CodeError.invalidEvidence(mapping.path + ":\(mapping.startLine)–\(mapping.endLine) 摘录/符号未匹配代码范围。该行范围实际内容：\n" + String(slice.prefix(4_000)) + "\n请复制范围内连续代码，不得改写空白以外的字符；symbol 使用原文件定义名或未知。") }
        }
    }
}
