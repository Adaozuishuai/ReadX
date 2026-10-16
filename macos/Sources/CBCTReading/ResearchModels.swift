import Foundation

struct ResearchProfile: Codable, Equatable {
    var topics: [String: Int] = ["Sparse-view": 3, "Low-dose": 2, "Implicit": 2, "4D-CBCT": 0, "Diffusion": 1, "TTT": 0]
    var datasets = "Walnut, LUNA16, AAPM"
    var methods = "Implicit Representation, Transformer"
    var metrics = "PSNR, SSIM, RMSE"
    var hardware = "单卡 16 GB GPU"
    var task = "稀疏视角 CBCT 体重建"
    static let keywords: [String: [String]] = [
        "Sparse-view": ["sparse-view", "sparse view", "few-view", "few view"],
        "Low-dose": ["low-dose", "low dose", "low-mas"],
        "Implicit": ["implicit", "neural field", "attenuation field", "gaussian representation"],
        "4D-CBCT": ["4d", "motion", "dynamic"], "Diffusion": ["diffusion", "score-based"],
        "TTT": ["test-time", "test time", "scan-adaptive"]
    ]
    var context: String { "任务：\(task)；主题：\(topics.filter { $0.value > 0 }.map { $0.key }.sorted().joined(separator: ", "))；数据集：\(datasets)；方法：\(methods)；指标：\(metrics)；算力：\(hardware)" }
}

enum LibraryStatus: String, Codable, CaseIterable {
    case unread, later, reading, read, ignored, deleted
    var label: String {
        switch self {
        case .unread: return "未读"
        case .later: return "稍后读"
        case .reading: return "精读中"
        case .read: return "已读"
        case .ignored: return "忽略"
        case .deleted: return "已删除"
        }
    }
}

struct LibraryState: Codable {
    var status: LibraryStatus = .unread
    var favorite = false
    var tags: [String] = []
    var notes = ""
    var relevance: Int = 0  // -1 不相关，0 未评价，1 相关
    var corrections = ""
    var updatedAt = ""
}

struct DiscoveryCache: Codable {
    var papers: [QueueEntry] = []
    /// arXiv-only work appears in its own feed; optional for backwards-compatible cache decoding.
    var preprints: [QueueEntry]? = nil
    var fetchedAt = ""
    var errors: [String] = []
    /// 每篇论文首次出现在发现结果中的日期（yyyy-MM-dd），用于「今日新增」计数（PRD 5.1）。
    /// 早期缓存没有该字段，回填为首次抓取日并需在界面标注。
    var firstSeen: [String: String] = [:]

    /// 合并首见日期：已有记录保持不变，新论文记录为当天。纯函数，便于回归测试。
    static func mergedFirstSeen(_ existing: [String: String], papers: [QueueEntry], day: String) -> [String: String] {
        var seen = existing
        for p in papers where seen[p.key] == nil { seen[p.key] = day }
        return seen
    }
}

struct RankedPaper: Identifiable {
    var paper: QueueEntry
    var score: Int
    var reasons: [String]
    var id: String { paper.key }
    var matchesProfile: Bool { reasons.contains { $0.hasPrefix("匹配你") || $0.hasPrefix("摘要提到你") || $0.hasPrefix("与你") } }
}

