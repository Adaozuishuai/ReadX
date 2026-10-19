import { useEffect, useRef, useState } from 'react';
import { OPS, Util } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

export type ReadingKind = 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';
export type PaperVisualKind = 'figure' | 'table';

export interface PaperVisualMetadata {
  id: string;
  kind: PaperVisualKind;
  page: number;
  caption: string;
  suggestedStep: ReadingKind;
}

export interface PaperVisual extends PaperVisualMetadata {
  imageURL: string | null;
  debugImageURL: string | null;
  sourcePDFURL: string | null;
  captionBounds: VisualBounds | null;
  detectedBounds: VisualBounds;
  cropBounds: VisualBounds | null;
  extractionStatus: 'ready' | 'crop-failed';
  extractionError?: string;
  reviewStatus?: 'automatic' | 'needs-review' | 'manual';
  reviewReason?: string;
}

export interface VisualBounds { x: number; y: number; width: number; height: number }
export interface VisualSelection extends PaperVisualMetadata { bounds: VisualBounds }
export interface VisualMention { kind: PaperVisualKind; label: string; pages: number[] }
export interface PaperVisualProgress { page: number; total: number; phase: 'detecting' | 'extracting' | 'source-pdf'; detected: number; failed: number }

interface TextRow { text: string; x: number; y: number; width: number; height: number }

const CAPTION_LABEL = /^(?:(?:supplementary|extended\s+data|appendix)\s+)?(table|figure|fig\.?|图|表)\s*[.．:：、]?\s*([a-z]?\s*\d+(?:\.\d+)*(?:[a-z]|\s*\([a-z0-9]+\))?|[ivxlcdm]+|[一二三四五六七八九十百]+)(?=[\s.．:：、，,;；)(\u4e00-\u9fff]|$)/i;

function normalizeCaptionText(text: string) {
  return text.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ').trim();
}
function visualNumber(value: string): string {
  return value.replace(/\s/g, '').replace(/^([a-z]?\d+(?:\.\d+)*)(?:[a-z]|\([a-z0-9]+\))$/i, '$1').toUpperCase();
}
function mentionsFromText(content: TextContent, page: number): VisualMention[] {
  const text = content.items.filter((item): item is Extract<TextContent['items'][number], { str: string }> => 'str' in item).map((item) => item.str).join(' ');
  const pattern = /\b(Figures?|Figs?\.?|Tables?)\s*([a-z]?\s*\d+(?:\.\d+)*(?:[a-z]|\s*\([a-z0-9]+\))?|[ivxlcdm]+)(?![\p{L}\p{N}])|([图表])\s*(\d+(?:\.\d+)*|[一二三四五六七八九十百]+)/giu;
  const found: VisualMention[] = [];
  for (const match of text.matchAll(pattern)) {
    const kind = /^(?:table|表)/i.test(match[1] || match[3] || '') ? 'table' as const : 'figure' as const;
    found.push({ kind, label: visualNumber(match[2] || match[4] || ''), pages: [page] });
  }
  return found;
}

function rowsFromPage(page: PDFPageProxy, content: TextContent): TextRow[] {
  const viewport = page.getViewport({ scale: 1 });
  const [a, b, c, d] = viewport.transform;
  const rows: TextRow[] = [];
  const positioned: { text: string; x: number; y: number; width: number; height: number }[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [m0, m1, m2, m3, m4, m5] = item.transform;
    const dx = a! * m0! + c! * m1!;
    const dy = b! * m0! + d! * m1!;
    if (Math.abs(dy) > Math.abs(dx) * 0.2) continue;
    // Apply the page viewport to the text origin and glyph basis. This accounts
    // for crop-box offsets, page rotation, and the current viewport scale.
    const [x, baselineY] = viewport.convertToViewportPoint(m4!, m5!);
    const height = Math.max(4, Math.hypot(a! * m2! + c! * m3!, b! * m2! + d! * m3!));
    const y = baselineY - height * 0.9;
    const width = item.width * viewport.scale;
    positioned.push({ text: item.str.trim(), x, y, width, height });
  }
  // PDF text items are not guaranteed to arrive in visual order (especially in
  // two-column papers). Order them geometrically before assembling caption rows.
  positioned.sort((left, right) => left.y - right.y || left.x - right.x);
  for (const item of positioned) {
    const row = rows.findLast((candidate) => Math.abs(candidate.y - item.y) < Math.max(2.5, Math.min(candidate.height, item.height) * 0.4)
      && item.x >= candidate.x - 2 && item.x - (candidate.x + candidate.width) < Math.max(12, item.height * 1.5));
    if (row) {
      const gap = item.x - (row.x + row.width);
      row.text += (gap > item.height * 0.1 ? ' ' : '') + item.text;
      row.width = Math.max(row.width, item.x + item.width - row.x);
      row.height = Math.max(row.height, item.height);
    } else rows.push({ text: item.text, x: item.x, y: item.y, width: item.width, height: item.height });
  }
  return rows.sort((left, right) => left.y - right.y || left.x - right.x);
}

