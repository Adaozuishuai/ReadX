/**
 * 阅读器查找的纯匹配逻辑。
 *
 * 关键约束：**整本扫描**（pdf.js 的 item 串）与**页内高亮**（文本层 DOM 里的文本节点）
 * 必须用同一套拼接规则，否则「命中计数」会和实际能高亮出来的位置对不上。
 * pdf.js 的 item 之间没有真实空格字符，所以两侧统一按「一段文本之间补一个空格」拼接，
 * 再连续空白归一成一个空格；分词只发生在空白上，标点保持原样。
 */

export interface MatchRange {
  start: number;
  end: number;
}

/** 连续空白归一成一个空格：与页内文本节点「用空格拼接」的规则保持一致。 */
export function normalizeFindText(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * Normalize whitespace while retaining the source span for each UTF-16 code
 * unit. PDF text-layer highlights use these offsets to map matches back to
 * their original text nodes.
 */
export function normalizeFindTextWithOffsets(text: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    const width = char.length;
    if (/\s/.test(char)) {
      const start = index;
      let end = index + width;
      while (end < text.length) {
        const next = String.fromCodePoint(text.codePointAt(end)!);
        if (!/\s/.test(next)) break;
        end += next.length;
      }
      normalized += ' ';
      starts.push(start);
      ends.push(end);
      index = end;
      continue;
    }
    normalized += char;
    for (let offset = 0; offset < width; offset++) {
      starts.push(index + offset);
      ends.push(index + offset + 1);
    }
    index += width;
  }
  return { text: normalized, starts, ends };
}

/**
 * 在 text 中找出 query 的全部出现位置（可重叠的重复串不算，按顺序不回溯）。
 *
 * 不区分大小写时先折叠再匹配；折叠会改变长度的罕见字符（如 'İ'）会让偏移错位，
 * 这时退回区分大小写的匹配，宁可漏配也不能标错位置。
 */
export function findMatchRanges(
  text: string,
  query: string,
  caseSensitive: boolean,
): MatchRange[] {
  const needle = normalizeFindText(query).trim();
  if (!needle) return [];
  const haystack = normalizeFindText(text);
  if (!haystack) return [];

  let source = haystack;
  let target = needle;
  if (!caseSensitive) {
    const foldedSource = haystack.toLocaleLowerCase();
    const foldedTarget = needle.toLocaleLowerCase();
    if (foldedSource.length === haystack.length) {
      source = foldedSource;
      target = foldedTarget;
    }
  }

  const ranges: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const index = source.indexOf(target, from);
    if (index < 0) break;
    ranges.push({ start: index, end: index + target.length });
    from = index + target.length;
  }
  return ranges;
}
