import Foundation

// 系统标签体系（PRD 7.2）：系统标签与用户标签并存。
// 系统标签覆盖 Task / Domain / Acquisition / Architecture / Learning Paradigm /
// Dataset / Metric / Venue 八类，从论文文本与已抽取的实验字段**派生**，不覆盖用户自建标签。
//
// 设计约束（沿用 evidence-first 原则）：
// - 只做「文本里确实出现」的关键词匹配，命不中就是空，绝不推测；
// - 每条系统标签都记录命中的依据词，便于用户核对为什么被打上这个标签。

enum SystemTagCategory: String, CaseIterable, Codable {
    case task = "Task"
    case domain = "Domain"
    case acquisition = "Acquisition"
    case architecture = "Architecture"
    case paradigm = "Learning Paradigm"
    case dataset = "Dataset"
    case metric = "Metric"
    case venue = "Venue"

    var label: String { rawValue }
}

struct SystemTag: Equatable {
    var category: SystemTagCategory
    var value: String
    /// 命中的原文关键词，用于「为什么有这个标签」核对。
    var evidence: String
}

enum SystemTags {
    /// 八类关键词表。键是展示用标签值，值是该标签的同义线索（全部小写）。
    static let vocabulary: [SystemTagCategory: [String: [String]]] = [
        .task: [
            "Sparse-view": ["sparse-view", "sparse view", "few-view", "few view", "limited-angle"],
            "Low-dose": ["low-dose", "low dose", "low-mas", "low mas", "dose reduction"],
            "4D-CBCT": ["4d-cbct", "4d cbct", "dynamic cbct", "motion"],
            "Artifact Removal": ["artifact", "artefact", "metal artifact", "scatter correction"],
            "Projection Completion": ["projection completion", "sinogram completion", "inpainting"],
            "Super-resolution": ["super-resolution", "super resolution", "superresolution"],
        ],
        .domain: [
            "Projection": ["sinogram", "projection domain", "raw projection"],
            "Image": ["image domain", "image-domain", "post-processing"],
            "Dual-domain": ["dual-domain", "dual domain"],
            "Implicit 3D": ["implicit", "neural field", "neural radiance", "attenuation field"],
        ],
        .acquisition: [
            "Circular": ["circular", "full-scan", "360"],
            "Limited-angle": ["limited-angle", "limited angle", "45°", "limited angular"],
            "Real scan": ["real data", "real-world", "patient", "clinical"],
            "Simulated": ["simulated", "simulation", "tigre", "synthetic"],
        ],
        .architecture: [
            "CNN": ["convolutional", "cnn", "u-net", "unet"],
            "Transformer": ["transformer", "attention", "vit"],
            "MLP": ["mlp", "multi-layer perceptron", "multilayer perceptron"],
            "Diffusion": ["diffusion", "score-based", "denoising diffusion"],
            "Gaussian": ["gaussian splatting", "3d gaussian", "gaussian representation"],
            "Hash Grid": ["hash encoding", "hash grid", "instant-ngp", "multiresolution hash"],
        ],
        .paradigm: [
            "Supervised": ["supervised", "ground truth supervision"],
            "Self-supervised": ["self-supervised", "self supervised", "unsupervised", "without training data"],
            "Per-case Optimization": ["per-case", "per case", "per-subject", "per-patient"],
            "Test-time Adaptation": ["test-time", "test time", "scan-adaptive", "tta"],
        ],
        .dataset: [
            "Walnut": ["walnut"],
            "LUNA16": ["luna16", "luna-16"],
            "AAPM": ["aapm", "low dose ct grand challenge"],
            "LIDC-IDRI": ["lidc", "lidc-idri"],
            "TIGRE": ["tigre"],
            "Real Phantom": ["phantom"],
        ],
        .metric: [
            "PSNR": ["psnr", "peak signal-to-noise"],
            "SSIM": ["ssim", "structural similarity"],
            "RMSE": ["rmse", "root mean square"],
            "MAE": ["mae", "mean absolute error"],
            "LPIPS": ["lpips"],
        ],
        .venue: [
            "MICCAI": ["miccai"],
            "CVPR": ["cvpr"],
            "ICCV": ["iccv"],
            "ECCV": ["eccv"],
            "NeurIPS": ["neurips", "nips"],
            "ICLR": ["iclr", "international conference on learning representations"],
            "AAAI": ["aaai", "association for the advancement of artificial intelligence"],
            "IEEE TMI": ["ieee transactions on medical imaging", "tmi"],
            "Medical Physics": ["medical physics"],
            "Physics in Medicine & Biology": ["physics in medicine"],
        ],
    ]

    /// 从论文的可检索文本里派生系统标签。
    /// - Parameter fields: 供匹配的文本片段（标题、摘要、venue，以及已抽取实验字段的 k/v）。
    /// - Returns: 命中的系统标签，按类别顺序输出；同一 value 只输出一次。
    static func derive(from fields: [String]) -> [SystemTag] {
        let haystack = fields.joined(separator: " ").lowercased()
        guard !haystack.isEmpty else { return [] }
        var out: [SystemTag] = []
        var seen = Set<String>()
        for category in SystemTagCategory.allCases {
            guard let values = vocabulary[category] else { continue }
            for (label, cues) in values.sorted(by: { $0.key < $1.key }) {
                guard let hit = cues.first(where: { haystack.contains($0) }) else { continue }
                let id = category.rawValue + "|" + label
                guard seen.insert(id).inserted else { continue }
                out.append(SystemTag(category: category, value: label, evidence: hit))
            }
        }
        return out
    }

    /// 覆盖报告：PRD 要求系统标签「至少覆盖」八类，这里给出每类的命中数，
    /// 便于 UI 明确显示「哪些类别没有证据」而不是假装有。
    static func coverage(_ tags: [SystemTag]) -> [(SystemTagCategory, Int)] {
        SystemTagCategory.allCases.map { c in (c, tags.filter { $0.category == c }.count) }
    }
}