enum PaperIdentity {
    static func arxiv(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for prefix in ["https://arxiv.org/abs/", "http://arxiv.org/abs/", "https://arxiv.org/pdf/", "arxiv:"] {
            if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        }
        if s.hasSuffix(".pdf") { s = String(s.dropLast(4)) }
        // 内部空白会让 URL(string:) 返回 nil（启动路径 id_list 查询曾强解包崩溃），从键里剥掉
        return s.replacingOccurrences(of: "v[0-9]+$", with: "", options: .regularExpression)
            .components(separatedBy: .whitespacesAndNewlines).joined()
    }
    static func doi(_ raw: String) -> String {
        raw.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "https://doi.org/", with: "").replacingOccurrences(of: "doi:", with: "")
    }
    static func title(_ raw: String) -> String {
        raw.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }
    static func deduplicate(_ papers: [QueueEntry]) -> [QueueEntry] {
        // 索引化去重（曾为 O(n²)：每篇与全部保留项比较，数百篇时首页渲染卡顿）。
        // 匹配语义与 same() 完全一致：key > arXiv > DOI > 规范化标题+作者交集。
        var out: [QueueEntry] = []
        var keyIndex: [String: Int] = [:]
        var arxivIndex: [String: Int] = [:]
        var doiIndex: [String: Int] = [:]
        var titleIndex: [String: [Int]] = [:]
        func reindex(_ i: Int) {
            let p = out[i]
            keyIndex[p.key] = i
            if let a = p.arxiv, !a.isEmpty { arxivIndex[a] = i }
            if let d = p.doi, !d.isEmpty { doiIndex[d] = i }
        }
        for var p in papers where !p.key.isEmpty {
            if let id = p.arxiv { p.arxiv = arxiv(id) }
            if let d = p.doi { p.doi = doi(d) }
            var match = keyIndex[p.key]
            if match == nil, let a = p.arxiv, !a.isEmpty { match = arxivIndex[a] }
            if match == nil, let d = p.doi, !d.isEmpty { match = doiIndex[d] }
            if match == nil {
                let t = title(p.title ?? "")
                if t.count > 20, let candidates = titleIndex[t] {
                    match = candidates.first { i in
                        let aa = Set((out[i].authors ?? []).map(title)), ba = Set((p.authors ?? []).map(title))
                        return !aa.isDisjoint(with: ba)
                    }
                }
            }
            if let i = match {
                // Enrich the original entry, preserving manually maintained metadata.
                out[i].doi = out[i].doi ?? p.doi
                if out[i].id == nil { out[i].arxiv = out[i].arxiv ?? p.arxiv }
                out[i].abstract = out[i].abstract ?? p.abstract
                out[i].pdfUrl = out[i].pdfUrl ?? p.pdfUrl
                out[i].authors = out[i].authors ?? p.authors
                out[i].published = out[i].published ?? p.published
                out[i].source = out[i].source ?? p.source
                reindex(i) // 补充的 arXiv/DOI 必须进索引，否则后续同论文会漏配
            } else {
                let t = title(p.title ?? "")
                if t.count > 20 { titleIndex[t, default: []].append(out.count) }
                out.append(p)
                reindex(out.count - 1)
            }
        }
        return out
    }
    static func same(_ a: QueueEntry, _ b: QueueEntry) -> Bool {
        if a.key == b.key { return true }
        if let x = a.arxiv, let y = b.arxiv, !x.isEmpty, arxiv(x) == arxiv(y) { return true }
        if let x = a.doi, let y = b.doi, !x.isEmpty, doi(x) == doi(y) { return true }
        let t = title(a.title ?? "")
        if t.count > 20, t == title(b.title ?? "") {
            let aa = Set((a.authors ?? []).map(title)), ba = Set((b.authors ?? []).map(title))
            return !aa.isDisjoint(with: ba)
        }
        return false
    }
    static func decodeQueue(_ data: Data) throws -> [QueueEntry] {
        struct Envelope: Decodable { var papers: [QueueEntry] }
        let decoder = JSONDecoder()
        let entries = try (try? decoder.decode(Envelope.self, from: data).papers) ?? decoder.decode([QueueEntry].self, from: data)
        return deduplicate(entries)
    }
    static func rank(_ paper: QueueEntry, profile: ResearchProfile, state: LibraryState,
                     negativeTopics: [String: Int] = [:]) -> RankedPaper {
        let text = ((paper.title ?? "") + " " + (paper.abstract ?? "")).lowercased()
        var score = 10
        var reasons: [String] = []
        for topic in profile.topics.keys.sorted() {
            let weight = profile.topics[topic] ?? 0
            if weight > 0, (ResearchProfile.keywords[topic] ?? []).contains(where: text.contains) {
                score += weight * 12 - (negativeTopics[topic] ?? 0) * 5
                reasons.append("匹配你关注的 \(topic)（权重 \(weight)）")
            }
        }
        for term in profile.datasets.split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) where !term.isEmpty && text.contains(term.lowercased()) {
            score += 8; reasons.append("摘要提到你使用的数据集 \(term)")
        }
        for term in profile.methods.components(separatedBy: CharacterSet(charactersIn: ",，;；")) {
            let method = term.trimmingCharacters(in: .whitespacesAndNewlines)
            let aliases = method.lowercased().contains("implicit") ? [method.lowercased(), "implicit", "neural field", "attenuation field"] : [method.lowercased()]
            if method.count > 2, aliases.contains(where: text.contains) { score += 8; reasons.append("匹配你的技术偏好 \(method)") }
        }
        let tasks: [(String, [String])] = [("投影补全", ["projection completion", "sinogram completion"]), ("体重建", ["reconstruction"]), ("双域", ["dual-domain", "dual domain"]), ("去伪影", ["artifact", "artefact"]), ("测试时适配", ["test-time", "test time"])]
        for (label, words) in tasks where profile.task.contains(label) && words.contains(where: text.contains) {
            score += 4; reasons.append("与你的「\(label)」任务相关，具体设置需回原文核对")
        }
        if state.favorite { score += 12 }
        score += state.relevance * 40
        if state.status == .read { score -= 30 }
        if state.status == .ignored { score -= 100 }
        if reasons.isEmpty { reasons = ["领域探索：与 CBCT/CT 重建相关；尚未匹配你的主题，建议先核对摘要"] }
        return RankedPaper(paper: paper, score: max(0, min(100, score)), reasons: Array(reasons.prefix(3)))
    }
}

