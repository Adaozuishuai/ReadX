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
//
// 移植自早期 macOS（Swift）版 TrendAnalysis.swift；本文件只依赖 ./types（纯逻辑）。

import { QueueEntry } from './types';
import { SystemTag } from './systemTags';

export interface TrendSample {
  /** 参与统计的论文（顺序无关）。 */
  papers: QueueEntry[];
  /** 时间窗口。PRD 要求可展示，所以窗口本身是一等公民而非隐含前提。 */
  windowStart: string | null;
  windowEnd: string | null;
}

export function sampleCount(sample: TrendSample): number {
  return sample.papers.length;
}

export function isWindowBounded(sample: TrendSample): boolean {
  return sample.windowStart !== null && sample.windowEnd !== null;
}

export interface TrendEvidence {
  tag: SystemTag;
  papers: QueueEntry[];
}

export function evidenceCount(evidence: TrendEvidence): number {
  return evidence.papers.length;
}

/** 一条趋势结论。`claim` 与 `caveat` 分离，UI 必须同时展示，避免只看到结论。 */
export interface TrendFinding {
  topic: string;
  count: number;
  sample: TrendSample;
  evidence: TrendEvidence[];
  /** 是否达到可下判断的最小样本量。 */
  isSupported: boolean;
  claim: string;
  caveat: string;
}

/**
 * 给 UI 用的完整描述：时间窗 + 样本数 + 证据集合，三样缺一不可。
 * 这是 PRD 硬约束 1/2/3 的落点——缺任何一样都说明结论没有被正确披露。
 */
export function disclosure(finding: TrendFinding): string {
  const window = isWindowBounded(finding.sample)
    ? `${finding.sample.windowStart} ~ ${finding.sample.windowEnd}`
    : '时间窗口未知';
  return `时间窗口：${window} · 样本数：${finding.count} 篇 · 证据：`
    + finding.evidence.map((e) => `${e.tag.value}(${e.papers.length})`).join('、');
}

/**
 * 低于该样本量不下趋势判断。PRD 风险表点名「样本少导致伪趋势」，
 * 这里取 5 作为保守下限：少于 5 篇只能报告计数，不能声称「升温/新兴」。
 */
export const minimumSample = 5;

/**
 * 从论文集合里提取时间窗口（按 published/year 的年份）。
 *
 * 与 Swift 一致的两条细节，改动会直接改变披露结果：
 *   1. 取 `published` 前缀 4 个字符里**所有的数字字符**，恰好凑满 4 位才采用；
 *      '2026-09-30' -> '2026'；'2026-09' -> '2026'；'2026' -> '2026'；
 *      但 Swift 是在 prefix(4) 之后过滤数字，所以 '26-09-30' 的前 4 字符 '26-0' 只得到 3 位数字 -> 丢弃。
 *   2. `published` 缺失或不合格时回退到 `year`；两者都不合格则该论文年份未知（不编造）。
 */
