export interface PaperHeading {
  title: string;
  page: number;
  depth: number;
  y?: number;
}
export interface HeadingLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Infer section headings when a PDF has no bookmarks, or only a title bookmark. */
export function detectPaperHeadings(lines: HeadingLine[], page: number, pageHeight: number): PaperHeading[] {
  const heights = lines.filter((line) => line.text.trim().length > 50).map((line) => line.height).sort((a, b) => a - b);
  const body = heights[Math.floor(heights.length / 2)] ?? 10;
  const known = /^(abstract|introduction|background|related work|materials?(?: and methods)?|methods?|methodology|proposed (?:method|approach)|experiments?(?: and results)?|results?(?: and discussion)?|discussion|conclusions?|limitations?|acknowledg(?:e)?ments?|references|bibliography|appendix(?: [A-Z])?|supplementary(?: material)?|摘要|引言|绪论|相关工作|方法|实验(?:结果)?|讨论|结论|参考文献|附录)$/i;
  const found: PaperHeading[] = [];
  for (const line of lines) {
    const title = line.text.replace(/\s+/g, ' ').trim();
    if (title.length < 3 || title.length > 130 || line.y < pageHeight * 0.045 || line.y > pageHeight * 0.96) continue;
    if (/\bet\s+al\.?/i.test(title) || (title.match(/[\p{L}]/gu)?.length ?? 0) < 3) continue;
    if (/^(?:fig(?:ure)?\.?|table|eq(?:uation)?\.?)\s*\d/i.test(title) || /[=∑∫≥≤±×÷∂∇{}\[\]]/u.test(title)) continue;
    const number = title.match(/^(\d+(?:\.\d+)*|[IVXLCDM]+)[.)]?\s+(.+)$/);
    const letter = title.match(/^[A-Z][.)]\s+(.+)$/);
    const name = number?.[2] ?? letter?.[1] ?? title;
    const naturalTitle = /^[A-Z\u4e00-\u9fff]/u.test(name) && (/[A-Za-z]{3,}/.test(name) || /[\u4e00-\u9fff]{2}/u.test(name));
    const short = name.split(/\s+/).length <= 14 && !/[;,!?。；，]$/.test(name) && !/[.!?]\s+[A-Z]/.test(name);
    const numbered = !!number && naturalTitle && short && !/[.:]$/.test(name) && line.height >= body * 0.85;
    const styled = naturalTitle && name.split(/\s+/).length >= 2 && !/[;,:]/.test(name) && line.height >= body * 1.18 && line.height <= body * 1.7 && short && title.length < 90 && (page > 1 || line.y > pageHeight * 0.28);
    const named = known.test(name) && /^[A-Z\u4e00-\u9fff]/u.test(name) && line.height >= body * 0.9;
    if (!named && !numbered && !(letter && naturalTitle && short && !/[.:]$/.test(name) && line.height >= body * 0.85) && !styled) continue;
    found.push({ title, page, y: Math.max(0, Math.min(1, line.y / pageHeight)), depth: number ? (number[1]!.match(/\./g)?.length ?? 0) : letter ? 1 : 0 });
  }
  return found;
}

export function mergePaperHeadings(bookmarks: PaperHeading[], inferred: PaperHeading[]): PaperHeading[] {
  const entries = new Map<string, PaperHeading>();
  const identity = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const bookmarkTitles = new Set(bookmarks.map((entry) => identity(entry.title)));
  // A real hierarchical outline is authoritative. Inference adds exact anchors;
  // title-only or absent outlines need inferred sections as well.
  const additions = bookmarks.length >= 3 ? inferred.filter((entry) => bookmarkTitles.has(identity(entry.title))) : inferred;
  for (const entry of [...bookmarks, ...additions]) {
    const key = identity(entry.title);
    const previous = entries.get(key);
    if (!previous) entries.set(key, entry);
    else if (previous.page === entry.page && previous.y === undefined && entry.y !== undefined) entries.set(key, { ...previous, y: entry.y });
  }
  const trusted = new Set(bookmarks.map((entry) => entry.title));
  let references = false;
  return [...entries.values()].sort((a, b) => a.page - b.page || (a.y ?? 0) - (b.y ?? 0)).filter((entry) => {
    if (/^(?:\d+[. ]+)?(?:references|bibliography|参考文献)$/i.test(entry.title)) { references = true; return true; }
    if (/^(?:appendix|supplementary|附录)/i.test(entry.title) || trusted.has(entry.title)) { references = false; return true; }
    return !references;
  });
}