struct EvidencePage {
    var number: Int
    var text: String
}

enum Evidence {
    static func pages(_ text: String) -> [EvidencePage] {
        let regex = try! NSRegularExpression(pattern: "=== Page ([0-9]+) ===")
        let ns = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        return matches.enumerated().map { i, m in
            let end = i + 1 < matches.count ? matches[i + 1].range.location : ns.length
            return EvidencePage(number: Int(ns.substring(with: m.range(at: 1)))!, text: ns.substring(with: NSRange(location: m.range.upperBound, length: end - m.range.upperBound)))
        }
    }
    static func citations(_ text: String) -> [Int] {
        let regex = try! NSRegularExpression(pattern: "(?i)Page\\s+(\\d+)")
        return Array(Set(regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap {
            Range($0.range(at: 1), in: text).flatMap { Int(text[$0]) }
        })).sorted()
    }
    static func linked(_ text: String) -> String {
        text.replacingOccurrences(of: "(?i)(?<!\\[)\\bPage\\s+(\\d+)(?![0-9\\]])", with: "[Page $1](cbct-evidence://page/$1)", options: .regularExpression)
    }
    static func select(_ text: String, query: String, scope: String = "全文", limit: Int = 50000) -> String {
        selectWithMeta(text, query: query, scope: scope, limit: limit).text
    }
    /// 返回选中内容与页数覆盖情况；included < total 时调用方必须向模型披露材料为子集（PRD 12.1）。
    static func selectWithMeta(_ text: String, query: String, scope: String = "全文", limit: Int = 50000) -> (text: String, included: Int, total: Int) {
        let all = scope == "全文" ? pages(text) : scopedPages(text, scope: scope)
        guard !all.isEmpty else { return ("", 0, 0) }
        guard text.count > limit || scope != "全文" else { return (text, all.count, all.count) }
        let scopeTerms = ["Method": "method architecture equation geometry", "Experiment": "experiment dataset training results", "Appendix": "appendix supplementary", "Figure": "figure fig caption"]
        let terms = (query + " " + (scopeTerms[scope] ?? "")).lowercased().split { !$0.isLetter && !$0.isNumber }.filter { $0.count > 2 }.map(String.init)
        let sorted = all.sorted { a, b in
            func score(_ p: EvidencePage) -> Int { terms.reduce(0) { $0 + (p.text.lowercased().contains($1) ? 1 : 0) } }
            let sa = score(a), sb = score(b)
            return sa == sb ? a.number < b.number : sa > sb
        }
        var picked: [EvidencePage] = []; var used = 0
        for page in sorted {
            if used + page.text.count + 30 > limit { continue }
            picked.append(page); used += page.text.count + 30
        }
        let body = picked.sorted { $0.number < $1.number }.map { "=== Page \($0.number) ===\n\($0.text)" }.joined(separator: "\n\n")
        return (body, picked.count, all.count)
    }
    /// included < total 时在材料前加范围披露；披露行在第一个页标记之前，不影响页码解析。
    static func scopingNote(_ result: (text: String, included: Int, total: Int)) -> String {
        guard !result.text.isEmpty, result.included < result.total else { return result.text }
        let pages = pages(result.text).map(\.number).map(String.init).joined(separator: "、")
        return "【材料范围】以下仅包含按相关性从全文中选取的 \(result.included)/\(result.total) 页（页码：\(pages)）。未包含的页面同样属于论文：涉及这些页面的信息应回答「论文中未找到（当前证据未覆盖，可扩大范围重试）」，不得仅凭本子集断言论文没有该内容。\n\n" + result.text
    }
    // Section-limited retrieval keeps the original PDF page numbers. If headings
    // cannot be identified, return no evidence rather than silently widen the scope.
    static func scopedPages(_ text: String, scope: String) -> [EvidencePage] {
        if scope == "Figure" {
            return pages(text).compactMap { page in
                let lines = page.text.components(separatedBy: "\n")
                var captions: [String] = []
                for (i, line) in lines.enumerated() where line.range(of: "(?i)^\\s*(fig\\.?|figure)\\s*[0-9]+", options: .regularExpression) != nil {
                    captions += lines[i..<min(lines.count, i + 5)]
                }
                return captions.isEmpty ? nil : EvidencePage(number: page.number, text: captions.joined(separator: "\n"))
            }
        }
        var active = false, out: [EvidencePage] = []
        for page in pages(text) {
            var lines: [String] = []
            for line in page.text.components(separatedBy: "\n") {
                let heading = line.trimmingCharacters(in: .whitespaces).lowercased()
                let major = heading.range(of: "^([0-9]+[. ]+|[a-z][. ]+)?(introduction|related work|background|method|methods|methodology|approach|experiment|experiments|experimental|results|discussion|conclusion|references|bibliography|appendix|supplementary)\\b", options: .regularExpression) != nil
                if major {
                    // References/Bibliography 对任何 scope 都强制关闭——
                    // 否则 Method/Experiment 会把参考文献整段吸进证据范围（曾在真实 NAF 上发生）
                    if heading.range(of: "^(references|bibliography|[0-9]+[. ]+references)\\b", options: .regularExpression) != nil {
                        active = false
                        continue
                    }
                    switch scope {
                    case "Method": active = heading.contains("method") || heading.contains("approach")
                    case "Experiment": active = heading.contains("experiment") || heading.contains("results")
                    case "Appendix": active = heading.contains("appendix") || heading.contains("supplementary")
                    default: active = false
                    }
                }
                if active { lines.append(line) }
            }
            if !lines.isEmpty { out.append(EvidencePage(number: page.number, text: lines.joined(separator: "\n"))) }
        }
        return out
    }
    static func validate(_ output: String, source: String) throws {
        let refs = citations(output), available = Set(pages(source).map(\.number))
        if refs.isEmpty || !Set(refs).isSubset(of: available) {
            throw NSError(domain: "evidence", code: 1, userInfo: [NSLocalizedDescriptionKey: "输出缺少有效证据页码，未保存。请重试或核对原文。"])
        }
    }
    static func normalized(_ text: String) -> String {
        text.precomposedStringWithCompatibilityMapping.lowercased()
            .replacingOccurrences(of: "(?<=\\p{L})-[ \\t]*\\n[ \\t]*(?=\\p{L})", with: "", options: .regularExpression)
            .replacingOccurrences(of: "−", with: "-").filter { !$0.isWhitespace }
            .replacingOccurrences(of: "(?<=\\p{L}{2})-(?=\\p{L}{2})", with: "", options: .regularExpression)
    }
    static func numbers(_ text: String) -> Set<String> {
        var text = text.precomposedStringWithCompatibilityMapping.lowercased()
            .replacingOccurrences(of: "−", with: "-").replacingOccurrences(of: "–", with: "-")
        // 英文数量词归一：摘录用英文（a single RTX 3090）、抽取值用数字（1）时仍能通过数字支持校验
        let spelled = ["zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "single": "1"]
        for (word, value) in spelled { text = text.replacingOccurrences(of: "\\b" + word + "\\b", with: value, options: .regularExpression) }
        let regex = try! NSRegularExpression(pattern: "[+-]?(?:[0-9]*\\.[0-9]+|[0-9]+)")
        let ns = text as NSString
        let scalars = Array(text.unicodeScalars)
        func isLetter(_ i: Int) -> Bool { i >= 0 && i < scalars.count && CharacterSet.letters.contains(scalars[i]) }
        // 只排除「完全嵌在单词中间」的数字（IntraTomo3D -> 3），避免把方法名里的数字当成测量值：
        // 否则伪造值只要等于方法名里的数字（3/20/28…）就能通过数字支持校验。
        // 刻意保留贴在单词后面或开头的型号数字（RTX3090 -> 3090、1.2GB -> 1.2），它们是论文真实报告的事实。
        return Set(regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m -> String? in
            if isLetter(m.range.location - 1) && isLetter(m.range.location + m.range.length) { return nil }
            return ns.substring(with: m.range)
        })
    }
    // Diagnostic only: an invalid quote remains invalid. Show a verbatim fragment
    // from the requested page so the model can repair cross-page quotations.
    static func matchingQuoteFragment(_ quote: String, in text: String) -> String? {
        let needle = normalized(quote), haystack = normalized(text)
        guard needle.count >= 8 else { return nil }
        for size in stride(from: min(needle.count, 700), through: 8, by: -1) {
            for fragment in [String(needle.prefix(size)), String(needle.suffix(size))] where haystack.contains(fragment) {
                if let range = quoteRange(fragment, in: text) { return (text as NSString).substring(with: range) }
            }
        }
        return nil
    }
}

