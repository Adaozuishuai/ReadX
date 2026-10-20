import { joinLineContinuation } from './text.js';

/** Geometry in an unscaled, top-left PDF viewport. No DOM or PDF.js runtime needed. */
export interface PDFTextBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Actual PDF em size; glyph bounding boxes can be substantially taller. */
  textFontSize?: number;
}
export interface PDFTextBlock extends PDFTextBox {
  fontSize: number;
}
export interface PDFVisualBlock extends PDFTextBox {
  kind: 'table' | 'image';
  label?: string;
}
export interface PDFLayout {
  width: number;
  height: number;
  blocks: PDFTextBlock[];
  /** OCR layout objects that are not selectable prose paragraphs. */
  visuals?: PDFVisualBlock[];
  /** Decorative initial letters, excluded from cached paragraph segmentation. */
  ornaments?: PDFTextBox[];
}

/** Join nearby words into lines, then paragraphs, without crossing column/table gaps. */
export function buildPDFLayout(width: number, height: number, items: PDFTextBox[]): PDFLayout {
  const lines: PDFTextBlock[] = [];
  const gutter = detectGutter(width, items);
  const sorted = items.filter((item) => item.text.trim() && item.width > 0 && item.height > 0)
    .sort((a, b) => Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.45 ? a.x - b.x : a.y - b.y);
  for (const item of sorted) {
    const line = lines.findLast((candidate) =>
      Math.abs(candidate.y - item.y) < Math.min(candidate.fontSize, item.height) * 0.45 &&
      !(gutter !== null && candidate.x + candidate.width < gutter && item.x > gutter) &&
      item.x >= candidate.x && item.x - (candidate.x + candidate.width) < item.height * 1.5);
    if (line) {
      const gap = item.x - (line.x + line.width);
      line.text = joinLineContinuation(line.text, item.text, gap > item.height * 0.12);
      line.width = Math.max(line.width, item.x + item.width - line.x);
      const bottom = Math.max(line.y + line.height, item.y + item.height);
      line.y = Math.min(line.y, item.y);
      line.height = bottom - line.y;
      line.fontSize = Math.max(line.fontSize, item.height);
      if (item.textFontSize != null) line.textFontSize = Math.max(line.textFontSize ?? 0, item.textFontSize);
    } else lines.push({ ...item, fontSize: item.height });
  }

  // 「上一行是否写完」的基准：该侧正文的右缘（90 分位，避免个别跨栏行抬高基准）。
  const edges = columnRightEdges(width, lines, gutter);
  const rightEdgeOf = (x: number) => (gutter !== null && x >= gutter ? edges.right : edges.left);
  const filled = (end: number, x: number, fontSize: number) =>
    end >= rightEdgeOf(x) - Math.max(fontSize * 0.75, width * 0.02);
  const blocks: PDFTextBlock[] = [];
  // 与 blocks 一一对应的排版状态：段落里已有几行、最后一行右缘在哪。
  const meta: { lineCount: number; lastLineEnd: number }[] = [];
  for (const line of lines) {
    let precedingIndex = -1;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (mergesInto(blocks[i]!, meta[i]!, line, gutter, filled, width)) {
        precedingIndex = i;
        break;
      }
    }
    const preceding = precedingIndex >= 0 ? blocks[precedingIndex] : undefined;
    if (preceding) {
      const state = meta[precedingIndex]!;
      preceding.text = joinLineContinuation(preceding.text, line.text);
      const right = Math.max(preceding.x + preceding.width, line.x + line.width);
      preceding.x = Math.min(preceding.x, line.x);
      preceding.width = right - preceding.x;
      preceding.height = line.y + line.height - preceding.y;
      if (line.textFontSize != null) preceding.textFontSize = Math.max(preceding.textFontSize ?? 0, line.textFontSize);
      state.lineCount += 1;
      state.lastLineEnd = line.x + line.width;
    } else {
      blocks.push({ ...line });
      meta.push({ lineCount: 1, lastLineEnd: line.x + line.width });
    }
  }

  // 双栏页面按「先左栏到底，再右栏」的阅读顺序输出；跨栏块留在左栏流里按 y 归位。
  // 单栏或未识别出栏缝时保持原有的 y 顺序。
  const ordered = gutter === null
    ? blocks
    : blocks.map((block, index) => ({ block, index }))
        .sort((a, b) => columnRank(a.block, gutter) - columnRank(b.block, gutter) || a.block.y - b.block.y || a.block.x - b.block.x)
        .map((entry) => entry.block);

  // Mathematical rows stay on the original canvas; do not cover them with prose.
  return { width, height, blocks: ordered.filter((block) => {
    const letters = block.text.match(/[a-zA-Z\u4e00-\u9fff]/g)?.length ?? 0;
    const proseWords = block.text.match(/[a-zA-Z]{3,}/g) ?? [];
    const equation = /[=∑∫]/u.test(block.text) && proseWords.filter((word) => !/^(sin|cos|tan|log|exp|arg|min|max|lim|sum)$/i.test(word)).length < 2;
    return letters >= 3 && !equation && !(/^[\d\s.,()%+−=<>±×÷∑∫√α-ω]+$/u.test(block.text));
  }) };
}