export function window(papers: QueueEntry[]): [string | null, string | null] {
  const years: string[] = [];
  for (const p of papers) {
    for (const candidate of [p.published, p.year]) {
      if (candidate == null) continue;
      // Swift: c.prefix(4).filter(\.isNumber)，Character.isNumber 对应 \p{N}。
      const d = [...candidate].slice(0, 4).filter((ch) => /\p{N}/u.test(ch)).join('');
      if (d.length === 4) { years.push(d); break; }
    }
  }
  if (!years.length) return [null, null];
  // 与 Swift 的 String min()/max() 同为字典序；年份是等长数字串，语义一致。
  let lo = years[0];
  let hi = years[0];
  for (const y of years) {
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return [lo, hi];
}

export function sample(papers: QueueEntry[]): TrendSample {
  const [lo, hi] = window(papers);
  return { papers, windowStart: lo, windowEnd: hi };
}

/**
 * 按系统标签聚合，产出带完整披露信息的趋势条目。
 * - Parameter papers: 参与统计的集合（通常是 savedPapers）
 * - Parameter tags: 论文 -> 系统标签的派生函数（注入以保持本模块不依赖具体匹配实现）
 *
 * 排序：count 降序，同 count 按 topic 升序（与 Swift 的 sorted 闭包一致）。
 */
export function findings(
  papers: QueueEntry[],
  tags: (paper: QueueEntry) => SystemTag[],
): TrendFinding[] {
  const smp = sample(papers);
  const groups = new Map<string, { tag: SystemTag; members: QueueEntry[] }>();
  for (const paper of papers) {
    for (const tag of tags(paper)) {
      const id = tag.category + '|' + tag.value;
      const group = groups.get(id);
      if (group) group.members.push(paper);
      else groups.set(id, { tag, members: [paper] });
    }
  }
  const out: TrendFinding[] = [];
  for (const { tag, members } of groups.values()) {
    const supported = members.length >= minimumSample;
    const claim = supported
      ? `${members.length} 篇论文涉及 ${tag.value}`
      : `${members.length} 篇论文涉及 ${tag.value}（样本不足，不下趋势判断）`;
    out.push({
      topic: tag.value,
      count: members.length,
      sample: smp,
      evidence: [{ tag, papers: members }],
      isSupported: supported,
      claim,
      caveat: supported
        ? `仅为计数与证据集合，不代表该方向「升温」或「首次」；时间窗口 ${smp.windowStart ?? '?'}–${smp.windowEnd ?? '?'} 内共 ${smp.papers.length} 篇。`
        : `样本数 ${members.length} < ${minimumSample}：不下趋势判断，只报告计数与证据集合；请扩大检索范围后重试。`,
    });
  }
  return out.sort((a, b) => (a.count === b.count ? (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0) : b.count - a.count));
}

/** Research Gap 只能表述为「检索范围内未见」，不得表述为「无人做过 / 首次」。 */
export function gapStatement(topic: string, smp: TrendSample): string {
  const windowText = isWindowBounded(smp)
    ? `${smp.windowStart}–${smp.windowEnd}`
    : '当前';
  return `在 ${windowText} 的 ${smp.papers.length} 篇检索范围内，未发现针对「${topic}」的直接工作。`
    + '这是检索范围内的缺口，不等于该方向无人研究，也不构成「首次」声明。';
}

/** 禁止出现的措辞（PRD 红线：不能声称首次）。 */
export const forbiddenPhrases = ['首次', '首个', 'first to', 'no one has', '无人研究过', '前所未有的'];

/**
 * 否定前缀：出现在禁用语之前时，该处属于「声明不构成首次」，不算违规。
 * 例：'不构成「首次」声明' 是否定用法，应放行；'这是首次提出' 才是违规。
 */
export const negationMarkers = ['不构成', '不代表', '不是', '不等于', '并非', '不得', '不能', '禁止', '无「', '不存在', 'no claim of', 'not the first'];

/**
 * 输出前自检：命中红线措辞即视为不合规。
 * 需要跳过否定语境，否则「不构成首次声明」这种合规表述会被误判。
 *
 * 保真要点：只看禁用语**之前最多 12 个字符**的窗口，窗口内出现任一否定标记即放行；
 * 窗口按 UTF-16 code unit 截断（与 Swift `index(offsetBy: -12)` 的 Character 语义在
 * 纯 ASCII / 常见中文混排下一致；两者都以「字符」为单位，本实现用 code point 展开后切片）。
 * 同一禁用语在文本里出现多次时逐个判断，只要有一个在非否定语境里出现就算违规。
 */
export function violatesRedline(text: string): boolean {
  const lower = text.toLowerCase();
  // 先按 code point 展开，保证 -12 是 12 个字符而不是 12 个 UTF-16 code unit。
  const chars = [...lower];
  for (const phrase of forbiddenPhrases) {
    const needle = phrase.toLowerCase();
    const needleChars = [...needle];
    let from = 0;
    for (;;) {
      const at = findChars(chars, needleChars, from);
      if (at < 0) break;
      const windowStart = Math.max(0, at - 12);
      const prefix = chars.slice(windowStart, at).join('');
      if (!negationMarkers.some((m) => prefix.includes(m.toLowerCase()))) return true;
      from = at + needleChars.length;
    }
  }
  return false;
}

/** 在 code point 数组里从 from 开始查找子序列，返回下标或 -1。 */
function findChars(haystack: string[], needle: string[], from: number): number {
  if (!needle.length) return from;
  const last = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}
