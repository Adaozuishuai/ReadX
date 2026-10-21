export interface PaperHeading {
  title: string;
  page: number;
  depth: number;
  /** Horizontal page position in 0..1; used to keep two-column reading order. */
  x?: number;
  y?: number;
  /** Numeric section path, e.g. 3.2 => [3, 2]. */
  sectionPath?: number[];
}
export interface HeadingLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const superscriptDigits: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

function cleanHeadingTitle(value: string): string {
  return value
    .replace(/\$\s*\^\s*\{\s*(\d+)\s*\}\s*\$|\^\s*\{\s*(\d+)\s*\}/g, (_match, latexDigits: string | undefined, digits: string | undefined) =>
      [...(latexDigits ?? digits ?? '')].map((digit) => superscriptDigits[digit] ?? digit).join(''))
    .replace(/\s+([:;,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Infer section headings when a PDF has no bookmarks, or only a title bookmark. */
export function detectPaperHeadings(lines: HeadingLine[], page: number, pageHeight: number): PaperHeading[] {
  const heights = lines.filter((line) => line.text.trim().length > 50).map((line) => line.height).sort((a, b) => a - b);
  const body = heights[Math.floor(heights.length / 2)] ?? 10;
  const known = /^(abstract|introduction|background|related work|materials?(?: and methods)?|methods?|methodology|proposed (?:method|approach)|experiments?(?: and results)?|results?(?: and discussion)?|discussion|conclusions?|limitations?|acknowledg(?:e)?ments?|references|bibliography|appendix(?: [A-Z])?|supplementary(?: material)?|摘要|引言|绪论|相关工作|方法|实验(?:结果)?|讨论|结论|参考文献|附录)$/i;
  const found: PaperHeading[] = [];
  for (const line of lines) {
    const title = cleanHeadingTitle(line.text);
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
    found.push({ title, page, x: line.x, y: Math.max(0, Math.min(1, line.y / pageHeight)), sectionPath: number && /^\d/.test(number[1]!) ? number[1]!.split('.').map(Number) : undefined, depth: number ? (number[1]!.match(/\./g)?.length ?? 0) : letter ? 1 : 0 });
  }
  return found;
}

export function mergePaperHeadings(bookmarks: PaperHeading[], inferred: PaperHeading[]): PaperHeading[] {
  const entries = new Map<string, PaperHeading>();
  const identity = (title: string) => cleanHeadingTitle(title).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const matchIdentity = (title: string) => identity(cleanHeadingTitle(title).replace(/^(?:\d+(?:\.\d+)*|[IVXLCDM]+|[A-Z])[.)]?\s+/i, ''));
  const bookmarkTitles = new Set(bookmarks.flatMap((entry) => [identity(entry.title), matchIdentity(entry.title)]));
  // A real hierarchical outline is authoritative. Inference adds exact anchors;
  // title-only or absent outlines need inferred sections as well.
  const additions = bookmarks.length >= 3 ? inferred.filter((entry) => bookmarkTitles.has(identity(entry.title)) || bookmarkTitles.has(matchIdentity(entry.title))) : inferred;
  for (const rawEntry of [...bookmarks, ...additions]) {
    const entry = { ...rawEntry, title: cleanHeadingTitle(rawEntry.title) };
    let key = identity(entry.title);
    let previous = entries.get(key);
    if (!previous) {
      const matching = [...entries.entries()].find(([, candidate]) => candidate.page === entry.page && matchIdentity(candidate.title) === matchIdentity(entry.title));
      if (matching) [key, previous] = matching;
    }
    if (!previous) entries.set(key, entry);
    else if (previous.page === entry.page && (previous.y === undefined && entry.y !== undefined || previous.x === undefined && entry.x !== undefined || previous.sectionPath === undefined && entry.sectionPath !== undefined)) entries.set(key, {
      ...previous,
      x: previous.x ?? entry.x,
      y: previous.y ?? entry.y,
      sectionPath: previous.sectionPath ?? entry.sectionPath,
    });
  }
  const trusted = new Set(bookmarks.map((entry) => cleanHeadingTitle(entry.title)));
  let references = false;
  const ordered = [...entries.values()].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.sectionPath && b.sectionPath) {
      for (let i = 0; i < Math.min(a.sectionPath.length, b.sectionPath.length); i++) {
        const order = a.sectionPath[i]! - b.sectionPath[i]!;
        if (order) return order;
      }
      if (a.sectionPath.length !== b.sectionPath.length) return a.sectionPath.length - b.sectionPath.length;
    }
    return a.x !== undefined && b.x !== undefined
      ? a.x - b.x || (a.y ?? 0) - (b.y ?? 0)
      : (a.y ?? 0) - (b.y ?? 0);
  });
  return ordered.filter((entry) => {
    if (/^(?:\d+[. ]+)?(?:references|bibliography|参考文献)$/i.test(entry.title)) { references = true; return true; }
    if (/^(?:appendix|supplementary|附录)/i.test(entry.title) || trusted.has(entry.title)) { references = false; return true; }
    return !references;
  });
}
