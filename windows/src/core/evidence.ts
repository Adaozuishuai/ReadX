// Evidence：evidence-first 校验链。这是全项目可信度的根，移植必须逐条保真。
//
// 移植纪律：这里每一个「刻意不做 X」的注释都是从 Swift 版继承的硬约束，
// 改动前请先读 native/Tests/CBCTReadingTests/ResearchTests.swift 里对应的回归用例。

import { ExperimentExtraction, ExperimentField } from './types';

export interface EvidencePage {
  number: number;
  text: string;
}

const PAGE_MARKER = /=== Page ([0-9]+) ===/g;


export function pages(text: string): EvidencePage[] {
  const out: EvidencePage[] = [];
  const marks: Array<{ num: number; start: number; end: number }> = [];
  PAGE_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGE_MARKER.exec(text)) !== null) {
    marks.push({ num: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out.push({ number: marks[i].num, text: text.slice(marks[i].end, end) });
  }
  return out;
}

export function citations(text: string): number[] {
  const re = /Page\s+(\d+)/gi;
  const found = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

/** 把 Page N 变成可点击的 cbct-evidence:// 链接；已是链接形态的不重复包装。 */
export function linked(text: string): string {
  return text.replace(
    /Page\s+(\d+)/gi,
    (full, n, offset: number) => {
      const before = text[offset - 1];
      if (before === '[') return full;
      const after = text.slice(offset + full.length);
      if (/^[0-9\]]/.test(after)) return full;
      return `[Page ${n}](cbct-evidence://page/${n})`;
    },
  );
}

/** 归一化：用于「摘录是否真的出现在该页」的比对。 */
export function normalized(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    // 连字符跨行：去掉 "- \n" 这种断词
    .replace(/(?<=\p{L})-[ \t]*\n[ \t]*(?=\p{L})/gu, '')
    .replace(/−/g, '-')
    // 单词中间的连字符也去掉（Bag-of-words -> bagofwords 语义一致）
    .replace(/(?<=\p{L}{2})-(?=\p{L}{2})/gu, '')
    .replace(/\s+/g, '');
}

const SPELLED: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10', single: '1',
};

/**
 * 抽出文本里的「测量数字」，用于「抽取值是否被摘录支持」的校验。
 *
 * 关键取舍（从 Swift 版继承）：只排除**完全嵌在单词中间**的数字。
 * 方法名 IntraTomo3D 里的 3 必须被排除，否则伪造值只要等于方法名里的数字就能通过校验；
 * 但 RTX3090 / 1.2GB 这类贴在单词边上的型号数字必须保留，它们是论文真报的事实。
 */
export function numbers(text: string): Set<string> {
  let s = text.normalize('NFKC').toLowerCase().replace(/−/g, '-').replace(/–/g, '-');
  for (const [word, value] of Object.entries(SPELLED)) {
    s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), value);
  }
  const out = new Set<string>();
  const re = /[+-]?(?:[0-9]*\.[0-9]+|[0-9]+)/g;
  let m: RegExpExecArray | null;
  const isLetter = (i: number): boolean => {
    if (i < 0 || i >= s.length) return false;
    return /\p{L}/u.test(s[i]);
  };
  while ((m = re.exec(s)) !== null) {
    if (isLetter(m.index - 1) && isLetter(m.index + m[0].length)) continue;
    out.add(m[0]);
  }
  return out;
}

export interface SelectResult {
  text: string;
  included: number;
  total: number;
}

export function scopedPages(text: string, scope: string): EvidencePage[] {
  if (scope === 'Figure') {
    const out: EvidencePage[] = [];
    for (const page of pages(text)) {
      const lines = page.text.split('\n');
      const captions: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(fig\.?|figure)\s*[0-9]+/i.test(lines[i])) {
          captions.push(...lines.slice(i, Math.min(lines.length, i + 5)));
        }
      }
      if (captions.length) out.push({ number: page.number, text: captions.join('\n') });
    }
    return out;
  }
  let active = false;
  const out: EvidencePage[] = [];
  for (const page of pages(text)) {
    const lines: string[] = [];
    for (const line of page.text.split('\n')) {
      const heading = line.trim().toLowerCase();
      const major = /^([0-9]+[. ]+|[a-z][. ]+)?(introduction|related work|background|method|methods|methodology|approach|experiment|experiments|experimental|results|discussion|conclusion|references|bibliography|appendix|supplementary)\b/.test(heading);
      if (major) {
        // References 对任何 scope 都强制关闭：否则 Method/Experiment 会把参考文献整段吸进证据范围。
        if (/^(references|bibliography|[0-9]+[. ]+references)\b/.test(heading)) {
          active = false;
          continue;
        }
        if (scope === 'Method') active = heading.includes('method') || heading.includes('approach');
        else if (scope === 'Experiment') active = heading.includes('experiment') || heading.includes('results');
        else if (scope === 'Appendix') active = heading.includes('appendix') || heading.includes('supplementary');
        else active = false;
      }
      if (active) lines.push(line);
    }
    if (lines.length) out.push({ number: page.number, text: lines.join('\n') });
  }
  return out;
}

