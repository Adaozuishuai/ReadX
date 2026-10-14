// 引用导出（PRD 4.13「引用导出」/ 8.3「支持导出个人 Library」）。
// 纯字符串函数：不依赖 UI，便于回归测试；NSSavePanel 只在外层包装。
//
// 移植纪律：本文件逐条对应早期 macOS（Swift）版 CitationExport.swift。
// 下面每个「为什么这么做」的注释都是从 Swift 版继承的硬约束，不要因为「看起来多余」而删掉。

import { QueueEntry } from './types';

/** BibTeX 转义：这些字符在 BibTeX 里有特殊含义，必须转义或加花括号保护。 */
export function bibtexEscaped(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\': out += '\\textbackslash{}'; break;
      case '&': out += '\\&'; break;
      case '%': out += '\\%'; break;
      case '$': out += '\\$'; break;
      case '#': out += '\\#'; break;
      case '_': out += '\\_'; break;
      case '{': out += '\\{'; break;
      case '}': out += '\\}'; break;
      case '~': out += '\\textasciitilde{}'; break;
      case '^': out += '\\textasciicircum{}'; break;
      default: out += ch;
    }
  }
  return out;
}

/** 引用键：优先 arXiv 号，其次 id，最后回退到标题。去掉 BibTeX 不允许的字符。 */
export function citationKey(paper: QueueEntry): string {
  const raw =
    paper.arxiv != null && paper.arxiv !== ''
      ? paper.arxiv
      : (paper.id ?? paper.title ?? 'paper');
  // Swift 的 CharacterSet.alphanumerics 是 Unicode 字母类 L* + 数字类 N*；
  // 允许保留 . : -（BibTeX 引用键的常用字符）。
  const cleaned = Array.from(raw)
    .filter((ch) => /[\p{L}\p{N}.:-]/u.test(ch))
    .join('');
  const key = cleaned === '' ? 'paper' : cleaned;
  // 只有「完全由数字组成」的键才有问题（部分工具会把它当数字处理）；
  // arXiv 号形如 2209.14540，含点号，是合法且惯用的引用键，不加前缀。
  // 历史上这里曾写成「数字开头就加前缀」，把 2209.14540 误改成 ref2209.14540，必须保持本行为。
  return /^\p{N}+$/u.test(key) ? 'ref' + key : key;
}

/** 「First Last」→「Last, First」；已是「Last, First」则原样返回。 */
export function bibtexAuthor(raw: string): string {
  const name = raw.trim();
  if (name === '') return '';
  if (name.includes(',')) return name;
  // Swift split(separator: " ") 只按单个空格切分，并丢弃空片段。
  const parts = name.split(' ').filter((p) => p !== '');
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return last + ', ' + first;
}

/** arXiv 发布的 `2026-09-30` / `2026-09` / `2026` 统一取年份。 */
export function year(paper: QueueEntry): string {
  for (const candidate of [paper.published, paper.year]) {
    if (candidate == null) continue;
    // 注意：Swift 是「先取前 4 个字符，再从中筛数字」，不是「取前 4 位数字」。
    // 因此 'ab2026' → 'ab20' → '20'，不足 4 位就继续看下一个候选。
    const digits = Array.from(candidate).slice(0, 4).filter((ch) => /^\p{N}$/u.test(ch));
    if (digits.length === 4) return digits.join('');
  }
  return '';
}

export function isArxiv(paper: QueueEntry): boolean {
  const a = paper.arxiv;
  if (a == null) return false;
  return a !== '';
}

/** 一条 @misc/@article。字段为空则整行不输出，避免生成 `author = {}` 这类脏数据。 */
export function bibtex(paper: QueueEntry): string {
  const fields: Array<[string, string]> = [];
  const authors = (paper.authors ?? []).map(bibtexAuthor).filter((a) => a !== '');
  if (authors.length > 0) fields.push(['author', authors.join(' and ')]);
  if (paper.title != null && paper.title !== '') fields.push(['title', '{' + bibtexEscaped(paper.title) + '}']);
  // venue 是 'arXiv' 时不输出 journal：arXiv 条目本身由 eprint/archivePrefix 表达，重复会生成脏条目。
  if (paper.venue != null && paper.venue !== '' && paper.venue !== 'arXiv') fields.push(['journal', bibtexEscaped(paper.venue)]);
  const y = year(paper);
  if (y !== '') fields.push(['year', y]);
  if (isArxiv(paper)) {
    fields.push(['eprint', paper.arxiv as string]);
    fields.push(['archivePrefix', 'arXiv']);
  }
  if (paper.doi != null && paper.doi !== '') fields.push(['doi', bibtexEscaped(paper.doi)]);
  if (paper.pdfUrl != null && paper.pdfUrl !== '') fields.push(['url', bibtexEscaped(paper.pdfUrl)]);

  const type = isArxiv(paper) ? 'misc' : 'article';
  const body = fields.map((f) => `  ${f[0]} = {${f[1]}}`).join(',\n');
  return `@${type}{${citationKey(paper)},\n${body}\n}`;
}

/** RIS 没有标题字段时退化为 `TY - GEN`（generic），避免输出空 TI。 */
export function ris(paper: QueueEntry): string {
  const lines: string[] = [];
  const hasTitle = paper.title != null && paper.title !== '';
  lines.push('TY  - ' + (isArxiv(paper) ? 'JOUR' : (hasTitle ? 'JOUR' : 'GEN')));
  for (const a of (paper.authors ?? []).map(bibtexAuthor).filter((x) => x !== '')) lines.push('AU  - ' + a);
  if (paper.title != null && paper.title !== '') lines.push('TI  - ' + paper.title);
  if (paper.venue != null && paper.venue !== '') lines.push('JO  - ' + paper.venue);
  const y = year(paper);
  if (y !== '') lines.push('PY  - ' + y);
  if (paper.doi != null && paper.doi !== '') lines.push('DO  - ' + paper.doi);
  if (isArxiv(paper)) {
    lines.push('AN  - arXiv:' + (paper.arxiv as string));
    lines.push('UR  - https://arxiv.org/abs/' + (paper.arxiv as string));
  } else if (paper.pdfUrl != null && paper.pdfUrl !== '') {
    lines.push('UR  - ' + paper.pdfUrl);
  }
  lines.push('ER  - ');
  return lines.join('\n');
}

/** 多条合并；空集合返回空串，由调用方决定提示。 */
export function bibtexAll(papers: QueueEntry[]): string {
  return papers.map(bibtex).filter((s) => s !== '').join('\n\n') + (papers.length === 0 ? '' : '\n');
}

export function risAll(papers: QueueEntry[]): string {
  return papers.map(ris).join('\n\n') + (papers.length === 0 ? '' : '\n');
}

/** 文件名：单篇用引用键，多篇用日期。 */
export function suggestedFilename(papers: QueueEntry[], ext: string, today: string): string {
  if (papers.length === 1) return citationKey(papers[0]) + '.' + ext;
  return `CBCT-citations-${today}.${ext}`;
}
