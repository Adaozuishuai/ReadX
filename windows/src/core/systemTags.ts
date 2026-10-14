// 系统标签体系（PRD 7.2）：系统标签与用户标签并存。
// 系统标签覆盖 Task / Domain / Acquisition / Architecture / Learning Paradigm /
// Dataset / Metric / Venue 八类，从论文文本与已抽取的实验字段**派生**，不覆盖用户自建标签。
//
// 设计约束（沿用 evidence-first 原则）：
// - 只做「文本里确实出现」的关键词匹配，命不中就是空，绝不推测；
// - 每条系统标签都记录命中的依据词，便于用户核对为什么被打上这个标签。
//
// 移植自早期 macOS（Swift）版 SystemTags.swift（逐条保真，禁止改语义）。

import { QueueEntry } from './types';

/**
 * 八类系统标签。取值字符串与 Swift `SystemTagCategory.rawValue` 完全一致，
 * 顺序即 `allCases` 顺序——derive 的输出顺序依赖它，改动会改变标签顺序。
 */
export const SYSTEM_TAG_CATEGORIES = [
  'Task',
  'Domain',
  'Acquisition',
  'Architecture',
  'Learning Paradigm',
  'Dataset',
  'Metric',
  'Venue',
] as const;

export type SystemTagCategory = typeof SYSTEM_TAG_CATEGORIES[number];

/** Swift 里的 `var label: String { rawValue }`。 */
export function categoryLabel(category: SystemTagCategory): string {
  return category;
}

export interface SystemTag {
  category: SystemTagCategory;
  value: string;
  /** 命中的原文关键词，用于「为什么有这个标签」核对。 */
  evidence: string;
}

/**
 * 八类关键词表。键是展示用标签值，值是该标签的同义线索（全部小写）。
 *
 * 注意：每个线索数组的**顺序**参与语义——Swift 用 `cues.first(where:)` 取第一个命中词，
 * 所以 evidence 记录的是数组里第一个出现的线索，而不是文本里最先出现的那一个。
 * 两个语言的匹配都是「子串包含」，不是词边界匹配（例如 "supervised" 会命中 "self-supervised"）。
 */
export const vocabulary: Record<SystemTagCategory, Record<string, string[]>> = {
  Task: {
    'Sparse-view': ['sparse-view', 'sparse view', 'few-view', 'few view', 'limited-angle'],
    'Low-dose': ['low-dose', 'low dose', 'low-mas', 'low mas', 'dose reduction'],
    '4D-CBCT': ['4d-cbct', '4d cbct', 'dynamic cbct', 'motion'],
    'Artifact Removal': ['artifact', 'artefact', 'metal artifact', 'scatter correction'],
    'Projection Completion': ['projection completion', 'sinogram completion', 'inpainting'],
    'Super-resolution': ['super-resolution', 'super resolution', 'superresolution'],
  },
  Domain: {
    Projection: ['sinogram', 'projection domain', 'raw projection'],
    Image: ['image domain', 'image-domain', 'post-processing'],
    'Dual-domain': ['dual-domain', 'dual domain'],
    'Implicit 3D': ['implicit', 'neural field', 'neural radiance', 'attenuation field'],
  },
  Acquisition: {
    Circular: ['circular', 'full-scan', '360'],
    'Limited-angle': ['limited-angle', 'limited angle', '45°', 'limited angular'],
    'Real scan': ['real data', 'real-world', 'patient', 'clinical'],
    Simulated: ['simulated', 'simulation', 'tigre', 'synthetic'],
  },
  Architecture: {
    CNN: ['convolutional', 'cnn', 'u-net', 'unet'],
    Transformer: ['transformer', 'attention', 'vit'],
    MLP: ['mlp', 'multi-layer perceptron', 'multilayer perceptron'],
    Diffusion: ['diffusion', 'score-based', 'denoising diffusion'],
    Gaussian: ['gaussian splatting', '3d gaussian', 'gaussian representation'],
    'Hash Grid': ['hash encoding', 'hash grid', 'instant-ngp', 'multiresolution hash'],
  },
  'Learning Paradigm': {
    Supervised: ['supervised', 'ground truth supervision'],
    'Self-supervised': ['self-supervised', 'self supervised', 'unsupervised', 'without training data'],
    'Per-case Optimization': ['per-case', 'per case', 'per-subject', 'per-patient'],
    'Test-time Adaptation': ['test-time', 'test time', 'scan-adaptive', 'tta'],
  },
  Dataset: {
    Walnut: ['walnut'],
    LUNA16: ['luna16', 'luna-16'],
    AAPM: ['aapm', 'low dose ct grand challenge'],
    'LIDC-IDRI': ['lidc', 'lidc-idri'],
    TIGRE: ['tigre'],
    'Real Phantom': ['phantom'],
  },
  Metric: {
    PSNR: ['psnr', 'peak signal-to-noise'],
    SSIM: ['ssim', 'structural similarity'],
    RMSE: ['rmse', 'root mean square'],
    MAE: ['mae', 'mean absolute error'],
    LPIPS: ['lpips'],
  },
  Venue: {
    MICCAI: ['miccai'],
    CVPR: ['cvpr'],
    ICCV: ['iccv'],
    ECCV: ['eccv'],
    NeurIPS: ['neurips', 'nips'],
    'IEEE TMI': ['ieee transactions on medical imaging', 'tmi'],
    'Medical Physics': ['medical physics'],
    'Physics in Medicine & Biology': ['physics in medicine'],
  },
};

