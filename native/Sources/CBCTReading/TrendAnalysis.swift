import Foundation

// Trend / Research Gap 的证据契约（PRD 4.16 与第 12 节风险表）。
//
// PRD 对趋势输出的硬约束：
//  1) 必须展示**时间窗口**；
//  2) 必须展示**论文数量 / 样本数**；
//  3) 必须展示**证据集合**（哪些论文支撑这条结论）；
//  4) 「只能输出证据支持的潜在空白，不能把缺少检索证据的内容包装成首次」；
//  5) 风险表明确警告「样本少导致伪趋势」。
//
// 因此这里的设计是：**样本不足时拒绝给出趋势判断**，只报告计数与缺口语义，
// 而不是输出一个看起来很像结论的百分比。

struct TrendSample {
    /// 参与统计的论文（顺序无关）。
    var papers: [QueueEntry]
    /// 时间窗口。PRD 要求可展示，所以窗口本身是一等公民而非隐含前提。
    var windowStart: String?
    var windowEnd: String?

    var count: Int { papers.count }
    var isWindowBounded: Bool { windowStart != nil && windowEnd != nil }
}

struct TrendEvidence {
    var tag: SystemTag
    var papers: [QueueEntry]
    var count: Int { papers.count }
}

/// 一条趋势结论。`claim` 与 `caveat` 分离，UI 必须同时展示，避免只看到结论。
struct TrendFinding {
    var topic: String
    var count: Int
    var sample: TrendSample
    var evidence: [TrendEvidence]
    /// 是否达到可下判断的最小样本量。
    var isSupported: Bool
    var claim: String
    var caveat: String

    /// 给 UI 用的完整描述：时间窗 + 样本数 + 证据集合，三样缺一不可。
    var disclosure: String {
        let window = sample.isWindowBounded
            ? "\(sample.windowStart!) ~ \(sample.windowEnd!)"
            : "时间窗口未知"
        return "时间窗口：\(window) · 样本数：\(count) 篇 · 证据："
            + evidence.map { "\($0.tag.value)(\($0.count))" }.joined(separator: "、")
    }
}

enum TrendAnalysis {
    /// 低于该样本量不下趋势判断。PRD 风险表点名「样本少导致伪趋势」，
    /// 这里取 5 作为保守下限：少于 5 篇只能报告计数，不能声称「升温/新兴」。
    static let minimumSample = 5

    /// 从论文集合里提取时间窗口（按 published/year 的年份）。
    static func window(_ papers: [QueueEntry]) -> (String?, String?) {
        let years = papers.compactMap { p -> String? in
            for c in [p.published, p.year] {
                guard let c else { continue }
                let d = c.prefix(4).filter(\.isNumber)
                if d.count == 4 { return String(d) }
            }
            return nil
        }
        guard let lo = years.min(), let hi = years.max() else { return (nil, nil) }
        return (lo, hi)
    }

    static func sample(_ papers: [QueueEntry]) -> TrendSample {
        let (lo, hi) = window(papers)
        return TrendSample(papers: papers, windowStart: lo, windowEnd: hi)
    }

    /// 按系统标签聚合，产出带完整披露信息的趋势条目。
    /// - Parameter papers: 参与统计的集合（通常是 savedPapers）
    static func findings(_ papers: [QueueEntry], using tags: (QueueEntry) -> [SystemTag]) -> [TrendFinding] {
        let sample = sample(papers)
        var groups: [String: (SystemTag, [QueueEntry])] = [:]
        for paper in papers {
            for tag in tags(paper) {
                let id = tag.category.rawValue + "|" + tag.value
                groups[id, default: (tag, [])].1.append(paper)
            }
        }
        return groups.values.map { tag, members in
            let supported = members.count >= minimumSample
            let claim = supported
                ? "\(members.count) 篇论文涉及 \(tag.value)"
                : "\(members.count) 篇论文涉及 \(tag.value)（样本不足，不下趋势判断）"
            return TrendFinding(
                topic: tag.value,
                count: members.count,
                sample: sample,
                evidence: [TrendEvidence(tag: tag, papers: members)],
                isSupported: supported,
                claim: claim,
                caveat: supported
                    ? "仅为计数与证据集合，不代表该方向「升温」或「首次」；时间窗口 \(sample.windowStart ?? "?")–\(sample.windowEnd ?? "?") 内共 \(sample.count) 篇。"
                    : "样本数 \(members.count) < \(minimumSample)：不下趋势判断，只报告计数与证据集合；请扩大检索范围后重试。"
            )
        }.sorted { $0.count == $1.count ? $0.topic < $1.topic : $0.count > $1.count }
    }

    /// Research Gap 只能表述为「检索范围内未见」，不得表述为「无人做过 / 首次」。
    static func gapStatement(topic: String, sample: TrendSample) -> String {
        let window = sample.isWindowBounded ? "\(sample.windowStart!)–\(sample.windowEnd!)" : "当前"
        return "在 \(window) 的 \(sample.count) 篇检索范围内，未发现针对「\(topic)」的直接工作。"
            + "这是检索范围内的缺口，不等于该方向无人研究，也不构成「首次」声明。"
    }

    /// 禁止出现的措辞（PRD 红线：不能声称首次）。
    static let forbiddenPhrases = ["首次", "首个", "first to", "no one has", "无人研究过", "前所未有的"]

    /// 否定前缀：出现在禁用语之前时，该处属于「声明不构成首次」，不算违规。
    /// 例：'不构成「首次」声明' 是否定用法，应放行；'这是首次提出' 才是违规。
    static let negationMarkers = ["不构成", "不是", "不等于", "并非", "不得", "不能", "禁止", "无「", "不存在", "no claim of", "not the first"]

    /// 输出前自检：命中红线措辞即视为不合规。
    /// 需要跳过否定语境，否则「不构成首次声明」这种合规表述会被误判。
    static func violatesRedline(_ text: String) -> Bool {
        let lower = text.lowercased()
        for phrase in forbiddenPhrases {
            let needle = phrase.lowercased()
            var searchStart = lower.startIndex
            while let r = lower.range(of: needle, range: searchStart..<lower.endIndex) {
                // 取该禁用语之前的一小段窗口，看是否紧邻否定标记
                let windowStart = lower.index(r.lowerBound, offsetBy: -12, limitedBy: lower.startIndex) ?? lower.startIndex
                let prefix = String(lower[windowStart..<r.lowerBound])
                if !negationMarkers.contains(where: { prefix.contains($0.lowercased()) }) {
                    return true
                }
                searchStart = r.upperBound
            }
        }
        return false
    }
}
