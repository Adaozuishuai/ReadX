// 论文身份识别、去重与推荐排序。与 Swift 版 PaperIdentity 语义一致。
//
// 去重必须索引化：Swift 版曾用 O(n²) 实现（每篇与全部保留项比较），
// 数百篇时首页渲染卡顿。这里保留索引版本，语义与 same() 完全一致。

import { PROFILE_KEYWORDS, LibraryState, QueueEntry, ResearchProfile } from './types';

const ARXIV_PREFIXES = [
  'https://arxiv.org/abs/', 'http://arxiv.org/abs/',
  'https://arxiv.org/pdf/', 'arxiv:',
];

export function arxivKey(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  for (const p of ARXIV_PREFIXES) if (s.startsWith(p)) s = s.slice(p.length);
  if (s.endsWith('.pdf')) s = s.slice(0, -4);
  // 内部空白会让 URL 构造失败（启动路径 id_list 查询曾因强解包崩溃），从键里剥掉
  return s.replace(/v[0-9]+$/, '').replace(/\s+/g, '');
}

export function doiKey(raw: string): string {
  return (raw ?? '').toLowerCase().trim()
    .replace('https://doi.org/', '').replace('doi:', '');
}

/** 标题归一：只保留字母数字（Unicode 感知）。 */
export function titleKey(raw: string): string {
  return (raw ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function entryKey(p: QueueEntry): string {
  if (p.arxiv && p.arxiv.length) return arxivKey(p.arxiv);
  return p.id ?? '';
}

export function sameEntry(a: QueueEntry, b: QueueEntry): boolean {
  if (entryKey(a) === entryKey(b)) return true;
  if (a.arxiv && b.arxiv && arxivKey(a.arxiv) === arxivKey(b.arxiv)) return true;
  if (a.doi && b.doi && doiKey(a.doi) === doiKey(b.doi)) return true;
  const t = titleKey(a.title ?? '');
  if (t.length > 20 && t === titleKey(b.title ?? '')) {
    const aa = new Set((a.authors ?? []).map(titleKey));
    const ba = new Set((b.authors ?? []).map(titleKey));
    return aa.size > 0 && ba.size > 0 && [...aa].some((x) => ba.has(x));
  }
  return false;
}

export function deduplicate(papers: QueueEntry[]): QueueEntry[] {
  const out: QueueEntry[] = [];
  const keyIndex = new Map<string, number>();
  const arxivIndex = new Map<string, number>();
  const doiIndex = new Map<string, number>();
  const titleIndex = new Map<string, number[]>();

  const reindex = (i: number): void => {
    const p = out[i];
    keyIndex.set(entryKey(p), i);
    if (p.arxiv) arxivIndex.set(p.arxiv, i);
    if (p.doi) doiIndex.set(p.doi, i);
  };

  for (const original of papers) {
    const p: QueueEntry = { ...original };
    if (!entryKey(p)) continue;
    if (p.arxiv) p.arxiv = arxivKey(p.arxiv);
    if (p.doi) p.doi = doiKey(p.doi);

    let match: number | undefined = keyIndex.get(entryKey(p));
    if (match === undefined && p.arxiv) match = arxivIndex.get(p.arxiv);
    if (match === undefined && p.doi) match = doiIndex.get(p.doi);
    if (match === undefined) {
      const t = titleKey(p.title ?? '');
      if (t.length > 20) {
        const candidates = titleIndex.get(t) ?? [];
        match = candidates.find((i) => {
          const aa = new Set((out[i].authors ?? []).map(titleKey));
          const ba = new Set((p.authors ?? []).map(titleKey));
          return [...aa].some((x) => ba.has(x));
        });
      }
    }

    if (match !== undefined) {
      // 合并时保留手工维护的元数据：已有值优先，缺失才补
      const m = out[match];
      m.doi = m.doi ?? p.doi;
      if (m.id == null) m.arxiv = m.arxiv ?? p.arxiv;
      m.abstract = m.abstract ?? p.abstract;
      m.pdfUrl = m.pdfUrl ?? p.pdfUrl;
      m.authors = m.authors ?? p.authors;
      m.published = m.published ?? p.published;
      m.source = m.source ?? p.source;
      reindex(match); // 补充的 arXiv/DOI 必须进索引，否则后续同论文会漏配
    } else {
      const t = titleKey(p.title ?? '');
      if (t.length > 20) {
        if (!titleIndex.has(t)) titleIndex.set(t, []);
        titleIndex.get(t)!.push(out.length);
      }
      out.push(p);
      reindex(out.length - 1);
    }
  }
  return out;
}

/** 兼容 `{ "papers": [...] }` 与新数组格式。 */
export function decodeQueue(data: unknown): QueueEntry[] {
  const entries = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as { papers?: unknown }).papers)
      ? (data as { papers: QueueEntry[] }).papers
      : []);
  return deduplicate(entries as QueueEntry[]);
}