/** 返回选中内容与页数覆盖情况；included < total 时调用方必须向模型披露材料为子集（PRD 12.1）。 */
export function selectWithMeta(
  text: string, query: string, scope = '全文', limit = 50000,
): SelectResult {
  const all = scope === '全文' ? pages(text) : scopedPages(text, scope);
  if (!all.length) return { text: '', included: 0, total: 0 };
  if (text.length <= limit && scope === '全文') return { text, included: all.length, total: all.length };

  const scopeTerms: Record<string, string> = {
    Method: 'method architecture equation geometry',
    Experiment: 'experiment dataset training results',
    Appendix: 'appendix supplementary',
    Figure: 'figure fig caption',
  };
  const terms = (query + ' ' + (scopeTerms[scope] ?? ''))
    .toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

  const scored = all.map((p) => {
    const low = p.text.toLowerCase();
    let score = 0;
    for (const t of terms) if (low.includes(t)) score++;
    return { page: p, score };
  }).sort((a, b) => (a.score === b.score ? a.page.number - b.page.number : b.score - a.score));

  const picked: EvidencePage[] = [];
  let used = 0;
  for (const { page } of scored) {
    if (used + page.text.length + 30 > limit) continue;
    picked.push(page);
    used += page.text.length + 30;
  }
  const body = picked.sort((a, b) => a.number - b.number)
    .map((p) => `=== Page ${p.number} ===\n${p.text}`).join('\n\n');
  return { text: body, included: picked.length, total: all.length };
}

export function select(text: string, query: string, scope = '全文', limit = 50000): string {
  return selectWithMeta(text, query, scope, limit).text;
}

/** included < total 时在材料前加范围披露；披露行在第一个页标记之前，不影响页码解析。 */
export function scopingNote(r: SelectResult): string {
  if (!r.text || r.included >= r.total) return r.text;
  const nums = pages(r.text).map((p) => String(p.number)).join('、');
  return `【材料范围】以下仅包含按相关性从全文中选取的 ${r.included}/${r.total} 页（页码：${nums}）。未包含的页面同样属于论文：涉及这些页面的信息应回答「论文中未找到（当前证据未覆盖，可扩大范围重试）」，不得仅凭本子集断言论文没有该内容。\n\n` + r.text;
}

/** 输出必须引用真实存在的页码，否则拒绝保存。 */
export function validateEvidence(output: string, source: string): void {
  const refs = citations(output);
  const available = new Set(pages(source).map((p) => p.number));
  if (!refs.length || !refs.every((r) => available.has(r))) {
    throw new Error('输出缺少有效证据页码，未保存。请重试或核对原文。');
  }
}

/**
 * 在指定页里找一段可与 quote 匹配的原文片段（诊断用：无效摘录仍然是无效的，
 * 只是提示模型可以按本页真实文字重填）。
 */
export function matchingQuoteFragment(quote: string, inText: string): string | null {
  const needle = normalized(quote);
  const haystack = normalized(inText);
  if (needle.length < 8) return null;
  for (let size = Math.min(needle.length, 700); size >= 8; size--) {
    for (const frag of [needle.slice(0, size), needle.slice(-size)]) {
      if (haystack.includes(frag)) {
        const r = quoteRange(frag, inText);
        if (r) return inText.slice(r.start, r.end);
      }
    }
  }
  return null;
}

export interface QuoteRange { start: number; end: number }