function captionType(text: string): PaperVisualKind | null {
  const normalized = normalizeCaptionText(text);
  const match = normalized.match(CAPTION_LABEL);
  if (!match) return null;
  // Body references beginning a line ("Figure 4, a self-attention…") are not captions.
  if (/^\s*(?:[,，;；]|(?:shows?|illustrates?|depicts?|demonstrates?|presents?|compares?|provides?|reports?|summari[sz]es?|and|we|the\s+(?:performance|results))\b)/i.test(normalized.slice(match[0].length))) return null;
  const label = match[1]?.toLowerCase().replace(/\.$/, '');
  if (label === 'table' || label === 'tables' || label === '表') return 'table';
  if (label) return 'figure';
  return null;
}

function suggestedStep(kind: PaperVisualKind, caption: string): ReadingKind {
  const text = caption.toLowerCase();
  if (/architecture|framework|overview|pipeline|network|module|workflow|schematic|结构|架构|框架|流程|网络|模块|示意/.test(text)) return 'method';
  if (/dataset|acquisition|geometry|setup|protocol|scan|phantom|数据集|采集|几何|配置|体模|扫描/.test(text)) return 'experiment';
  if (/comparison|compare|quantitative|qualitative|performance|result|ablation|psnr|ssim|rmse|对比|定量|定性|性能|结果|消融/.test(text)) return 'results';
  if (/motivation|limitation|challenge|problem|动机|局限|挑战|问题/.test(text)) return 'motivation';
  return kind === 'table' ? 'results' : 'method';
}

type VisualCandidate = PaperVisualMetadata & { x: number; y: number; width: number; height: number; imageBounds?: VisualBounds; reviewReason?: string; hasCaption?: boolean };

async function graphicObjectBounds(page: PDFPageProxy, viewport: { transform: number[]; width: number; height: number }): Promise<VisualBounds[]> {
  const operators = await page.getOperatorList();
  const stack: { transform: number[]; clip: VisualBounds | null }[] = [];
  let transform = [1, 0, 0, 1, 0, 0];
  let clip: VisualBounds | null = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const bounds: VisualBounds[] = [];
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const transformedBounds = (local: number[], matrix: number[]): VisualBounds => {
    const corners = [[local[0]!, local[1]!], [local[2]!, local[1]!], [local[0]!, local[3]!], [local[2]!, local[3]!]].map((point) => Util.applyTransform(point, matrix));
    const xs = corners.map((point) => point[0]!), ys = corners.map((point) => point[1]!);
    const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
    return { x, y, width: Math.min(viewport.width, Math.max(...xs)) - x, height: Math.min(viewport.height, Math.max(...ys)) - y };
  };
  const add = (local: number[], matrix: number[], vector = false) => {
    if (!clip) return;
    const candidate = intersectBounds(transformedBounds(local, matrix), clip);
    if (!candidate) return;
    const meaningful = vector ? candidate.width >= 15 && candidate.height >= 12 : candidate.width >= 4 && candidate.height >= 4;
    if (Object.values(candidate).every(Number.isFinite) && meaningful && candidate.width * candidate.height >= 24 && candidate.width * candidate.height <= viewport.width * viewport.height * 0.7) bounds.push(candidate);
  };
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index];
    const args = operators.argsArray[index] as unknown[] | undefined;
    if (op === OPS.save) stack.push({ transform, clip });
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const saved = stack.pop(); transform = saved?.transform ?? [1, 0, 0, 1, 0, 0]; clip = saved ? saved.clip : { x: 0, y: 0, width: viewport.width, height: viewport.height };
    }
    else if (op === OPS.transform && args?.length === 6 && args.every((value) => typeof value === 'number')) transform = Util.transform(transform, args as number[]);
    else if (op === OPS.paintFormXObjectBegin && args?.length) {
      stack.push({ transform, clip });
      if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) transform = Util.transform(transform, Array.from(args[0] as ArrayLike<number>));
      if (clip && (Array.isArray(args[1]) || ArrayBuffer.isView(args[1]))) clip = intersectBounds(clip, transformedBounds(Array.from(args[1] as ArrayLike<number>), Util.transform(viewport.transform, transform)));
    }
    const matrix = Util.transform(viewport.transform, transform);
    if (op !== undefined && imageOps.has(op)) add([0, 0, 1, 1], matrix);
    else if (op === OPS.constructPath && args?.[2] && (Array.isArray(args[2]) || ArrayBuffer.isView(args[2]))) add(Array.from(args[2] as ArrayLike<number>), matrix, true);
    else if (op === OPS.paintImageXObjectRepeat && args) {
      const positions = args[3] as ArrayLike<number>;
      if (positions?.length && typeof args[1] === 'number' && typeof args[2] === 'number') for (let i = 0; i < positions.length; i += 2) add([0, 0, 1, 1], Util.transform(matrix, [args[1], 0, 0, args[2], positions[i]!, positions[i + 1]!]));
    } else if ((op === OPS.paintInlineImageXObjectGroup || op === OPS.paintImageMaskXObjectGroup) && args) {
      const items = (op === OPS.paintInlineImageXObjectGroup ? args[1] : args[0]) as { transform?: number[] }[];
      if (Array.isArray(items)) for (const item of items) if (item.transform?.length === 6) add([0, 0, 1, 1], Util.transform(matrix, item.transform));
    } else if (op === OPS.paintImageMaskXObjectRepeat && args) {
      const positions = args[5] as ArrayLike<number>;
      if (positions?.length && args.slice(1, 5).every((v) => typeof v === 'number')) for (let i = 0; i < positions.length; i += 2) add([0, 0, 1, 1], Util.transform(matrix, [args[1] as number, args[2] as number, args[3] as number, args[4] as number, positions[i]!, positions[i + 1]!]));
    }
  }
  // Merge overlapping/touching raster tiles (common in scanned charts) into
  // one original-image region before associating it with a nearby caption.
  const merged: VisualBounds[] = [];
  for (const bound of bounds) {
    let combined = bound;
    // Revisit earlier groups after every union: a tile can bridge two groups.
    for (let index = 0; index < merged.length;) {
      const item = merged[index]!;
      if (combined.x <= item.x + item.width + 12 && combined.x + combined.width >= item.x - 12
        && combined.y <= item.y + item.height + 12 && combined.y + combined.height >= item.y - 12) {
        const left = Math.min(item.x, combined.x), top = Math.min(item.y, combined.y);
        combined = { x: left, y: top, width: Math.max(item.x + item.width, combined.x + combined.width) - left, height: Math.max(item.y + item.height, combined.y + combined.height) - top };
        merged.splice(index, 1); index = 0;
      } else index++;
    }
    merged.push(combined);
  }
  return merged;
}

