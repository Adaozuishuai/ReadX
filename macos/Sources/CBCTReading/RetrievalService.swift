import Foundation
import CryptoKit

// MARK: - R-05 页级向量检索（Metadata Index）
// 页级分块 → /embeddings 嵌入（不可用时自动回退关键词检索）→ 本地向量索引。
// Chat 的跨论文扩展：当前论文仍由全文直供，这里只在其余论文中检索候选材料。

struct RetrievalChunk: Codable {
    var paper: String   // 论文 key
    var page: Int
    var text: String
    var vector: [Double]? = nil
}

struct RetrievalIndex: Codable {
    var key: String
    var pageCount: Int
    var model: String? = nil   // 嵌入模型名；nil = 关键词索引
    var builtAt: String
    var chunks: [RetrievalChunk]
    var sourceFingerprint: String? = nil
    var embeddingBase: String? = nil
    /// 嵌入失败负缓存：键 = "base|model"，值 = 失败时间。避免端点不支持 /embeddings 时
    /// 每次打开论文都重复一轮注定失败的请求（R-05 降级路径的补强）。
    var embedFailures: [String: String]? = nil

    func matchesSource(paper: String, source: String) -> Bool {
        guard key == paper, pageCount == Evidence.pages(source).count, !chunks.isEmpty else { return false }
        if let sourceFingerprint { return sourceFingerprint == TextMath.fingerprint(source) }
        // Earlier indices did not record a fingerprint. Compare their complete text
        // instead of accepting a same-page-count PDF as the same source.
        let expected = TextMath.chunks(paper: paper, source: source)
        return chunks.count == expected.count && zip(chunks, expected).allSatisfy {
            $0.paper == $1.paper && $0.page == $1.page && $0.text == $1.text
        }
    }

    func matchesEmbedding(model: String, base: String) -> Bool {
        self.model == model && embeddingBase == TextMath.embeddingBase(base)
    }
}

