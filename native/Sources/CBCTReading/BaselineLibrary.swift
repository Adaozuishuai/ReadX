import Foundation

// Baseline 百科与方法卡片（PRD 4.7）。
//
// PRD 要求为 FDK、SART、DuDoNet、C²RV、NeRP、Trans²-CBCT 等建立方法卡片，字段：
// 论文来源、任务、输入输出、核心思想、代码、常用数据集、适用设置、与当前论文关系。
//
// 设计约束（沿用 evidence-first 原则，与本项目其它模块一致）：
// - 卡片内容是**领域常识**，不是某一篇论文的抽取结果，因此必须显式标注来源类型；
// - 凡不确定的字段写 `nil`，UI 显示「待核对」，**不补造**；
// - 卡片与「某篇论文提到了哪些基线」是两件事：后者是 ExperimentExtraction.baselines。

/// 方法类别，决定 UI 分组与「这是不是神经网络」的展示。
enum BaselineKind: String, Codable, CaseIterable {
    case analytical = "解析重建"
    case iterative = "迭代重建"
    case deepLearning = "深度学习"
    case implicit = "隐式表示"
    case hybrid = "混合 / 插件式"

    var isNeuralNetwork: Bool {
        switch self {
        case .deepLearning, .implicit: return true
        case .analytical, .iterative: return false
        case .hybrid: return true
        }
    }
}

/// 字段来源：区分「已知事实」与「需要回原文核对」。
enum BaselineFactSource: String, Codable {
    case known = "领域常识"
    case needsReview = "待核对"

    var label: String { rawValue }
}

struct BaselineCard: Codable, Identifiable {
    var id: String
    var name: String
    var aliases: [String]
    var kind: BaselineKind
    /// 论文来源（会议/期刊或「经典文献」，不确定则 nil）
    var origin: String?
    var task: String
    var inputOutput: String
    var coreIdea: String
    var codeURL: String?
    var commonDatasets: [String]
    /// 适用设置：在什么条件下该基线是合理对照
    var applicableSettings: String
    /// 已知局限，用于 Critical Review 时提醒
    var knownLimitations: String?
    var source: BaselineFactSource

    /// 别名匹配：判断某篇论文提到的基线名是否就是这张卡片。
    static func matchKey(_ raw: String) -> String {
        raw.lowercased()
            .replacingOccurrences(of: "²", with: "2")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")
    }
}