function overlapX(a: VisualBounds, b: VisualBounds) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
}
function unionBounds(items: VisualBounds[]): VisualBounds {
  const x = Math.min(...items.map((b) => b.x)), y = Math.min(...items.map((b) => b.y));
  return { x, y, width: Math.max(...items.map((b) => b.x + b.width)) - x, height: Math.max(...items.map((b) => b.y + b.height)) - y };
}
function associateGraphicObjects(graphics: VisualBounds[], captions: VisualCandidate[], viewport: { width: number; height: number }): VisualCandidate[] {
  // Operators describe panels, masks or backgrounds; they are boundary hints,
  // never standalone proof that a page contains a complete figure.
  const owners = new Map<VisualBounds, string>();
  for (const graphic of graphics) {
    const candidates = captions.filter((caption) => {
      if (caption.kind !== 'figure') return false;
      const gap = caption.y - (graphic.y + graphic.height);
      if (gap < -2 || gap > 72 || overlapX(graphic, caption) < Math.min(graphic.width, caption.width) * 0.35) return false;
      const middle = graphic.x + graphic.width / 2;
      if (caption.width < viewport.width * 0.55 && graphic.width < viewport.width * 0.55
        && (middle < viewport.width / 2) !== (caption.x + caption.width / 2 < viewport.width / 2)) return false;
      return !captions.some((other) => other.id !== caption.id && other.y > graphic.y && other.y < caption.y - 2
        && overlapX(other, graphic) > Math.min(other.width, graphic.width) * 0.5);
    }).sort((a, b) => a.y - b.y);
    if (candidates[0]) owners.set(graphic, candidates[0].id);
  }
  return captions.map((caption) => {
    const assigned = graphics.filter((g) => owners.get(g) === caption.id);
    if (!assigned.length) return caption;
    const bounds = unionBounds(assigned);
    if (bounds.height < 18 || bounds.width < Math.min(caption.width * 0.45, viewport.width * 0.2)) return caption;
    return { ...caption, imageBounds: bounds, hasCaption: true };
  });
}