/**
 * 从论文的可检索文本里派生系统标签。
 *
 * - Parameter fields: 供匹配的文本片段（标题、摘要、venue，以及已抽取实验字段的 k/v）——
 *   Swift 里这些字段由 `Store.tagFields(for:)` 汇总，本模块只负责纯匹配，不读盘。
 * - Returns: 命中的系统标签，按类别顺序输出；同一 value 只输出一次。
 *
 * 实现细节必须与 Swift 一致：
 *   1. 所有字段用空格 join 后**整体** lowercase，再做 `contains` 匹配（跨字段拼接可产生假命中，
 *      这是 Swift 的既有语义，移植不改）；
 *   2. 命不中就不输出，绝不推测；
 *   3. 按 `SystemTagCategory.allCases` 顺序、类内按 value 字典序遍历；
 *   4. 用 `category|value` 去重（同一 value 只输出一次）。
 */
export function derive(fields: string[]): SystemTag[] {
  const haystack = fields.join(' ').toLowerCase();
  if (!haystack) return [];
  const out: SystemTag[] = [];
  const seen = new Set<string>();
  for (const category of SYSTEM_TAG_CATEGORIES) {
    const values = vocabulary[category];
    if (!values) continue;
    for (const label of Object.keys(values).sort()) {
      const hit = values[label].find((cue) => haystack.includes(cue));
      if (hit === undefined) continue;
      const id = category + '|' + label;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ category, value: label, evidence: hit });
    }
  }
  return out;
}

/**
 * 覆盖报告：PRD 要求系统标签「至少覆盖」八类，这里给出每类的命中数，
 * 便于 UI 明确显示「哪些类别没有证据」而不是假装有。
 */
export function coverage(tags: SystemTag[]): Array<[SystemTagCategory, number]> {
  return SYSTEM_TAG_CATEGORIES.map(
    (c) => [c, tags.filter((t) => t.category === c).length] as [SystemTagCategory, number],
  );
}

/**
 * 汇总用于派生系统标签的文本片段（SystemTagStore.tagFields 的纯函数部分）。
 * 只收集队列条目自身携带的文本：title / abstract / venue / why。
 * 已抽取实验字段与精读笔记的 frontmatter 由 Store 层追加（需要读盘，不属于本模块）。
 *
 * 保留此函数是为了让「Windows 版给 QueueEntry 派生标签」的入口与 macOS 一致：
 * 字段顺序影响 join 结果，进而影响跨字段边界的子串命中，因此顺序照抄 Swift。
 */
export function tagFields(paper: QueueEntry): string[] {
  const fields: string[] = [];
  if (paper.title) fields.push(paper.title);
  if (paper.abstract) fields.push(paper.abstract);
  if (paper.venue) fields.push(paper.venue);
  if (paper.why) fields.push(paper.why);
  return fields.filter((f) => f.length > 0);
}
