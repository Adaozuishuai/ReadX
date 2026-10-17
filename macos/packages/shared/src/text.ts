/**
 * 正文重排（从旧版 windows/src/renderer/app.ts 的 reflowPaperText 移植，行为保持一致）。
 *
 * PDF 文本层是「一行一个换行」，直接渲染会出现半行断点、无法两端对齐。
 * 这里把同一段的续行合并成流式段落；结构性行（标题、列表、表格、公式、页标记）
 * 一律不参与合并，否则会破坏 Markdown 结构与页码定位。
 */

/** 结构性行：不能被并入上一行。 */
export function isStructuralLine(line: string): boolean {
  return (
    line.trim() === '' ||
    /^#{1,6}\s/.test(line) ||
    /^[-*•]\s/.test(line) ||
    /^\d+[.)]\s/.test(line) ||
    line.startsWith('|') ||
    line.startsWith('>') ||
    line.startsWith('$$') ||
    /^=== Page /.test(line)
  );
}

/** CJK（含日文假名与扩展 A 区）：中文排版里相邻字符之间不插空格。 */
const CJK_CHARACTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

export function isCJKChar(character: string): boolean {
  return CJK_CHARACTER.test(character);
}

/**
 * 续行 / 续块的拼接规则，正文重排、PDF 几何重建与译文分组共用：
 *
 *   - 断词连字符：续行以小写字母开头才拼回一个词（"attenu-\nation" → "attenuation"）；
 *     否则保留连字符，避免把 "state-" + "of-the-art" 粘成 "stateof-the-art"；
 *   - 任一侧是 CJK 时不插空格：中文 PDF 的文本层按字符切分，插空格会出现「本文提出 了」；
 *   - 其余情况按调用方意图决定是否插空格（行内小间隙不插，跨行插）。
 */
export function joinLineContinuation(left: string, right: string, spaced = true): string {
  const head = left.replace(/\s+$/, '');
  const tail = right.trim();
  if (!head) return tail;
  if (!tail) return head;
  if (head.endsWith('-')) return (/^[a-z]/.test(tail) ? head.slice(0, -1) : head) + tail;
  if (!spaced || isCJKChar(head.charAt(head.length - 1)) || isCJKChar(tail.charAt(0))) return head + tail;
  return `${head} ${tail}`;
}

/** 合并续行；连字符结尾的英文断词直接拼接（"attenu-\nation" → "attenuation"）。 */
export function reflowPaperText(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const previous = out.length ? out[out.length - 1] : undefined;
    if (previous !== undefined && !isStructuralLine(previous) && !isStructuralLine(line)) {
      out[out.length - 1] = joinLineContinuation(previous, line);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** 重排后的文本切成段落：空行分隔，页标记单独成段（界面据此显示 Page 芯片）。 */
export function splitParagraphs(reflowed: string): Array<{ kind: 'page' | 'paragraph'; text: string; page?: number }> {
  const blocks = reflowed.split(/\n{2,}/);
  const out: Array<{ kind: 'page' | 'paragraph'; text: string; page?: number }> = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const marker = /^=== Page (\d+) ===/.exec(trimmed);
    if (marker) {
      const page = Number(marker[1]);
      out.push({ kind: 'page', text: trimmed, page });
      const rest = trimmed.slice(marker[0].length).trim();
      if (rest) out.push({ kind: 'paragraph', text: rest });
      continue;
    }
    out.push({ kind: 'paragraph', text: trimmed });
  }
  return out;
}

/** 抽取 PDF 文本里的断行噪声：行内多余空白压成一个空格，便于两端对齐。 */
export function collapseInlineWhitespace(text: string): string {
  return text.replace(/[ \t]{2,}/g, ' ');
}

/**
 * 一页正文的段落列表——中栏渲染与译文对照共用同一份切分，顺序与数量必须一致，
 * 否则译文会贴错位置。页标记（Page N）不是段落，这里已剔除。
 */
export function pageParagraphs(text: string): string[] {
  return splitParagraphs(paragraphizePage(text))
    .filter((block) => block.kind === 'paragraph')
    .map((block) => collapseInlineWhitespace(block.text.trim()))
    .filter((paragraph) => paragraph.length > 0);
}

/**
 * 段落还原。
 *
 * PDF 文本层只给「一行一换行」，段与段之间通常没有空行——直接合并整页会变成一块墙字，
 * 首行缩进也就只剩第一行有用。这里用排版学里的经典判据：
 * 一行如果「没填满列宽」且以句末标点收尾，它就是段落的最后一行，下一行开新段。
 *
 * 与 reflowPaperText 分开保留：后者是旧版的逐字行为（parity 用），这里做的是增强。
 */
export function paragraphizePage(text: string): string {
  const lines = text.split('\n');
  const bodyLengths = lines
    .filter((line) => line.trim() && !isStructuralLine(line))
    .map((line) => line.trimEnd().length)
    .filter((length) => length > 0)
    .sort((a, b) => a - b);
  const median = bodyLengths.length ? (bodyLengths[Math.floor(bodyLengths.length / 2)] ?? 0) : 0;
  // 短行的门槛：不足列宽 80% 视为「没填满」。太小的中位数说明这页本来就没什么正文。
  const shortThreshold = median > 0 ? median * 0.8 : Number.POSITIVE_INFINITY;

  const groups: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) {
      groups.push(current);
      current = [];
    }
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (isStructuralLine(line)) {
      flush();
      groups.push([line]);
      continue;
    }
    const trimmed = line.trim();
    const previous = current[current.length - 1];
    // 段落末行通常没填满列宽；再以句末标点收尾即可判定闭合（含中文全角标点）。
    const previousClosed =
      previous !== undefined &&
      previous.trimEnd().length < shortThreshold &&
      /(?:[.!?:;»”"')\]]|[。！？；：」』】）》])\s*$/.test(previous.trimEnd());
    // 全大写短行（"ABSTRACT"）是小节标题：自己单独成块。
    const looksLikeHeading = trimmed.length <= 40 && trimmed === trimmed.toUpperCase() && /[A-Z]{3}/.test(trimmed);
    // 编号小节标题常被 PDF 并进上一段末尾（"…Representation 1 Introduction Cone Beam…"），
    // 行首出现「数字 + 大写词」即视为新段起点。
    const startsNumberedSection = /^\d+(?:\.\d+)*\s+[A-Z][a-z]/.test(trimmed);
    if (current.length && (previousClosed || looksLikeHeading || startsNumberedSection)) flush();
    current.push(line);
    if (looksLikeHeading) flush();
  }
  flush();

  return groups.map((group) => joinLines(group)).join('\n\n');
}

/** 组内合并续行，处理英文断词连字符与中文相邻字符。 */
function joinLines(lines: string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    out = out ? joinLineContinuation(out, line) : line;
  }
  return out;
}