function findCaptions(page: PDFPageProxy, content: TextContent): VisualCandidate[] {
  const rows = rowsFromPage(page, content);
  const viewport = page.getViewport({ scale: 1 });
  const out: VisualCandidate[] = [];
  const consumed = new Set<TextRow>();
  for (const row of rows) {
    if (consumed.has(row)) continue;
    const kind = captionType(row.text);
    if (!kind || row.y < viewport.height * 0.025 || row.y > viewport.height * 0.95) continue;
    const lines = [row];
    const marker = normalizeCaptionText(row.text).match(CAPTION_LABEL);
    const labelOnly = !!marker && /^[.．:：、\s]*$/.test(normalizeCaptionText(row.text).slice(marker[0].length));
    consumed.add(row);
    // Reading order interleaves columns. Continue by spatial adjacency, not
    // the next array index, and consume only the actual caption rows.
    while (lines.length < 12) {
      const previous = lines.at(-1)!;
      const next = rows.filter((candidate) => {
        if (consumed.has(candidate) || candidate.y <= previous.y + previous.height * 0.45) return false;
        const gap = candidate.y - (previous.y + previous.height);
        if (gap < -2 || gap > Math.max(6, previous.height * 0.75)) return false;
        if (captionType(candidate.text)) return false;
        const overlap = overlapX(candidate, row);
        const aligned = Math.abs(candidate.x - row.x) <= Math.max(16, row.height * 2);
        const centered = Math.abs(candidate.x + candidate.width / 2 - (row.x + row.width / 2)) < 40;
        if (!aligned && !(centered && overlap > Math.min(candidate.width, row.width) * 0.5)) return false;
        if (!labelOnly && row.width < viewport.width * 0.55 && candidate.width > viewport.width * 0.58) return false;
        if (candidate.height > row.height * 1.16 || candidate.height < row.height * 0.72) return false;
        if (/^(?:\d+(?:\.\d+)*\s+)?(?:introduction|methods?|results?|discussion|conclusion|references|参考文献|引言|方法|结果|讨论|结论)\b/i.test(candidate.text)) return false;
        if (kind === 'table' && /^(?:(?:method|metric|psnr|ssim|fdk|views?|dataset|aggregation|scales?)\b|#\s)/i.test(candidate.text)) return false;
        return true;
      }).sort((a, b) => a.y - b.y || Math.abs(a.x - row.x) - Math.abs(b.x - row.x))[0];
      if (!next) break;
      lines.push(next); consumed.add(next);
    }
    const caption = normalizeCaptionText(lines.map((line) => line.text).join(' '));
    const number = caption.match(CAPTION_LABEL)?.[2]?.replace(/[\s()]/g, '') ?? String(out.length + 1);
    const baseId = kind + '-' + page.pageNumber + '-' + number.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-');
    const id = out.some((item) => item.id === baseId) ? baseId + '-' + (out.length + 1) : baseId;
    out.push({ id, kind, page: page.pageNumber, caption, suggestedStep: suggestedStep(kind, caption), ...unionBounds(lines), hasCaption: true });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

function cropRegion(viewport: { width: number; height: number }, visual: VisualCandidate, kind: PaperVisualKind, side: 'before' | 'after' = kind === 'figure' ? 'before' : 'after', neighbors: VisualCandidate[] = [], rows: TextRow[] = []): VisualBounds {
  // Captions commonly occupy one column even when the figure itself spans the page.
  // Treat broad captions as full-width, otherwise preserve the column containing the caption.
  const fullWidth = visual.x < viewport.width * 0.16 && visual.x + visual.width > viewport.width * 0.84
    || visual.width > viewport.width * 0.58 || (visual.imageBounds?.width ?? 0) > viewport.width * 0.58
    || Math.abs(visual.x + visual.width / 2 - viewport.width / 2) < viewport.width * 0.06;
  const x = fullWidth ? 0 : visual.x + visual.width / 2 < viewport.width / 2 ? 0 : viewport.width / 2;
  const width = fullWidth ? viewport.width : viewport.width / 2;
  // Tall figures and multi-panel charts often extend much farther than a
  // conventional half-page crop. The whitespace scan below tightens this band.
  const context = viewport.height * 0.84;
  // Keep the caption for identification in the card, but crop it out of the image itself.
  let top = side === 'before' ? Math.max(viewport.height * 0.025, visual.y - context) : Math.min(viewport.height, visual.y + visual.height + 3);
  let bottom = side === 'before' ? Math.max(top + 1, visual.y - 3) : Math.min(viewport.height * 0.95, top + context);
  const lane = { x, y: top, width, height: bottom - top };
  for (const other of neighbors) {
    if (other.id === visual.id || overlapX(lane, other) < Math.min(width, other.width) * 0.45) continue;
    if (side === 'before' && other.y + other.height < visual.y) top = Math.max(top, other.y + other.height + 3);
    if (side === 'after' && other.y > visual.y + visual.height) bottom = Math.min(bottom, other.y - 3);
  }
  const prose = rows.filter((row) => row.height > Math.min(visual.height, rows.find((r) => Math.abs(r.y - visual.y) < 2)?.height ?? 9) * 1.07
    && overlapX(lane, row) > width * (fullWidth ? 0.32 : 0.62) && (row.text.match(/[a-z]{2,}/gi)?.length ?? 0) >= 6
    && (row.text.match(/\d/g)?.length ?? 0) < row.text.length * 0.12
    && !(visual.imageBounds && row.y >= visual.imageBounds.y - 20 && row.y + row.height <= visual.imageBounds.y + visual.imageBounds.height + 20));
  for (const b of prose) {
    const a = prose.findLast((row) => row.y < b.y - 2 && Math.abs(row.x - b.x) <= 5 && b.y - row.y <= row.height * 2.3);
    if (!a) continue;
    if (side === 'before' && b.y + b.height < visual.y - 5) top = Math.max(top, b.y + b.height + 4);
    if (side === 'after' && a.y > visual.y + visual.height + 5) bottom = Math.min(bottom, a.y - 4);
  }
  return { x, y: top, width, height: Math.max(1, bottom - top) };
}

function trimToCaptionAdjacentContent(
  pageCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
  visual: { y: number; height: number },
  kind: PaperVisualKind,
  side: 'before' | 'after',
  scale: number,
): VisualBounds | null {
  const x = Math.max(0, Math.floor(crop.x * scale));
  const y = Math.max(0, Math.floor(crop.y * scale));
  const width = Math.min(pageCanvas.width - x, Math.ceil(crop.width * scale));
  const height = Math.min(pageCanvas.height - y, Math.ceil(crop.height * scale));
  const context = pageCanvas.getContext('2d');
  if (!context || width <= 0 || height <= 0) return null;
  const pixels = context.getImageData(x, y, width, height).data;
  const anchor = side === 'before'
    ? Math.max(0, Math.min(height - 1, Math.floor((visual.y - 8 - crop.y) * scale)))
    : Math.max(0, Math.min(height - 1, Math.floor((visual.y + visual.height + 8 - crop.y) * scale)));
  const scan = (columnStride: number, inkThreshold: number) => {
    const sampledWidth = Math.ceil(width / columnStride);
    let nearest = -1;
    let farthest = -1;
    let blankRows = 0;
    // A table's horizontal rules can be separated by larger row gaps than a
    // plot's axes, so bridge a little farther for tables. Multi-scale column
    // sampling below catches both thin rules and dense borderless cell text.
    const blankGap = Math.max(24, scale * (kind === 'table' ? 14 : 18));
    const direction = side === 'before' ? -1 : 1;
    for (let row = anchor; row >= 0 && row < height; row += direction) {
      let ink = 0;
      const offset = row * width * 4;
      for (let column = 0; column < width; column += columnStride) {
        const pixel = offset + column * 4;
        if (pixels[pixel]! < inkThreshold || pixels[pixel + 1]! < inkThreshold || pixels[pixel + 2]! < inkThreshold) ink += 1;
      }
      const hasInk = ink > Math.max(2, sampledWidth * 0.0007);
      if (hasInk) {
        if (nearest < 0) nearest = row;
        farthest = row;
        blankRows = 0;
      } else if (nearest >= 0) {
        blankRows += 1;
        if (blankRows >= blankGap) break;
      } else if (Math.abs(row - anchor) > scale * 56) break;
    }
    if (nearest < 0 || farthest < 0 || Math.abs(nearest - farthest) < scale * 4) return null;
    return { nearest, farthest };
  };
  const fine = scan(Math.max(2, Math.round(scale * 0.55)), 246);
  const coarse = scan(Math.max(4, Math.round(scale * 1.5)), 238);
  if (!fine && !coarse) return null;
  const endpoints = [fine?.nearest, fine?.farthest, coarse?.nearest, coarse?.farthest].filter((value): value is number => value != null);
  const padding = scale * 2;
  const contentStart = Math.min(...endpoints);
  const contentEnd = Math.max(...endpoints);
  const localTop = Math.max(0, contentStart - padding);
  const localBottom = Math.min(height, contentEnd + padding);
  return { ...crop, y: (y + localTop) / scale, height: Math.max(1, (localBottom - localTop) / scale) };
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法编码图表截图')), 'image/png'));
}

async function debugPageImage(pageCanvas: HTMLCanvasElement, visuals: ReturnType<typeof findCaptions>, detections: (VisualBounds | null)[], crops: (VisualBounds | null)[], scale: number) {
  const debugScale = Math.min(1, 1800 / pageCanvas.width);
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(pageCanvas.width * debugScale));
  canvas.height = Math.max(1, Math.round(pageCanvas.height * debugScale));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(pageCanvas, 0, 0, canvas.width, canvas.height);
  for (let index = 0; index < visuals.length; index++) {
    const visual = visuals[index]!;
    const drawBounds = (bounds: VisualBounds, color: string, lineWidth: number) => {
      context.strokeStyle = color;
      context.lineWidth = lineWidth;
      context.strokeRect(bounds.x * scale * debugScale, bounds.y * scale * debugScale, bounds.width * scale * debugScale, bounds.height * scale * debugScale);
    };
    if (visual.hasCaption !== false) drawBounds({ x: visual.x, y: visual.y, width: visual.width, height: visual.height }, '#2188ff', 2);
    const detection = detections[index];
    if (detection) drawBounds(detection, '#ff8c00', 2);
    const crop = crops[index];
    if (crop) drawBounds(crop, '#12a150', 3);
  }
  try { return URL.createObjectURL(await canvasBlob(canvas)); }
  finally { canvas.width = 0; canvas.height = 0; }
}

function padBounds(bounds: VisualBounds, viewport: { width: number; height: number }, padding = 6): VisualBounds {
  const x = Math.max(0, bounds.x - padding), y = Math.max(0, bounds.y - padding);
  return { x, y, width: Math.min(viewport.width, bounds.x + bounds.width + padding) - x, height: Math.min(viewport.height, bounds.y + bounds.height + padding) - y };
}
function intersectBounds(a: VisualBounds, b: VisualBounds): VisualBounds | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}
function trimHorizontal(canvas: HTMLCanvasElement, bounds: VisualBounds, scale: number): VisualBounds {
  const x = Math.max(0, Math.floor(bounds.x * scale)), y = Math.max(0, Math.floor(bounds.y * scale));
  const width = Math.min(canvas.width - x, Math.ceil(bounds.width * scale)), height = Math.min(canvas.height - y, Math.ceil(bounds.height * scale));
  if (width <= 0 || height <= 0) return bounds;
  const pixels = canvas.getContext('2d')!.getImageData(x, y, width, height).data;
  let left = width, right = -1;
  for (let row = 0; row < height; row += 2) for (let column = 0; column < width; column += 2) {
    const offset = (row * width + column) * 4;
    if (pixels[offset]! < 246 || pixels[offset + 1]! < 246 || pixels[offset + 2]! < 246) { left = Math.min(left, column); right = Math.max(right, column); }
  }
  if (right < left) return bounds;
  left = Math.max(0, left - 3 * scale); right = Math.min(width, right + 3 * scale);
  return { ...bounds, x: (x + left) / scale, width: (right - left) / scale };
}
async function cropCanvasURL(pageCanvas: HTMLCanvasElement, bounds: VisualBounds, scale: number): Promise<string> {
  const canvas = window.document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bounds.width * scale)); canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图表裁切画布');
    context.drawImage(pageCanvas, bounds.x * scale, bounds.y * scale, bounds.width * scale, bounds.height * scale, 0, 0, canvas.width, canvas.height);
    return URL.createObjectURL(await canvasBlob(canvas));
  } finally { canvas.width = 0; canvas.height = 0; }
}

