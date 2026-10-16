import Foundation
import CryptoKit

struct ReproductionItem: Codable {
    var finding: ExperimentField
    var assessment: String
    var action: String
    var title: String { finding.k }
    var isUnknown: Bool { finding.page == nil }
}

struct ReproductionAnalysis: Codable {
    var resources: [ReproductionItem]
    var environment: [ReproductionItem]
    var cost: [ReproductionItem]
    var missing: [ReproductionItem]
    var risks: [ReproductionItem]

    var groups: [(String, String, [ReproductionItem])] {
        [("resources", "资源 · 数据 / 代码 / 权重", resources), ("environment", "环境 · 依赖 / 特殊算子", environment),
         ("cost", "训练成本 · 时间 / 显存", cost), ("missing", "关键缺失 · 几何 / 预处理 / 参数", missing),
         ("risks", "风险 · 实现 / 评测协议", risks)]
    }
    var itemCount: Int { groups.reduce(0) { $0 + $1.2.count } }
    var unknownCount: Int { groups.flatMap { $0.2 }.filter(\.isUnknown).count }
    static func decode(_ text: String) throws -> Self {
        let raw = JSONExtract.object(from: text)
        return try JSONDecoder().decode(Self.self, from: Data(raw.utf8))
    }
    var fingerprint: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(self)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    func validate(source: String) throws {
        var problems: [String] = []
        let available = Set(Evidence.pages(source).map(\.number))
        for (_, label, items) in groups {
            if items.isEmpty || items.count > 4 { problems.append("\(label)：须有 1–4 项，未知也须给出核对行动") }
            if Set(items.map(\.title)).count != items.count { problems.append("\(label)：字段标题重复") }
            for item in items {
                if [item.title, item.assessment, item.action].contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) {
                    problems.append("\(item.title)：缺少字段、分析或核对行动")
                }
                do { try ExperimentExtraction(dataset: [item.finding], acquisition: [], training: [], loss: [], metrics: [], results: []).validate(source: source) }
                catch { problems.append(error.localizedDescription) }
                if !Set(Evidence.citations(item.assessment + "\n" + item.action)).isSubset(of: available) {
                    problems.append("\(item.title)：分析或行动引用了不存在的页码")
                }
            }
        }
        if !problems.isEmpty { throw NSError(domain: "reproduction", code: 1, userInfo: [NSLocalizedDescriptionKey: problems.joined(separator: "；")]) }
    }
}

enum ReproductionTaskStatus: String, Codable, CaseIterable {
    case todo, verified, blocked
    var label: String { switch self { case .todo: return "待核对"; case .verified: return "已核对"; case .blocked: return "受阻" } }
}
struct ReproductionTask: Codable {
    var status: ReproductionTaskStatus = .todo
    var note = ""
    var updatedAt: String? = nil
}
struct ReproductionChecklist: Codable {
    var key: String
    // Keep each analysis revision separately; new analysis never inherits old checks.
    var revisions: [String: [String: ReproductionTask]] = [:]
    var analyses: [String: ReproductionAnalysis]? = nil
    // R-11：来自代码快照的仓库依赖/数据/权重核对项，键为 RepoDependencyCheck.id（随快照稳定）。
    var repoChecks: [String: ReproductionTask] = [:]
    func task(_ revision: String, itemID: String) -> ReproductionTask { revisions[revision]?[itemID] ?? ReproductionTask() }
}

// MARK: - R-11 仓库依赖核对（规则版，不执行仓库代码、不发请求）

struct RepoDependencyCheck: Codable, Identifiable {
    var path: String
    var kind: String // "依赖" | "数据" | "权重"
    var detail: String
    var line: Int? = nil
    var id: String { kind + "|" + path + (line.map { ":\($0)" } ?? "") }
}

enum RepoAudit {
    static let dependencyFileNames: Set<String> = ["requirements.txt", "environment.yml", "environment.yaml", "conda.yml", "conda.yaml", "setup.py", "pyproject.toml", "pipfile", "pipfile.lock", "package.json"]
    static let dataURLHints = ["drive.google.com", "zenodo", "huggingface.co", "figshare", "dropbox.com", "gdown"]
    static let weightHints = ["checkpoint", "weights", "pretrained", ".pth", ".ckpt"]

    /// 从代码快照提取依赖声明文件与数据/权重下载指引。纯函数，供回归测试与 UI 复用。
    static func checks(from snapshot: CodeSnapshot) -> [RepoDependencyCheck] {
        var out: [RepoDependencyCheck] = []
        for file in snapshot.files {
            let name = file.path.split(separator: "/").last.map { $0.lowercased() } ?? ""
            if dependencyFileNames.contains(name) {
                out.append(RepoDependencyCheck(path: file.path, kind: "依赖", detail: "发现依赖声明文件，需与论文环境声明核对并实际安装验证。"))
            }
            for (offset, rawLine) in file.lines.enumerated() where rawLine.count < 500 {
                let line = rawLine.trimmingCharacters(in: .whitespaces)
                let lower = line.lowercased()
                guard lower.contains("http") else { continue }
                let isWeight = weightHints.contains(where: lower.contains)
                let isData = dataURLHints.contains(where: lower.contains) || (lower.contains("download") && (lower.contains("data") || lower.contains("dataset")))
                if isWeight {
                    out.append(RepoDependencyCheck(path: file.path, kind: "权重", detail: "疑似权重/检查点下载指引：" + String(line.prefix(160)), line: offset + 1))
                } else if isData {
                    out.append(RepoDependencyCheck(path: file.path, kind: "数据", detail: "疑似数据集下载指引：" + String(line.prefix(160)), line: offset + 1))
                }
            }
        }
        var seen = Set<String>(); var deduped: [RepoDependencyCheck] = []
        for c in out where seen.insert(c.id).inserted {
            deduped.append(c)
            if deduped.count >= 12 { break } // 清单只做「核对提示」，不做穷举
        }
        return deduped
    }
}
