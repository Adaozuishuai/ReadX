import Foundation

enum RepositoryService {
    struct TreeItem: Decodable { var path: String; var mode: String; var type: String; var sha: String; var size: Int? }
    struct Tree: Decodable { var tree: [TreeItem]; var truncated: Bool }
    private struct Metadata: Decodable { var default_branch: String }
    private struct Commit: Decodable { struct Details: Decodable { struct TreeRef: Decodable { var sha: String }; var tree: TreeRef }; var sha: String; var commit: Details }
    private struct Blob: Decodable { var encoding: String; var content: String }
    static func category(_ path: String) -> String {
        let p = path.lowercased(), name = URL(fileURLWithPath: p).lastPathComponent
        if name.hasPrefix("readme") || name.hasPrefix("license") { return "README / 许可" }
        if name.contains("requirement") || name.contains("environment") || ["setup.py", "pyproject.toml", "cmakelists.txt", "package.json"].contains(name) { return "环境 / 依赖" }
        if p.contains("config") || ["yaml", "yml", "toml", "json"].contains(URL(fileURLWithPath: p).pathExtension) { return "配置" }
        if p.contains("dataset") || p.contains("dataloader") || p.contains("preprocess") || p.contains("data/") { return "Dataset / 预处理" }
        if p.contains("loss") { return "Loss" }
        if p.contains("train") { return "训练入口" }
        if p.contains("eval") || p.contains("infer") || p.contains("test") { return "推理 / 评测" }
        if p.contains("model") || p.contains("network") || p.contains("encoder") || p.contains("render") || p.contains("geometry") { return "模型 / 几何" }
        return "其他实现"
    }
    static func eligible(_ item: TreeItem) -> Bool {
        let p = item.path.lowercased(), components = p.split(separator: "/").map(String.init)
        guard item.type == "blob", ["100644", "100755"].contains(item.mode), (item.size ?? 0) < 150_000,
              !components.contains(where: { [".git", "node_modules", ".venv", "venv", "__pycache__"].contains($0) }),
              !["secret", "credential", ".env", "id_rsa", "token", "apikey", "api_key"].contains(where: p.contains),
              !components.contains("..") else { return false }
        let ext = URL(fileURLWithPath: p).pathExtension
        return ["md", "rst", "txt", "py", "yaml", "yml", "toml", "json", "cpp", "cu", "h", "sh"].contains(ext) || p.hasSuffix("license") || p.hasSuffix("cmakelists.txt")
    }
    static func selected(_ items: [TreeItem], limit: Int = 24) -> [TreeItem] {
        let order = ["README / 许可", "环境 / 依赖", "配置", "Dataset / 预处理", "Loss", "训练入口", "推理 / 评测", "模型 / 几何", "其他实现"]
        func priority(_ path: String) -> Int {
            let name = URL(fileURLWithPath: path.lowercased()).lastPathComponent
            if name == "__init__.py" { return 100 }
            if name.hasPrefix("readme") { return 0 }
            if ["network.py", "model.py", "render.py", "loss.py", "train.py", "tigre.py", "hashgrid.py"].contains(name) { return 1 }
            if name == "backend.py" || name == "license" { return 10 }
            return 5
        }
        let files = items.filter(eligible).sorted { priority($0.path) == priority($1.path) ? $0.path < $1.path : priority($0.path) < priority($1.path) }
        var out: [TreeItem] = []
        // Round-robin categories so a large config directory cannot hide model/loss.
        var groups = order.map { category in files.filter { self.category($0.path) == category } }
        while out.count < limit, groups.contains(where: { !$0.isEmpty }) {
            for index in groups.indices where !groups[index].isEmpty && out.count < limit { out.append(groups[index].removeFirst()) }
        }
        return out
    }
    private static func get<T: Decodable>(_ type: T.Type, path: String, token: String?) async throws -> T {
        var request = URLRequest(url: URL(string: "https://api.github.com/" + path)!)
        request.timeoutInterval = 45
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        request.setValue("CBCT-Research-Copilot", forHTTPHeaderField: "User-Agent")
        // token 只进请求头，不进任何 prompt、日志或导出（PRD 8.3）
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CodeError.invalidSnapshot }
        if http.statusCode == 429 || (http.statusCode == 403 && http.value(forHTTPHeaderField: "X-RateLimit-Remaining") == "0") { throw CodeError.limited }
        guard http.statusCode == 200 else { throw CodeError.http(http.statusCode) }
        return try JSONDecoder().decode(type, from: data)
    }
    static func scan(_ raw: String, paperKey: String, cached: CodeSnapshot? = nil, token: String? = nil, progress: @escaping @MainActor (String) -> Void) async throws -> CodeSnapshot {
        let repository = try RepositoryID.parse(raw), prefix = "repos/" + repository.slug
        await progress("解析公开仓库与固定 commit")
        let metadata = try await get(Metadata.self, path: prefix, token: token)
        await progress("读取默认分支 commit")
        let ref = metadata.default_branch.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? ""
        let commit = try await get(Commit.self, path: prefix + "/commits/" + ref, token: token)
        guard commit.sha.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil else { throw CodeError.invalidSnapshot }
        await progress("读取固定 commit 文件树")
        let tree = try await get(Tree.self, path: prefix + "/git/trees/" + commit.commit.tree.sha + "?recursive=1", token: token)
        let entries = selected(tree.tree), paths = tree.tree.filter { $0.type == "blob" }.map(\.path)
        var files: [CodeFile] = [], warnings: [String] = []
        if tree.truncated { warnings.append("GitHub 文件树被截断；不是完整仓库扫描") }
        if tree.tree.filter(eligible).count > entries.count { warnings.append("按类别读取优先文件；未读取的文本文件仍需核对") }
        for (index, item) in entries.enumerated() {
            await progress("读取文件 \(index + 1)/\(entries.count) · \(item.path)")
            if let cached, cached.repository == repository, cached.commit == commit.sha,
               let file = cached.files.first(where: { $0.path == item.path && $0.sha == item.sha }) {
                files.append(file)
                if file.truncated { warnings.append("文件内容截断：" + item.path) }
                continue
            }
            do {
                let blob = try await get(Blob.self, path: prefix + "/git/blobs/" + item.sha, token: token)
                guard blob.encoding == "base64", let data = Data(base64Encoded: blob.content, options: .ignoreUnknownCharacters), let text = String(data: data, encoding: .utf8) else { warnings.append("无法按 UTF-8 读取：" + item.path); continue }
                let clipped = String(text.prefix(18_000))
                files.append(CodeFile(path: item.path, sha: item.sha, category: category(item.path), text: clipped, truncated: clipped.count < text.count))
                if clipped.count < text.count { warnings.append("文件内容截断：" + item.path) }
            } catch CodeError.limited { throw CodeError.limited }
            catch { warnings.append("文件读取失败：" + item.path) }
        }
        guard !files.isEmpty else { throw CodeError.empty }
        return CodeSnapshot(paperKey: paperKey, repository: repository, commit: commit.sha, scannedAt: ISO8601DateFormatter().string(from: Date()), paths: paths, files: files, warnings: warnings)
    }
}