enum TextMath {
    /// 余弦相似度；零向量或维度不一致返回 0
    static func cosine(_ a: [Double], _ b: [Double]) -> Double {
        guard a.count == b.count, !a.isEmpty, a.allSatisfy(\.isFinite), b.allSatisfy(\.isFinite) else { return 0 }
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in a.indices { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
        guard na > 0, nb > 0, dot.isFinite, na.isFinite, nb.isFinite else { return 0 }
        let score = dot / (na.squareRoot() * nb.squareRoot())
        return score.isFinite ? score : 0
    }

    static func fingerprint(_ source: String) -> String {
        SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func embeddingBase(_ base: String) -> String {
        var value = base.trimmingCharacters(in: .whitespacesAndNewlines)
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    /// The response's `index` identifies its input; response array order is not
    /// guaranteed. Reject incomplete, duplicate or incompatible vectors.
    static func embeddingVectors(_ entries: [[String: Any]], inputCount: Int) -> [[Double]]? {
        guard inputCount > 0, entries.count == inputCount else { return nil }
        var ordered = Array<[Double]?>(repeating: nil, count: inputCount)
        var dimension: Int?
        for entry in entries {
            guard let position = entry["index"] as? Int, ordered.indices.contains(position), ordered[position] == nil,
                  let values = entry["embedding"] as? [NSNumber] else { return nil }
            let vector = values.map(\.doubleValue)
            guard !vector.isEmpty, vector.allSatisfy(\.isFinite), dimension == nil || dimension == vector.count else { return nil }
            dimension = vector.count
            ordered[position] = vector
        }
        return ordered.compactMap { $0 }
    }

    /// 从 === Page N === 文本切页级分块；超长页按 ~1200 字符二次切块
    static func chunks(paper: String, source: String) -> [RetrievalChunk] {
        var out: [RetrievalChunk] = []
        for page in Evidence.pages(source) {
            let t = page.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { continue }
            if t.count <= 1600 {
                out.append(RetrievalChunk(paper: paper, page: page.number, text: t))
                continue
            }
            var index = t.startIndex
            while index < t.endIndex {
                let end = t.index(index, offsetBy: 1200, limitedBy: t.endIndex) ?? t.endIndex
                out.append(RetrievalChunk(paper: paper, page: page.number, text: String(t[index..<end])))
                index = end
            }
        }
        return out
    }

    static func terms(_ query: String) -> [String] {
        query.lowercased().split { !$0.isLetter && !$0.isNumber }.filter { $0.count > 2 }.map(String.init)
    }

    /// 关键词回退打分：查询词命中次数
    static func keywordScore(_ text: String, terms: [String]) -> Double {
        let lower = text.lowercased()
        return terms.reduce(0.0) { $0 + Double(lower.components(separatedBy: $1).count - 1) }
    }
}

struct RetrievedPassage {
    var paper: String
    var title: String
    var page: Int
    var text: String
    var viaEmbedding: Bool
}

extension Store {
    func retrievalIndexURL(_ key: String) -> URL { dataDir.appendingPathComponent("embeddings/\(key).json") }

    /// 已有页文本缓存的论文 key（library/text/*-v3.txt）
    func cachedKeys() -> [String] {
        let dir = libraryDir.appendingPathComponent("text")
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return files.filter { $0.hasSuffix("-v3.txt") }.map { String($0.dropLast("-v3.txt".count)) }
    }

    /// 载入或构建单篇论文的检索索引。
    /// - Parameter allowEmbedding: false 时只用本地关键词索引、**绝不发起 /embeddings 网络请求**。
    ///   Chat 路径必须传 false——嵌入请求不能阻塞首响应（PRD 8.1）；关键词分块是纯本地计算，仍然可用。
    ///   没有 API Key 时两种模式都退化为关键词索引。
    func retrievalIndex(for key: String, allowEmbedding: Bool = true) async -> RetrievalIndex? {
        let source = cachedPDFText(key) ?? ""
        let pageCount = Evidence.pages(source).count
        let embedModel = config.embeddingModel ?? config.model ?? "text-embedding-3-small"
        let base = config.baseURL ?? ""
        let embedKey = TextMath.embeddingBase(base) + "|" + embedModel
        var embedFailures: [String: String] = [:]
        if let data = try? Data(contentsOf: retrievalIndexURL(key)),
           let prior = try? JSONDecoder().decode(RetrievalIndex.self, from: data) {
            embedFailures = prior.embedFailures ?? [:]
        }
        let embedFailedBefore = cachedPDFText(key) != nil && embedFailures[embedKey] != nil
        let wantEmbedding = config.hasKey && allowEmbedding && !embedFailedBefore
        if let data = try? Data(contentsOf: retrievalIndexURL(key)),
           let cached = try? JSONDecoder().decode(RetrievalIndex.self, from: data),
           cached.matchesSource(paper: key, source: source),
           !wantEmbedding || cached.matchesEmbedding(model: embedModel, base: base) {
            return cached
        }
        var chunks = TextMath.chunks(paper: key, source: source)
        var usedModel: String? = nil
        if wantEmbedding, !chunks.isEmpty, let base = config.baseURL, let apiKey = config.apiKey {
            let limited = Array(chunks.prefix(80))
            if let vectors = await Self.embed(texts: limited.map(\.text), base: base, apiKey: apiKey, model: embedModel), vectors.count == limited.count {
                for i in limited.indices { chunks[i].vector = vectors[i] }
                usedModel = embedModel
            } else {
                embedFailures[embedKey] = Self.nowISO()
            }
        }
        guard !chunks.isEmpty else { return nil }
        // A PDF can be replaced while the embedding request is in flight. Never
        // let that old response overwrite the replacement's index.
        guard cachedPDFText(key) == source else { return nil }
        var failures = embedFailures
        if usedModel != nil { failures.removeValue(forKey: embedKey) }  // 成功后清除负缓存
        let index = RetrievalIndex(key: key, pageCount: pageCount, model: usedModel, builtAt: Self.nowISO(), chunks: chunks,
                                   sourceFingerprint: TextMath.fingerprint(source),
                                   embeddingBase: usedModel == nil ? nil : TextMath.embeddingBase(base),
                                   embedFailures: failures)
        persist(index, to: retrievalIndexURL(key))
        return index
    }

    /// 后台预热嵌入索引：PDF 文本缓存就绪后调用，网络请求不阻塞任何用户操作。
    func prewarmRetrievalIndex(for key: String) {
        Task { [weak self] in
            guard let self else { return }
            _ = await self.retrievalIndex(for: key, allowEmbedding: true)
        }
    }

    /// OpenAI 兼容 /embeddings；任何失败返回 nil（调用方回退关键词）
    nonisolated static func embed(texts: [String], base: String, apiKey: String, model: String, timeout: TimeInterval = 30) async -> [[Double]]? {
        let urlStr = TextMath.embeddingBase(base) + "/embeddings"
        guard let endpoint = URL(string: urlStr), ["http", "https"].contains(endpoint.scheme?.lowercased() ?? ""), endpoint.host != nil else { return nil }
        var req = URLRequest(url: endpoint)
        req.timeoutInterval = timeout
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["model": model, "input": texts])
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = obj["data"] as? [[String: Any]] else { return nil }
        return TextMath.embeddingVectors(arr, inputCount: texts.count)
    }

    /// 在后台线程逐篇加载并校验本地检索索引（语义与 cachedPDFText + retrievalIndexURL 一致）。
    nonisolated private static func loadIndices(keys: [String], indexDir: URL, textDir: URL) -> [String: RetrievalIndex] {
        var indices: [String: RetrievalIndex] = [:]
        for key in keys {
            guard let data = try? Data(contentsOf: indexDir.appendingPathComponent("\(key).json")),
                  let index = try? JSONDecoder().decode(RetrievalIndex.self, from: data),
                  let source = try? String(contentsOf: textDir.appendingPathComponent("\(key)-v3.txt"), encoding: .utf8),
                  !source.isEmpty,
                  index.matchesSource(paper: key, source: source) else { continue }
            indices[key] = index
        }
        return indices
    }

    /// Chat 跨论文扩展检索：在除当前论文外的其余缓存论文中取 topK 候选段落。
    /// 嵌入可用时用余弦相似度，否则回退关键词密度。只读已有本地索引；
    /// 查询向量仅在模型及端点一致时请求，最多等待 3 秒，失败立即回退关键词。
    func retrieveAcrossLibrary(query: String, excluding currentKey: String, topK: Int = 3) async -> [RetrievedPassage] {
        let titles = Dictionary(uniqueKeysWithValues: allPapers.map { ($0.key, $0.title ?? $0.key) })
        let others = Array(Set(cachedKeys()).subtracting([currentKey])).sorted()
        guard !others.isEmpty else { return [] }
        let terms = TextMath.terms(query)
        guard !terms.isEmpty else { return [] }

        // 只读取磁盘上已有的索引；缺失的论文由 prewarmRetrievalIndex 在后台补建。
        // 磁盘读 + JSON 解码 + 全文 SHA256 指纹校验都在后台线程做：
        // runAsk 在发出 AI 请求前同步等待这里，放在主线程会把提问首响卡住（论文库越大越明显）。
        let indexDir = dataDir.appendingPathComponent("embeddings")
        let textDir = libraryDir.appendingPathComponent("text")
        let indices = await Task.detached(priority: .userInitiated) {
            Self.loadIndices(keys: others, indexDir: indexDir, textDir: textDir)
        }.value
        guard !indices.isEmpty else { return [] }

        // 查询向量：仅当已有嵌入索引时才发这一次小请求；失败即回退关键词打分
        var queryVector: [Double]? = nil
        let embedModel = config.embeddingModel ?? config.model ?? "text-embedding-3-small"
        let embedBase = config.baseURL ?? ""
        if indices.values.contains(where: { $0.matchesEmbedding(model: embedModel, base: embedBase) && $0.chunks.contains { $0.vector != nil } }),
           config.hasKey, let base = config.baseURL, let apiKey = config.apiKey {
            queryVector = await Self.embed(texts: [query], base: base, apiKey: apiKey, model: embedModel, timeout: 3)?.first
        }

        var best: [RetrievedPassage] = []
        var bestScores: [Double] = []
        for (key, index) in indices {
            var top: (chunk: RetrievalChunk, score: Double)? = nil
            for chunk in index.chunks {
                let score: Double
                if index.matchesEmbedding(model: embedModel, base: embedBase), let qv = queryVector, let cv = chunk.vector, qv.count == cv.count {
                    score = TextMath.cosine(qv, cv)
                } else {
                    score = TextMath.keywordScore(chunk.text, terms: terms) / max(Double(chunk.text.count), 1) * 1000
                }
                if score > 0, top == nil || score > top!.score { top = (chunk, score) }
            }
            guard let hit = top else { continue }
            let passage = RetrievedPassage(paper: key, title: titles[key] ?? key, page: hit.chunk.page, text: hit.chunk.text, viaEmbedding: index.matchesEmbedding(model: embedModel, base: embedBase) && queryVector != nil && hit.chunk.vector?.count == queryVector?.count)
            if bestScores.count < topK {
                best.append(passage); bestScores.append(hit.score)
            } else if let minIndex = bestScores.indices.min(by: { bestScores[$0] < bestScores[$1] }), hit.score > bestScores[minIndex] {
                best[minIndex] = passage; bestScores[minIndex] = hit.score
            }
        }
        return best
    }

    /// Chat 请求附带的跨论文候选材料块（含来源标注与人工核对提示）
    static func libraryContextBlock(_ passages: [RetrievedPassage]) -> String {
        guard !passages.isEmpty else { return "" }
        var out = "\n\n【来自论文库其他论文的候选材料（检索得到，仅供关联参考；引用它们时必须同时写出论文名与 Page N，否则视为无证据）】\n"
        for p in passages {
            out += "\n--- \(p.title) · Page \(p.page) ---\n" + String(p.text.prefix(1200)) + "\n"
        }
        return out
    }
}