enum BaselineLibrary {
    /// PRD 4.7 点名的六个方法 + 项目已用到的 IntraTomo3D。
    /// 所有条目 source = .known（教科书级事实），不确定字段留 nil。
    static let cards: [BaselineCard] = [
        BaselineCard(
            id: "fdk", name: "FDK", aliases: ["Feldkamp-Davis-Kress", "FBP", "filtered back-projection"],
            kind: .analytical,
            origin: "Feldkamp et al., 1984, JOSA A",
            task: "锥束几何的解析重建",
            inputOutput: "投影数据（sinogram）→ 体数据",
            coreIdea: "对投影先加权与滤波，再沿锥束几何反投影回三维体积；无需迭代优化。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "投影数量充足（通常数百视角以上）、噪声较低时作为性能下界；稀疏视角下是退化对照。",
            knownLimitations: "稀疏视角/有限角下伪影显著；不对噪声与不完整数据建模。",
            source: .known
        ),
        BaselineCard(
            id: "sart", name: "SART", aliases: ["Simultaneous Algebraic Reconstruction Technique"],
            kind: .iterative,
            origin: "Andersen & Kak, 1984, Ultrasonic Imaging",
            task: "代数迭代重建",
            inputOutput: "投影数据 → 体数据（迭代更新）",
            coreIdea: "把重建当作线性方程组，每个视角做一次代数更新并交替扫描，逐步逼近与投影一致的解。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "稀疏视角下常用的迭代对照；可作为「无学习先验」的强基线。",
            knownLimitations: "收敛速度与结果依赖迭代次数、松弛因子等超参；这些参数常不公开，跨论文比较需核对设置。",
            source: .known
        ),
        BaselineCard(
            id: "asd-pocs", name: "ASD-POCS", aliases: ["ASD POCS", "adaptive steepest descent projection onto convex sets"],
            kind: .iterative,
            origin: "Sidky & Pan, 2008, Physics in Medicine & Biology",
            task: "带 TV 正则的迭代重建",
            inputOutput: "投影数据 → 体数据",
            coreIdea: "在 POCS 的数据一致性约束之外，加入全变差（TV）最小化的自适应最速下降步，抑制稀疏视角伪影。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "稀疏视角下的 TV 正则基线。",
            knownLimitations: "TV 正则会带来块状/阶梯伪影；正则权重需调参且常未报告。",
            source: .known
        ),
        BaselineCard(
            id: "dudonet", name: "DuDoNet", aliases: ["Dual Domain Network"],
            kind: .hybrid,
            origin: nil,
            task: "双域（投影域 + 图像域）联合去伪影",
            inputOutput: "投影数据 → 投影域处理 → 图像域处理 → 体/图像数据",
            coreIdea: "在投影域与图像域各设一个网络，用可微的 Radon 反投影层连接两域，端到端联合优化。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "需要投影域信息参与的金属伪影/稀疏视角任务。",
            knownLimitations: "两域级联的训练稳定性与损失权重敏感；原始论文的具体设置需回原文核对。",
            source: .known
        ),
        BaselineCard(
            id: "c2rv", name: "C²RV", aliases: ["C2RV", "Cone-beam-to-Volume", "cone beam to volume"],
            kind: .deepLearning,
            origin: nil,
            task: "稀疏视角 CBCT 重建（投影到体积的域变换视角）",
            inputOutput: "稀疏投影 → 体积",
            coreIdea: "从「域变换」角度建模投影到体积的映射，而非逐视角补全。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "稀疏视角 CBCT；作为有监督深度学习对照。",
            knownLimitations: "需要训练数据；具体网络结构与训练协议需回原文核对（本卡片未记录，标记为待核对）。",
            source: .needsReview
        ),
        BaselineCard(
            id: "nerp", name: "NeRP", aliases: ["Neural Representation Prior", "NeRP"],
            kind: .implicit,
            origin: "Shen et al., 2022, IEEE Trans. Med. Imaging",
            task: "稀疏视角 CT 重建（隐式神经表示）",
            inputOutput: "稀疏投影 → 连续神经场 → 体数据",
            coreIdea: "用 MLP 表示衰减场，先在已有先验数据上预训练，再用少量投影做单例优化。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "稀疏视角 CT；与 NAF 同属隐式表示路线，差别在是否依赖外部先验预训练。",
            knownLimitations: "依赖预训练先验，属「需要外部训练数据」；跨域迁移效果需核对。",
            source: .known
        ),
        BaselineCard(
            id: "trans2-cbct", name: "Trans²-CBCT", aliases: ["Trans2-CBCT", "Trans^2-CBCT", "Trans2CBCT"],
            kind: .deepLearning,
            origin: nil,
            task: "稀疏视角 CBCT 重建（Transformer 路线）",
            inputOutput: "稀疏投影 → 体数据",
            coreIdea: "以 Transformer 建模投影间/体积内的长程依赖。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "稀疏视角 CBCT；作为 Transformer 架构对照。",
            knownLimitations: "具体实现与训练设置需回原文核对（本卡片未记录）。",
            source: .needsReview
        ),
        BaselineCard(
            id: "intratomo3d", name: "IntraTomo3D", aliases: ["IntraTomo", "IntraTomo 3D"],
            kind: .implicit,
            origin: "Zang et al., 2021, ICCV（IntraTomo 的 CBCT 变体）",
            task: "自监督稀疏视角/有限角重建（正弦图预测 + 几何修正）",
            inputOutput: "稀疏或有限角投影 → 密度场 → 重建体积",
            coreIdea: "把密度场表示为可微神经网络函数，用「正弦图预测模块」+「几何修正模块」交替迭代，自监督无需训练数据。",
            codeURL: nil,
            commonDatasets: [],
            applicableSettings: "极稀疏（可到 8 views）与有限角（45°）；NAF 论文中报其为重建耗时更长的对照（>1h vs 10–40min）。",
            knownLimitations: "每例优化耗时较长；两模块交替的收敛性依赖迭代配置。",
            source: .known
        ),
    ]

    static func card(id: String) -> BaselineCard? { cards.first { $0.id == id } }

    /// 按论文里出现的基线名匹配卡片。返回命中的卡片与原始写法。
    static func matches(baselineNames: [String]) -> [(BaselineCard, String)] {
        var out: [(BaselineCard, String)] = []
        var seen = Set<String>()
        for raw in baselineNames where !raw.isEmpty {
            let key = BaselineCard.matchKey(raw)
            guard !key.isEmpty else { continue }
            for card in cards {
                let hit = [card.name] + card.aliases
                if hit.contains(where: { BaselineCard.matchKey($0) == key || key.contains(BaselineCard.matchKey($0)) }) {
                    if seen.insert(card.id).inserted { out.append((card, raw)) }
                    break
                }
            }
        }
        return out
    }

    /// 「与当前论文的关系」：把卡片与某篇论文已抽取的基线字段对照。
    /// 只区分「该论文确实提到了」与「未提及」，不做方法优劣推断。
    static func relation(_ card: BaselineCard, baselineNames: [String]) -> String {
        let key = BaselineCard.matchKey(card.name)
        let mentioned = baselineNames.contains { raw in
            let k = BaselineCard.matchKey(raw)
            return k == key || k.contains(key) || key.contains(k)
        }
        return mentioned
            ? "该论文的对比基线中包含 \(card.name)。"
            : "在当前抽取到的基线字段中未见 \(card.name)；如需对比请回原文核对。"
    }
}