/** 把归一化后的匹配位置映射回原文区间（用于高亮）。 */
export function quoteRange(quote: string, inText: string): QuoteRange | null {
  const needle = normalized(quote);
  if (needle.length < 8) return null;

  const lineHyphenRe = /(?<=\p{L})-[ \t]*\n[ \t]*(?=\p{L})/gu;
  const hyphenPositions = new Set<number>();
  let hm: RegExpExecArray | null;
  while ((hm = lineHyphenRe.exec(inText)) !== null) hyphenPositions.add(hm.index);

  const chars: string[] = [];
  const ranges: QuoteRange[] = [];
  let i = 0;
  for (const ch of inText) {
    const len = ch.length;
    if (!hyphenPositions.has(i)) {
      for (const c of ch.normalize('NFKC').toLowerCase().replace(/−/g, '-')) {
        if (!/\s/.test(c)) { chars.push(c); ranges.push({ start: i, end: i + len }); }
      }
    }
    i += len;
  }

  // 去掉单词中间的连字符（与 normalized 一致），避免映射错位
  const keep: number[] = [];
  for (let k = 0; k < chars.length; k++) {
    const insideWord = chars[k] === '-' && k >= 2 && k + 2 < chars.length &&
      /\p{L}/u.test(chars[k - 1]) && /\p{L}/u.test(chars[k - 2]) &&
      /\p{L}/u.test(chars[k + 1]) && /\p{L}/u.test(chars[k + 2]);
    if (!insideWord) keep.push(k);
  }

  const canonical = keep.map((k) => chars[k]).join('');
  const pos = canonical.indexOf(needle);
  if (pos < 0) return null;
  const startRange = ranges[keep[pos]];
  const endRange = ranges[keep[pos + needle.length - 1]];
  return { start: startRange.start, end: endRange.end };
}

/**
 * 实验「配置」章节的额外约束：配置章只放配置，不能混入结果数值。
 * 移植自 Swift ExperimentExtraction.validateConfiguration()（并发新增，需与本文件其它校验一起维护）。
 */
export function validateConfiguration(x: ExperimentExtraction): void {
  const problems: string[] = [];
  if (x.results.length) problems.push('实验配置不能混入结果数值，results 应为空数组。');
  for (const field of x.training) {
    if (/(?:训练.*(?:时长|耗时|时间))|(?:training.*(?:time|duration))/i.test(field.k)) {
      const quote = field.excerpt ?? '';
      if (/reconstruct/i.test(quote) && !/(?:train|optimi|updat)/i.test(quote)) {
        problems.push(`「${field.k}」的原文只报告重建耗时，不能标为训练时长；放在对应结果图的解读中。`);
      }
    }
  }
  for (const field of x.loss) {
    if (/(?:公式|equation|formula)/i.test(field.k)) {
      problems.push(`「${field.k}」应在方法对应模块中介绍，本章仅列损失类型与权重。`);
    }
  }
  if (problems.length) throw new Error(problems.join('；'));
}

export function groupsOf(x: ExperimentExtraction): Array<[string, string, ExperimentField[]]> {
  return [
    ['dataset', '数据集', x.dataset],
    ['acquisition', '采集与几何', x.acquisition],
    ['training', '训练', x.training],
    ['loss', '损失', x.loss],
    ['baselines', '对比基线', x.baselines ?? []],
    ['metrics', '评价指标', x.metrics],
    ['results', '结果', x.results],
  ];
}

const UNKNOWN_VALUES = ['论文未说明', '论文中未说明', '论文中未找到', '未报告'];

/** 每个字段必须有页码 + 能出现在该页的逐字摘录，且字段里的数字要被摘录支持。 */
export function validateExtraction(x: ExperimentExtraction, source: string): void {
  const byPage = new Map<number, string>();
  for (const p of pages(source)) byPage.set(p.number, p.text);

  const fields = groupsOf(x).flatMap(([, , f]) => f);
  if (!fields.length) throw new Error('实验抽取没有返回字段，请重试。');

  const problems: string[] = [];
  for (const field of fields) {
    if (UNKNOWN_VALUES.includes(field.v) && (field.page == null) && (field.excerpt == null)) continue;
    const page = field.page ?? undefined;
    const pageText = page != null ? byPage.get(page) : undefined;
    const quote = field.excerpt ?? '';
    const ok = page != null && pageText !== undefined && quote &&
      normalized(quote).length >= 8 && normalized(pageText).includes(normalized(quote));
    if (!ok) {
      let diagnostic = `「${field.k}」缺少对应页的逐字摘录；引用单页不可拼接跨页文字`;
      if (page != null && pageText !== undefined && quote) {
        const fragment = matchingQuoteFragment(quote, pageText);
        if (fragment) {
          diagnostic += `。Page ${page} 内可匹配的原文片段：${fragment}；仅用本页片段支持的事实重新填写 v/excerpt，不能沿用片段未支持的数字或其他事实`;
        }
      }
      problems.push(diagnostic);
      continue;
    }
    const unsupported = [...numbers(field.v)].filter((n) => !numbers(quote).has(n));
    if (unsupported.length) {
      problems.push(`「${field.k}：${field.v.slice(0, 100)}」的数字 ${unsupported.sort().join(', ')} 未被所附摘录支持`);
    }
  }
  if (problems.length) throw new Error('证据校验未通过，未保存：' + problems.join('；'));
}