export interface RankedPaper {
  paper: QueueEntry;
  score: number;
  reasons: string[];
}

/** 规则分数，不是模型置信度；负反馈按主题扣分。 */
export function rank(
  paper: QueueEntry,
  profile: ResearchProfile,
  state: LibraryState,
  negativeTopics: Record<string, number> = {},
): RankedPaper {
  const text = ((paper.title ?? '') + ' ' + (paper.abstract ?? '')).toLowerCase();
  let score = 10;
  let reasons: string[] = [];

  for (const topic of Object.keys(profile.topics).sort()) {
    const weight = profile.topics[topic] ?? 0;
    const kws = PROFILE_KEYWORDS[topic] ?? [];
    if (weight > 0 && kws.some((k) => text.includes(k))) {
      score += weight * 12 - (negativeTopics[topic] ?? 0) * 5;
      reasons.push(`匹配你关注的 ${topic}（权重 ${weight}）`);
    }
  }
  for (const term of profile.datasets.split(',').map((s) => s.trim())) {
    if (term && text.includes(term.toLowerCase())) { score += 8; reasons.push(`摘要提到你使用的数据集 ${term}`); }
  }
  for (const raw of profile.methods.split(/[,，;；]/)) {
    const method = raw.trim();
    const alias = method.toLowerCase().includes('implicit')
      ? [method.toLowerCase(), 'implicit', 'neural field', 'attenuation field']
      : [method.toLowerCase()];
    if (method.length > 2 && alias.some((a) => text.includes(a))) {
      score += 8; reasons.push(`匹配你的技术偏好 ${method}`);
    }
  }
  const tasks: Array<[string, string[]]> = [
    ['投影补全', ['projection completion', 'sinogram completion']],
    ['体重建', ['reconstruction']],
    ['双域', ['dual-domain', 'dual domain']],
    ['去伪影', ['artifact', 'artefact']],
    ['测试时适配', ['test-time', 'test time']],
  ];
  for (const [label, words] of tasks) {
    if (profile.task.includes(label) && words.some((w) => text.includes(w))) {
      score += 4; reasons.push(`与你的「${label}」任务相关，具体设置需回原文核对`);
    }
  }
  if (state.favorite) score += 12;
  score += state.relevance * 40;
  if (state.status === 'read') score -= 30;
  if (state.status === 'ignored') score -= 100;
  if (!reasons.length) reasons = ['领域探索：与 CBCT/CT 重建相关；尚未匹配你的主题，建议先核对摘要'];

  return { paper, score: Math.max(0, Math.min(100, score)), reasons: reasons.slice(0, 3) };
}

export function matchesProfile(r: RankedPaper): boolean {
  return r.reasons.some((x) => x.startsWith('匹配你') || x.startsWith('摘要提到你') || x.startsWith('与你'));
}

/** 合并首见日期：已有记录保持不变，新论文记录为当天。 */
export function mergedFirstSeen(
  existing: Record<string, string>, papers: QueueEntry[], day: string,
): Record<string, string> {
  const seen: Record<string, string> = { ...existing };
  for (const p of papers) {
    const k = entryKey(p);
    if (seen[k] === undefined) seen[k] = day;
  }
  return seen;
}
