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
export interface PDFLayout {
  width: number;
  height: number;
  blocks: PDFTextBlock[];
  /** Decorative initial letters, excluded from cached paragraph segmentation. */
  ornaments?: PDFTextBox[];
}

/** Join nearby words into lines, then paragraphs, without crossing column/table gaps. */
export function buildPDFLayout(width: number, height: number, items: PDFTextBox[]): PDFLayout {
  const lines: PDFTextBlock[] = [];
  // Repeated long lines reveal the gutter even when justified word spacing is
  // almost as wide as the column gap. Titles spanning both columns don't vote.
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const leftEnds = items.filter((item) => item.width > width * 0.25 && item.width < width * 0.55 && item.x < width * 0.35 && item.x + item.width > width * 0.4 && item.x + item.width < width * 0.6).map((item) => item.x + item.width);
  const rightStarts = items.filter((item) => item.width > width * 0.25 && item.width < width * 0.55 && item.x > width * 0.4 && item.x < width * 0.65).map((item) => item.x);
  const leftEdge = leftEnds.length >= 3 ? median(leftEnds) : 0;
  const rightEdge = rightStarts.length >= 3 ? median(rightStarts) : 0;
  const gutter = leftEdge && rightEdge - leftEdge > width * 0.006 && rightEdge - leftEdge < width * 0.1 ? (leftEdge + rightEdge) / 2 : null;
  const sorted = items.filter((item) => item.text.trim() && item.width > 0 && item.height > 0)
    .sort((a, b) => Math.abs(a.y - b.y) < Math.min(a.height, b.height) * 0.45 ? a.x - b.x : a.y - b.y);
  for (const item of sorted) {
    const line = lines.findLast((candidate) =>
      Math.abs(candidate.y - item.y) < Math.min(candidate.fontSize, item.height) * 0.45 &&
      !(gutter !== null && candidate.x + candidate.width < gutter && item.x > gutter) &&
      item.x >= candidate.x && item.x - (candidate.x + candidate.width) < item.height * 1.5);
    if (line) {
      const gap = item.x - (line.x + line.width);
      line.text += (gap > item.height * 0.12 ? ' ' : '') + item.text;
      line.width = Math.max(line.width, item.x + item.width - line.x);
      const bottom = Math.max(line.y + line.height, item.y + item.height);
      line.y = Math.min(line.y, item.y);
      line.height = bottom - line.y;
      line.fontSize = Math.max(line.fontSize, item.height);
      if (item.textFontSize != null) line.textFontSize = Math.max(line.textFontSize ?? 0, item.textFontSize);
    } else lines.push({ ...item, fontSize: item.height });
  }
  const blocks: PDFTextBlock[] = [];
  for (const line of lines) {
    const preceding = blocks.findLast((block) => {
      const gap = line.y - (block.y + block.height);
      const centered = Math.abs(block.x + block.width / 2 - line.x - line.width / 2) < line.fontSize * 0.8;
      return gap >= -1 && gap < line.fontSize * 0.65 &&
        (Math.abs(block.x - line.x) < line.fontSize * 0.8 || centered) &&
        Math.abs(block.fontSize - line.fontSize) < line.fontSize * 0.15 &&
        // A short row is a caption/title/table cell or paragraph end.
        block.width > width * 0.25 && (line.width > block.width * 0.65 || (centered && line.width > width * 0.2));
    });
    if (preceding) {
      preceding.text = preceding.text.replace(/-$/, '') + (preceding.text.endsWith('-') ? '' : ' ') + line.text;
      const right = Math.max(preceding.x + preceding.width, line.x + line.width);
      preceding.x = Math.min(preceding.x, line.x);
      preceding.width = right - preceding.x;
      preceding.height = line.y + line.height - preceding.y;
      if (line.textFontSize != null) preceding.textFontSize = Math.max(preceding.textFontSize ?? 0, line.textFontSize);
    } else blocks.push({ ...line });
  }
  // Mathematical rows stay on the original canvas; do not cover them with prose.
  return { width, height, blocks: blocks.filter((block) => {
    const letters = block.text.match(/[a-zA-Z\u4e00-\u9fff]/g)?.length ?? 0;
    const proseWords = block.text.match(/[a-zA-Z]{3,}/g) ?? [];
    const equation = /[=∑∫]/u.test(block.text) && proseWords.filter((word) => !/^(sin|cos|tan|log|exp|arg|min|max|lim|sum)$/i.test(word)).length < 2;
    return letters >= 3 && !equation && !(/^[\d\s.,()%+−=<>±×÷∑∫√α-ω]+$/u.test(block.text));
  }) };
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