/**
 * 段落合并判据（取代旧版「新行必须够宽」的近似）：一行是否属于上一段，看**上一行有没有写完**。
 *
 *   - 上一行到达该栏正文右缘（或这是居中标题的续行）→ 段落没写完，续行并进来；段末那一行
 *     本身就短，所以旧判据会把段末行切出去，这里不再要求新行够宽。
 *   - 上一行没写完 → 段落已闭合，新行开新段（表格单元、图注、标题因此保持独立）。
 *   - 段落首行缩进：PDF 常把缩进的段首单独抽成一行，紧随其后的齐左行是它的续行。
 *   - 短行只有在「行距与段内一致且字号完全一致」时才允许并入，避免把图注、
 *     脚注、表头这些换行距/换字号的短行吞进正文段落。
 */
function mergesInto(
  block: PDFTextBlock,
  state: { lineCount: number; lastLineEnd: number },
  line: PDFTextBlock,
  gutter: number | null,
  filled: (end: number, x: number, fontSize: number) => boolean,
  pageWidth: number,
): boolean {
  const gap = line.y - (block.y + block.height);
  if (gap < -1 || gap >= line.fontSize * 0.65) return false;
  if (Math.abs(block.fontSize - line.fontSize) >= line.fontSize * 0.15) return false;
  // 窄块（表格单元、标签）不能吞掉后面的行，旧版靠这条让表格保持独立。
  if (block.width <= pageWidth * 0.25) return false;
  // 栏缝两侧绝不合并，即使栏缝检测失效也要靠这条兜住。
  if (gutter !== null && block.x + block.width < gutter && line.x > gutter) return false;
  const offset = line.x - block.x;
  const aligned = Math.abs(offset) < line.fontSize * 0.8;
  // 居中续行只可能是标题；表格单元、窄标签即使同宽同 x 也不算居中。
  const centered = line.width > pageWidth * 0.2 &&
    Math.abs(block.x + block.width / 2 - line.x - line.width / 2) < line.fontSize * 0.8;
  const previousWrapped = filled(state.lastLineEnd, block.x, block.fontSize);
  const indentedOpening = state.lineCount === 1 &&
    offset < -line.fontSize * 0.45 && offset > -line.fontSize * 2.5 && previousWrapped;
  if (!aligned && !centered && !indentedOpening) return false;
  if (!(previousWrapped || centered)) return false;
  // 没有到达栏右缘的行，只可能是段落末行或图注/脚注这类独立短行：
  // 只有紧贴上一行且字号完全一致时才算同一段。
  if (!filled(line.x + line.width, line.x, line.fontSize)) {
    const sameFont = Math.abs(block.fontSize - line.fontSize) < line.fontSize * 0.05;
    return gap < line.fontSize * 0.4 && sameFont;
  }
  return true;
}