async function renderPageCrops(page: PDFPageProxy, visuals: VisualCandidate[]): Promise<PaperVisual[]> {
  if (!visuals.length) return [];
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(5, 12000 / Math.max(viewport.width, viewport.height), Math.sqrt(36_000_000 / (viewport.width * viewport.height)));
  const highResolution = page.getViewport({ scale });
  const pageCanvas = window.document.createElement('canvas');
  pageCanvas.width = Math.ceil(highResolution.width); pageCanvas.height = Math.ceil(highResolution.height);
  const result: PaperVisual[] = [];
  const detections: (VisualBounds | null)[] = [], crops: (VisualBounds | null)[] = [];
  try {
    const context = pageCanvas.getContext('2d');
    if (!context) throw new Error('无法创建高清图表画布');
    await page.render({ canvasContext: context, viewport: highResolution }).promise;
    const rows = rowsFromPage(page, await page.getTextContent());
    for (const visual of visuals) {
      const side = visual.kind === 'figure' ? 'before' as const : 'after' as const;
      const region = cropRegion(viewport, visual, visual.kind, side, visuals, rows);
      const preferred = trimToCaptionAdjacentContent(pageCanvas, region, visual, visual.kind, side, scale);
      let selected = preferred, selectedRegion = region;
      let reviewReason = '';
      if (visual.kind === 'figure' && visual.imageBounds) {
        // Include the entire graphics group plus nearby vector labels; an
        // individual raster panel can no longer override the full figure band.
        const graphic = visual.imageBounds;
        const labels = rows.filter((row) => row.y + row.height <= graphic.y + 2 && graphic.y - (row.y + row.height) <= 18
          && row.height <= 12 && (row.text.match(/[a-z]{2,}/gi)?.length ?? 0) < 9 && overlapX(row, graphic) > Math.min(row.width, graphic.width) * 0.4);
        const hint = intersectBounds(padBounds(unionBounds([graphic, ...labels]), viewport, 5), region);
        // Nearby tables may have only a short blank gap before the figure.
        // Do not union a whitespace scan that crossed into that separate table.
        if (hint) selected = hint;
      }
      if (!selected) {
        const alternateSide = side === 'before' ? 'after' as const : 'before' as const;
        const alternate = cropRegion(viewport, visual, visual.kind, alternateSide, visuals, rows);
        selected = trimToCaptionAdjacentContent(pageCanvas, alternate, visual, visual.kind, alternateSide, scale);
        selectedRegion = alternate;
        if (selected) reviewReason = '内容位于非常规图注方向，请确认选区对象与图注一致。';
      }
      let imageURL: string | null = null, crop: VisualBounds | null = null, extractionError: string | undefined;
      try {
        if (!selected || selected.height < 10) throw new Error('未找到可靠的图表边界，请在原页手动框选。');
        crop = trimHorizontal(pageCanvas, selected, scale);
        if (crop.width < 18) throw new Error('候选区域过窄，需手动确认边界。');
        if (crop.height > viewport.height * 0.65) reviewReason = '候选区域较大，可能包含相邻内容，请核对或校正。';
        imageURL = await cropCanvasURL(pageCanvas, crop, scale);
      } catch (cause) { extractionError = cause instanceof Error ? cause.message : String(cause); }
      detections.push(selectedRegion); crops.push(crop);
      result.push({ id: visual.id, kind: visual.kind, page: visual.page, caption: visual.caption, suggestedStep: visual.suggestedStep,
        imageURL, debugImageURL: null, sourcePDFURL: null, captionBounds: { x: visual.x, y: visual.y, width: visual.width, height: visual.height },
        detectedBounds: selectedRegion, cropBounds: crop, extractionStatus: imageURL ? 'ready' : 'crop-failed',
        reviewStatus: reviewReason || !imageURL ? 'needs-review' : 'automatic', ...(reviewReason ? { reviewReason } : {}), ...(extractionError ? { extractionError } : {}) });
    }
    const debugURL = await debugPageImage(pageCanvas, visuals, detections, crops, scale).catch(() => null);
    return result.map((item) => ({ ...item, debugImageURL: debugURL }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return visuals.map((visual) => ({ ...visual, imageURL: null, debugImageURL: null, sourcePDFURL: null, captionBounds: { x: visual.x, y: visual.y, width: visual.width, height: visual.height }, detectedBounds: cropRegion(viewport, visual, visual.kind), cropBounds: null, extractionStatus: 'crop-failed', reviewStatus: 'needs-review', extractionError: 'PDF 页面解析失败：' + message }));
  } finally { pageCanvas.width = 0; pageCanvas.height = 0; }
}

function selectionStorageKey(document: PDFDocumentProxy, documentKey?: string | null) {
  const identity = document.fingerprints?.[0] || documentKey;
  if (!identity) throw new Error('无法识别当前 PDF，暂不能保存选区。');
  return 'cbct-visual-selections:v1:' + identity;
}
function validSelection(value: unknown, pages: number): value is VisualSelection {
  if (!value || typeof value !== 'object') return false;
  const s = value as VisualSelection, b = s.bounds;
  return typeof s.id === 'string' && s.id.length < 160 && typeof s.caption === 'string' && s.caption.length < 4000
    && Number.isInteger(s.page) && s.page >= 1 && s.page <= pages && ['figure', 'table'].includes(s.kind)
    && ['motivation', 'method', 'experiment', 'results', 'reproduction'].includes(s.suggestedStep)
    && !!b && [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.x >= 0 && b.y >= 0 && b.width > 0.005 && b.height > 0.005 && b.x + b.width <= 1.00001 && b.y + b.height <= 1.00001;
}
async function renderSelections(page: PDFPageProxy, selections: VisualSelection[]): Promise<PaperVisual[]> {
  if (!selections.length) return [];
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(5, 12000 / Math.max(viewport.width, viewport.height), Math.sqrt(36_000_000 / (viewport.width * viewport.height)));
  const canvas = window.document.createElement('canvas');
  const scaled = page.getViewport({ scale }); canvas.width = Math.ceil(scaled.width); canvas.height = Math.ceil(scaled.height);
  const urls: string[] = [];
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法创建原页裁切画布');
    await page.render({ canvasContext: context, viewport: scaled }).promise;
    const result: PaperVisual[] = [];
    for (const s of selections) {
      const bounds = { x: s.bounds.x * viewport.width, y: s.bounds.y * viewport.height, width: s.bounds.width * viewport.width, height: s.bounds.height * viewport.height };
      const url = await cropCanvasURL(canvas, bounds, scale); urls.push(url);
      result.push({ id: s.id, kind: s.kind, page: s.page, caption: s.caption, suggestedStep: s.suggestedStep, imageURL: url, debugImageURL: null, sourcePDFURL: null, captionBounds: null, detectedBounds: bounds, cropBounds: bounds, extractionStatus: 'ready', reviewStatus: 'manual' });
    }
    return result;
  } catch (cause) { urls.forEach((url) => URL.revokeObjectURL(url)); throw cause; }
  finally { canvas.width = 0; canvas.height = 0; }
}

export function usePaperVisuals(document: PDFDocumentProxy | null, enabled: boolean, documentKey?: string | null) {
  const [visuals, setVisuals] = useState<PaperVisual[]>([]);
  const [progress, setProgress] = useState<PaperVisualProgress | null>(null);
  const [error, setError] = useState('');
  const [mentions, setMentions] = useState<VisualMention[]>([]);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const ignored = useRef(new Set<string>());
  const [revision, setRevision] = useState(0);
  const selections = useRef<VisualSelection[]>([]);
  const owned = useRef(new Set<string>());
  const epoch = useRef(0);
  const scanning = useRef(false);
  const editing = useRef(false);
  useEffect(() => {
    ++epoch.current;
    if (!document || !enabled) { setVisuals([]); setMentions([]); setIgnoredCount(0); setProgress(null); setError(''); return; }
    let cancelled = false;
    const urls = new Set<string>(); owned.current = urls;
    scanning.current = true;
    selections.current = [];
    ignored.current = new Set();
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(selectionStorageKey(document, documentKey)) || '[]');
      if (Array.isArray(raw)) selections.current = raw.filter((v) => validSelection(v, document.numPages));
      const dismissed: unknown = JSON.parse(localStorage.getItem(selectionStorageKey(document, documentKey) + ':ignored') || '[]');
      if (Array.isArray(dismissed)) ignored.current = new Set(dismissed.filter((v): v is string => typeof v === 'string' && v.length < 160));
    } catch { /* Automatic detection remains available when local storage is unavailable. */ }
    setIgnoredCount(ignored.current.size);
    setVisuals([]);
    setMentions([]);
    setError('');
    setProgress({ page: 0, total: document.numPages, phase: 'detecting', detected: 0, failed: 0 });
    void (async () => {
      try {
        const all: PaperVisual[] = [];
        const mentioned = new Map<string, VisualMention>();
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          if (cancelled) return;
          setProgress({ page: pageNumber, total: document.numPages, phase: 'detecting', detected: all.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
          let page: PDFPageProxy;
          let captions: ReturnType<typeof findCaptions>;
          try {
            page = await document.getPage(pageNumber);
            const text = await page.getTextContent();
            if (cancelled) return;
            captions = findCaptions(page, text);
            for (const mention of mentionsFromText(text, pageNumber)) {
              const key = mention.kind + ':' + mention.label, existing = mentioned.get(key);
              if (existing) { if (!existing.pages.includes(pageNumber)) existing.pages.push(pageNumber); }
              else mentioned.set(key, mention);
            }
            setMentions([...mentioned.values()].map((m) => ({ ...m, pages: [...m.pages] })));
          } catch (cause) {
            if (!cancelled) setError((current) => [current, `第 ${pageNumber} 页图表检测失败：${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n'));
            continue;
          }
          try {
            const viewport = page.getViewport({ scale: 1 });
            const graphics = await graphicObjectBounds(page, viewport);
            captions = associateGraphicObjects(graphics, captions, viewport);
          } catch { /* Caption-based detection remains usable when the PDF has no readable image operators. */ }
          if (cancelled) return;
          setProgress({ page: pageNumber, total: document.numPages, phase: 'extracting', detected: all.length + captions.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
          const crops = await renderPageCrops(page, captions);
          for (const item of crops) { if (item.imageURL) urls.add(item.imageURL); if (item.debugImageURL) urls.add(item.debugImageURL); }
          const selected = selections.current.filter((s) => s.page === pageNumber);
          let manual: PaperVisual[] = [];
          try { manual = await renderSelections(page, selected); }
          catch (cause) { if (!cancelled) setError((value) => value + '\n已保存的手动选区载入失败：' + String(cause)); }
          for (const item of manual) if (item.imageURL) urls.add(item.imageURL);
          if (cancelled) {
            urls.forEach((url) => URL.revokeObjectURL(url));
            return;
          }
          all.push(...crops.filter((item) => !manual.some((m) => m.id === item.id) && !ignored.current.has(item.id)), ...manual.filter((item) => !ignored.current.has(item.id)));
          const fingerprint = document.fingerprints?.[0];
          if (fingerprint) {
            try {
              window.localStorage.setItem(`cbct-visual-detections:${fingerprint}`, JSON.stringify(all.map(({ id, kind, page, caption, captionBounds, detectedBounds, cropBounds, extractionStatus }) => ({ id, kind, page, caption, captionBounds, detectedBounds, cropBounds, extractionStatus }))));
            } catch { /* Detection results remain available in memory if storage is unavailable. */ }
          }
          setVisuals([...all]);
          setProgress({ page: pageNumber, total: document.numPages, phase: 'detecting', detected: all.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
        }
        if (!cancelled && all.length) {
          setProgress({ page: document.numPages, total: document.numPages, phase: 'source-pdf', detected: all.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
          try {
            const bytes = await document.getData();
            if (cancelled) return;
            const pdfURL = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: 'application/pdf' }));
            urls.add(pdfURL);
            const withSource = all.map((item) => ({ ...item, sourcePDFURL: pdfURL }));
            setVisuals(withSource);
          } catch { /* Keep the high-resolution rendered export when source bytes are unavailable. */ }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) { scanning.current = false; setProgress(null); }
      }
    })();
    return () => {
      cancelled = true;
      ++epoch.current;
      scanning.current = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [document, enabled, documentKey, revision]);
  const saveSelection = async (selection: VisualSelection) => {
    if (!document || scanning.current || editing.current) throw new Error('请等待当前识别或校正完成。');
    if (!validSelection(selection, document.numPages)) throw new Error('选区无效，请框选完整图表区域。');
    const currentEpoch = epoch.current; editing.current = true;
    let rendered: PaperVisual[] = [];
    try {
      rendered = await renderSelections(await document.getPage(selection.page), [selection]);
      if (epoch.current !== currentEpoch) throw new Error('文献已切换，请在当前文献重新框选。');
      const next = [...selections.current.filter((s) => s.id !== selection.id), selection];
      localStorage.setItem(selectionStorageKey(document, documentKey), JSON.stringify(next));
      selections.current = next;
      rendered.forEach((item) => { if (item.imageURL) owned.current.add(item.imageURL); });
      setVisuals((current) => {
        const old = current.find((item) => item.id === selection.id);
        const sourcePDFURL = current.find((item) => item.sourcePDFURL)?.sourcePDFURL ?? null;
        if (old?.imageURL) { URL.revokeObjectURL(old.imageURL); owned.current.delete(old.imageURL); }
        return [...current.filter((item) => item.id !== selection.id), ...rendered.map((item) => ({ ...item, captionBounds: old?.captionBounds ?? null, sourcePDFURL }))].sort((a, b) => a.page - b.page || a.detectedBounds.y - b.detectedBounds.y);
      });
    } catch (cause) { rendered.forEach((item) => { if (item.imageURL) URL.revokeObjectURL(item.imageURL); }); throw cause; }
    finally { editing.current = false; }
  };
  const resetSelection = (id: string) => {
    if (!document || scanning.current || editing.current) return;
    const next = selections.current.filter((s) => s.id !== id);
    try { localStorage.setItem(selectionStorageKey(document, documentKey), JSON.stringify(next)); selections.current = next; setRevision((v) => v + 1); }
    catch { setError('无法移除本机选区，请确认本机存储可用。'); }
  };
  const dismissVisual = (id: string) => {
    if (!document || scanning.current || editing.current) return;
    try {
      const next = new Set([...ignored.current, id]);
      localStorage.setItem(selectionStorageKey(document, documentKey) + ':ignored', JSON.stringify([...next]));
      ignored.current = next; setIgnoredCount(next.size); setVisuals((current) => current.filter((item) => item.id !== id));
    } catch { setError('未能保存忽略设置，候选仍予以保留。'); }
  };
  const restoreIgnored = () => {
    if (!document || scanning.current || editing.current) return;
    try { localStorage.setItem(selectionStorageKey(document, documentKey) + ':ignored', '[]'); ignored.current = new Set(); setIgnoredCount(0); setRevision((v) => v + 1); }
    catch { setError('无法恢复被忽略的候选，请确认本机存储可用。'); }
  };
  const located = new Set(visuals.map((v) => { const m = normalizeCaptionText(v.caption).match(CAPTION_LABEL); return m ? v.kind + ':' + visualNumber(m[2] || '') : ''; }));
  const unlocated = mentions.filter((mention) => !located.has(mention.kind + ':' + mention.label));
  return { visuals, progress, error, unlocated, ignoredCount, dismissVisual, restoreIgnored, saveSelection, resetSelection, redetect: () => { if (!scanning.current && !editing.current) setRevision((v) => v + 1); } };
}