/// 结构化输出的 JSON 提取：模型常把 JSON 包在 ```json 围栏里、前后加说明文字，
/// 只剥围栏并截取最外层 {}，不改动 JSON 内容本身（部分论文结果分析曾因此解码失败）。
enum JSONExtract {
    static func object(from raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("```") {
            text = text.components(separatedBy: "\n").dropFirst().joined(separator: "\n")
            if let end = text.range(of: "```") { text = String(text[..<end.lowerBound]) }
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end else { return text }
        return String(text[start...end])
    }
}

struct ExperimentField: Codable {
    var k: String
    var v: String
    var page: Int?
    var excerpt: String?
}

struct ExperimentExtraction: Codable {
    var dataset: [ExperimentField]
    var acquisition: [ExperimentField]
    var training: [ExperimentField]
    var loss: [ExperimentField]
    var metrics: [ExperimentField]
    var results: [ExperimentField]
    var baselines: [ExperimentField]? = nil // Optional for legacy reading files.
    var groups: [(String, String, [ExperimentField])] {
        [("dataset", "数据集", dataset), ("acquisition", "采集与几何", acquisition), ("training", "训练", training),
         ("loss", "损失", loss), ("baselines", "对比基线", baselines ?? []), ("metrics", "评价指标", metrics), ("results", "结果", results)]
    }
    static func decode(_ text: String) throws -> Self {
        let raw = JSONExtract.object(from: text)
        return try JSONDecoder().decode(Self.self, from: Data(raw.utf8))
    }
    func validateConfiguration() throws {
        var problems: [String] = []
        if !results.isEmpty { problems.append("实验配置不能混入结果数值，results 应为空数组。") }
        for field in training where field.k.range(of: "(?i)训练.*(?:时长|耗时|时间)|training.*(?:time|duration)", options: .regularExpression) != nil {
            let quote = field.excerpt ?? ""
            if quote.range(of: "(?i)reconstruct", options: .regularExpression) != nil,
               quote.range(of: "(?i)train|optimi|updat", options: .regularExpression) == nil {
                problems.append("「" + field.k + "」的原文只报告重建耗时，不能标为训练时长；放在对应结果图的解读中。")
            }
        }
        for field in loss where field.k.range(of: "(?i)公式|equation|formula", options: .regularExpression) != nil {
            problems.append("「" + field.k + "」应在方法对应模块中介绍，本章仅列损失类型与权重。")
        }
        if !problems.isEmpty { throw NSError(domain: "extraction", code: 4, userInfo: [NSLocalizedDescriptionKey: problems.joined(separator: "；")]) }
    }
    func validate(source: String) throws {
        let pages = Dictionary(uniqueKeysWithValues: Evidence.pages(source).map { ($0.number, $0.text) })
        let fields = groups.flatMap { $0.2 }
        guard !fields.isEmpty else { throw NSError(domain: "extraction", code: 1, userInfo: [NSLocalizedDescriptionKey: "实验抽取没有返回字段，请重试。"] ) }
        var problems: [String] = []
        for field in fields {
            if ["论文未说明", "论文中未说明", "论文中未找到", "未报告"].contains(field.v), field.page == nil, field.excerpt == nil { continue }
            guard let page = field.page, let text = pages[page], let quote = field.excerpt,
                  Evidence.normalized(quote).count >= 8,
                  Evidence.normalized(text).contains(Evidence.normalized(quote)) else {
                var diagnostic = "「\(field.k)」缺少对应页的逐字摘录；引用单页不可拼接跨页文字"
                if let page = field.page, let text = pages[page], let quote = field.excerpt,
                   let fragment = Evidence.matchingQuoteFragment(quote, in: text) {
                    diagnostic += "。Page \(page) 内可匹配的原文片段：\(fragment)；仅用本页片段支持的事实重新填写 v/excerpt，不能沿用片段未支持的数字或其他事实"
                }
                problems.append(diagnostic)
                continue
            }
            let unsupported = Evidence.numbers(field.v).subtracting(Evidence.numbers(quote))
            if !unsupported.isEmpty { problems.append("「\(field.k)：\(field.v.prefix(100))」的数字 \(unsupported.sorted().joined(separator: ", ")) 未被所附摘录支持") }
        }
        if !problems.isEmpty {
            throw NSError(domain: "extraction", code: 2, userInfo: [NSLocalizedDescriptionKey: "证据校验未通过，未保存：" + problems.joined(separator: "；")])
        }
    }
}

struct ReadingAudit: Codable {
    var model: String
    var generatedAt: String
    var extractionVersion: String
    var evidencePages: [Int]
}