/**
 * 双栏页面的栏缝：看**同一行上左右两段正文之间**的稳定空隙。
 *
 * 旧判据要求每侧各有 ≥2 条「宽度落在页面 25%–55% 且贴边」的行来投票，某栏只剩
 * 一两行正文（例如另一栏被大图占掉半页）时就检测不到，左右栏会先被并成一行，
 * 后续段落判据全部失真。改为按行聚类：多行都在同一个位置断开、且断开两侧都是
 * 正文宽度的行，才算栏缝；表格窄单元、公式残片不参与投票。
 */
function detectGutter(width: number, items: PDFTextBox[]): number | null {
  const prose = items.filter((item) => item.text.trim() && item.width > width * 0.15);
  if (prose.length < 4) return null;
  const rows: PDFTextBox[][] = [];
  for (const item of [...prose].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find((candidate) => Math.abs(candidate[0]!.y - item.y) < Math.min(candidate[0]!.height, item.height) * 0.45);
    if (row) row.push(item);
    else rows.push([item]);
  }
  const centers: number[] = [];
  for (const row of rows) {
    const sorted = [...row].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      const start = sorted[i - 1]!.x + sorted[i - 1]!.width;
      const end = sorted[i]!.x;
      const size = end - start;
      // 太窄是词距，太宽不是栏缝（可能是图注与正文之间的空当）。
      if (size <= width * 0.008 || size > width * 0.1) continue;
      centers.push((start + end) / 2);
    }
  }
  if (centers.length < 2) return null;
  const sortedCenters = centers.sort((a, b) => a - b);
  let best: number[] = [];
  let current: number[] = [sortedCenters[0]!];
  for (let i = 1; i < sortedCenters.length; i += 1) {
    if (sortedCenters[i]! - current[current.length - 1]! <= width * 0.03) current.push(sortedCenters[i]!);
    else {
      if (current.length > best.length) best = current;
      current = [sortedCenters[i]!];
    }
  }
  if (current.length > best.length) best = current;
  if (best.length < 2) return null;
  return best[Math.floor(best.length / 2)]!;
}

/** 各栏正文右缘（90 分位），作为「这一行写满了没有」的基准。 */
function columnRightEdges(width: number, lines: PDFTextBlock[], gutter: number | null): { left: number; right: number } {
  const edgeOf = (subset: PDFTextBlock[]) => {
    const ends = subset.map((line) => line.x + line.width).sort((a, b) => a - b);
    if (!ends.length) return width * 0.9;
    return ends[Math.min(ends.length - 1, Math.floor(ends.length * 0.9))]!;
  };
  if (gutter === null) {
    const edge = edgeOf(lines);
    return { left: edge, right: edge };
  }
  return { left: edgeOf(lines.filter((line) => line.x < gutter)), right: edgeOf(lines.filter((line) => line.x >= gutter)) };
}

function columnRank(block: PDFTextBlock, gutter: number): number {
  return block.x >= gutter ? 1 : 0;
}

/** Rounded measurement and stable gutter avoid resize/render feedback at fit width. */
export function fitPDFWidth(clientWidth: number, padding = 40): number {
  return Math.max(1, Math.floor(clientWidth - padding));
}

/** Hit testing uses normalized page coordinates, independent of zoom and pane size. */
export function paragraphAt(layout: PDFLayout, x: number, y: number): number | null {
  const px = x * layout.width, py = y * layout.height;
  let index: number | null = null;
  for (let i = 0; i < layout.blocks.length; i++) {
    const block = layout.blocks[i]!;
    if (px < block.x || px > block.x + block.width || py < block.y || py > block.y + block.height) continue;
    const previous = index === null ? null : layout.blocks[index]!;
    if (!previous || block.width * block.height < previous.width * previous.height) index = i;
  }
  return index;
}
