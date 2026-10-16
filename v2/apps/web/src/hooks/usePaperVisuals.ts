import { useEffect, useState } from 'react';
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
}

export interface VisualBounds { x: number; y: number; width: number; height: number }
export interface PaperVisualProgress { page: number; total: number; phase: 'detecting' | 'extracting' | 'source-pdf'; detected: number; failed: number }

interface TextRow { text: string; x: number; y: number; width: number; height: number }

const CAPTION_LABEL = /^(?:(?:supplementary|extended\s+data|appendix)\s+)?(tables?|figures?|figs?\.?|图|表)\s*[.．:：、]?\s*([a-z]?\s*\d+(?:\.\d+)*(?:[a-z]|\s*\([a-z0-9]+\))?|[ivxlcdm]+|[一二三四五六七八九十百]+)(?:\s*\([a-z0-9]+\))?/i;

function normalizeCaptionText(text: string) {
  return text.replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, ' ').replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ').trim();
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
  const label = normalizeCaptionText(text).match(CAPTION_LABEL)?.[1]?.toLowerCase().replace(/\.$/, '');
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

type VisualCandidate = PaperVisualMetadata & { x: number; y: number; width: number; height: number; imageBounds?: VisualBounds };

async function imageObjectBounds(page: PDFPageProxy, viewport: { transform: number[]; width: number; height: number }): Promise<VisualBounds[]> {
  const operators = await page.getOperatorList();
  const stack: number[][] = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const bounds: VisualBounds[] = [];
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index];
    const args = operators.argsArray[index] as unknown[] | undefined;
    if (op === OPS.save) stack.push(transform);
    else if (op === OPS.restore) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === OPS.transform && args?.length && Array.isArray(args[0])) transform = Util.transform(transform, args[0] as number[]);
    else if (op === OPS.paintFormXObjectBegin && args?.length && Array.isArray(args[0])) {
      stack.push(transform);
      transform = Util.transform(transform, args[0] as number[]);
    } else if (op === OPS.paintFormXObjectEnd) transform = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    if (op === undefined || !imageOps.has(op)) continue;
    const matrix = Util.transform(viewport.transform, transform);
    const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map((point) => Util.applyTransform(point, matrix));
    const xs = corners.map((point) => point[0]!);
    const ys = corners.map((point) => point[1]!);
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    const right = Math.min(viewport.width, Math.max(...xs));
    const bottom = Math.min(viewport.height, Math.max(...ys));
    const candidate = { x, y, width: right - x, height: bottom - y };
    if (candidate.width >= 48 && candidate.height >= 36 && candidate.width * candidate.height >= viewport.width * viewport.height * 0.004
      && candidate.width * candidate.height <= viewport.width * viewport.height * 0.82) bounds.push(candidate);
  }
  // Merge overlapping/touching raster tiles (common in scanned charts) into
  // one original-image region before associating it with a nearby caption.
  const merged: VisualBounds[] = [];
  for (const bound of bounds) {
    const touching = merged.findIndex((item) => bound.x <= item.x + item.width + 8 && bound.x + bound.width >= item.x - 8
      && bound.y <= item.y + item.height + 8 && bound.y + bound.height >= item.y - 8);
    if (touching < 0) merged.push(bound);
    else {
      const item = merged[touching]!;
      const left = Math.min(item.x, bound.x);
      const top = Math.min(item.y, bound.y);
      const right = Math.max(item.x + item.width, bound.x + bound.width);
      const bottom = Math.max(item.y + item.height, bound.y + bound.height);
      merged[touching] = { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  return merged;
}

function uncaptionedImageCandidates(page: number, images: VisualBounds[], captions: VisualCandidate[]): VisualCandidate[] {
  const unmatched = images.filter((image) => !captions.some((caption) => {
    const gap = image.y + image.height < caption.y ? caption.y - (image.y + image.height) : caption.y + caption.height < image.y ? image.y - (caption.y + caption.height) : 0;
    const horizontalOverlap = Math.min(image.x + image.width, caption.x + caption.width) - Math.max(image.x, caption.x);
    return gap < 150 && horizontalOverlap > -24;
  }));
  return unmatched.map((image, index) => ({
    id: `figure-${page}-image-${index + 1}`, kind: 'figure', page,
    caption: `PDF 图像对象 · Page ${page}（未匹配到图注）`, suggestedStep: 'method',
    x: image.x, y: image.y, width: image.width, height: image.height, imageBounds: image,
  }));
}

function findCaptions(page: PDFPageProxy, content: TextContent): VisualCandidate[] {
  const rows = rowsFromPage(page, content);
  const out: (PaperVisualMetadata & { x: number; y: number; width: number; height: number })[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const kind = captionType(row.text);
    if (!kind) continue;
    const lines = [row];
    for (let next = index + 1; next < rows.length && lines.length < 8; next++) {
      const candidate = rows[next]!;
      const previous = lines.at(-1)!;
      const gap = candidate.y - (previous.y + previous.height);
      if (gap > Math.max(7, previous.height * 1.15) || gap < -2) break;
      // Caption continuations can be indented or reflowed, but should remain
      // close to the same text column. A new caption always starts a new item.
      if (Math.abs(candidate.x - row.x) > Math.max(42, Math.min(row.width * 0.4, 96))) break;
      if (captionType(candidate.text)) break;
      if (/^(?:\d+(?:\.\d+)*\s+)?(?:introduction|methods?|results?|discussion|conclusion|参考文献|引言|方法|结果|讨论|结论)\b/i.test(candidate.text)) break;
      lines.push(candidate);
    }
    const caption = normalizeCaptionText(lines.map((line) => line.text).join(' '));
    const number = caption.match(CAPTION_LABEL)?.[2]?.replace(/[\s()]/g, '') ?? String(out.length + 1);
    const baseId = `${kind}-${page.pageNumber}-${number.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`;
    const id = out.some((item) => item.id === baseId) ? `${baseId}-${out.length + 1}` : baseId;
    const endY = Math.max(...lines.map((line) => line.y + line.height));
    out.push({
      id, kind, page: page.pageNumber, caption,
      suggestedStep: suggestedStep(kind, caption),
      x: row.x, y: row.y, width: Math.max(...lines.map((line) => line.x + line.width)) - row.x,
      height: endY - row.y,
    });
    index += lines.length - 1;
  }
  // Merge adjacent Figure 4a/4b-style sibling captions into a single figure
  // region. This prevents multi-panel figures from being exported as fragments.
  const groups = new Map<string, VisualCandidate[]>();
  const consumed = new Set<string>();
  for (const item of out) {
    if (item.kind !== 'figure') continue;
    const number = item.caption.match(CAPTION_LABEL)?.[2]?.replace(/[\s()]/g, '') ?? '';
    const sibling = number.match(/^(\d+(?:\.\d+)*)([a-z])$/i);
    if (!sibling) continue;
    const key = `${item.page}:${sibling[1]!.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const merged: VisualCandidate[] = [];
  for (const [key, siblings] of groups) {
    if (siblings.length < 2) continue;
    const ids = siblings.map((item) => item.id);
    ids.forEach((id) => consumed.add(id));
    const left = Math.min(...siblings.map((item) => item.x));
    const top = Math.min(...siblings.map((item) => item.y));
    const right = Math.max(...siblings.map((item) => item.x + item.width));
    const bottom = Math.max(...siblings.map((item) => item.y + item.height));
    const caption = siblings.map((item) => item.caption).join(' · ');
    merged.push({
      id: `figure-${page.pageNumber}-${key.split(':')[1]}-group`, kind: 'figure', page: page.pageNumber, caption,
      suggestedStep: suggestedStep('figure', caption), x: left, y: top, width: right - left, height: bottom - top,
    });
  }
  return [...out.filter((item) => !consumed.has(item.id)), ...merged].sort((left, right) => left.y - right.y || left.x - right.x);
}

function cropRegion(viewport: { width: number; height: number }, visual: { x: number; y: number; width: number; height: number }, kind: PaperVisualKind, side: 'before' | 'after' = kind === 'figure' ? 'before' : 'after'): VisualBounds {
  // Captions commonly occupy one column even when the figure itself spans the page.
  // Treat broad captions as full-width, otherwise preserve the column containing the caption.
  const fullWidth = visual.x < viewport.width * 0.16 && visual.x + visual.width > viewport.width * 0.84
    || visual.width > viewport.width * 0.58;
  const x = fullWidth ? 0 : visual.x + visual.width / 2 < viewport.width / 2 ? 0 : viewport.width / 2;
  const width = fullWidth ? viewport.width : viewport.width / 2;
  // Tall figures and multi-panel charts often extend much farther than a
  // conventional half-page crop. The whitespace scan below tightens this band.
  const context = viewport.height * 0.68;
  // Keep the caption for identification in the card, but crop it out of the image itself.
  const top = side === 'before' ? Math.max(0, visual.y - context) : Math.min(viewport.height, visual.y + visual.height + 6);
  const bottom = side === 'before' ? Math.max(top + 1, visual.y - 6) : Math.min(viewport.height, top + context);
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
    const blankGap = Math.max(24, scale * (kind === 'table' ? 16 : 12));
    for (let row = anchor; row >= 0 && row < height; row += 1) {
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
      }
    }
    if (nearest < 0 || farthest < 0 || Math.abs(nearest - farthest) < scale * 4) return null;
    return { nearest, farthest };
  };
  const fine = scan(Math.max(2, Math.round(scale * 0.55)), 246);
  const coarse = scan(Math.max(4, Math.round(scale * 1.5)), 238);
  if (!fine && !coarse) return null;
  const nearest = Math.min(fine?.nearest ?? Number.POSITIVE_INFINITY, coarse?.nearest ?? Number.POSITIVE_INFINITY);
  const farthest = Math.max(fine?.farthest ?? Number.NEGATIVE_INFINITY, coarse?.farthest ?? Number.NEGATIVE_INFINITY);
  const padding = scale * 2;
  const contentStart = Math.min(nearest, farthest);
  const contentEnd = Math.max(nearest, farthest);
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
    if (!visual.imageBounds) drawBounds({ x: visual.x, y: visual.y, width: visual.width, height: visual.height }, '#2188ff', 2);
    const detection = detections[index];
    if (detection) drawBounds(detection, '#ff8c00', 2);
    const crop = crops[index];
    if (crop) drawBounds(crop, '#12a150', 3);
  }
  try { return URL.createObjectURL(await canvasBlob(canvas)); }
  finally { canvas.width = 0; canvas.height = 0; }
}

async function renderPageCrops(page: PDFPageProxy, visuals: ReturnType<typeof findCaptions>): Promise<PaperVisual[]> {
  if (!visuals.length) return [];
  const viewport = page.getViewport({ scale: 1 });
  const scale = Math.min(5, 12000 / Math.max(viewport.width, viewport.height), Math.sqrt(36_000_000 / (viewport.width * viewport.height)));
  const highResolution = page.getViewport({ scale });
  const pageCanvas = window.document.createElement('canvas');
  pageCanvas.width = Math.ceil(highResolution.width);
  pageCanvas.height = Math.ceil(highResolution.height);
  const context = pageCanvas.getContext('2d');
  if (!context) return visuals.map((visual) => ({ ...visual, imageURL: null, debugImageURL: null, sourcePDFURL: null, captionBounds: visual.imageBounds ? null : { x: visual.x, y: visual.y, width: visual.width, height: visual.height }, detectedBounds: visual.imageBounds ?? cropRegion(viewport, visual, visual.kind), cropBounds: null, extractionStatus: 'crop-failed', extractionError: '无法创建高清图表画布' }));
  try {
    try {
      await page.render({ canvasContext: context, viewport: highResolution }).promise;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return visuals.map((visual) => ({ ...visual, imageURL: null, debugImageURL: null, sourcePDFURL: null, captionBounds: visual.imageBounds ? null : { x: visual.x, y: visual.y, width: visual.width, height: visual.height }, detectedBounds: visual.imageBounds ?? cropRegion(viewport, visual, visual.kind), cropBounds: null, extractionStatus: 'crop-failed', extractionError: `PDF 页面渲染失败：${message}` }));
    }
    const preferredSides = visuals.map((visual) => visual.kind === 'figure' ? 'before' as const : 'after' as const);
    const proposed = visuals.map((visual, index) => visual.imageBounds ?? cropRegion(viewport, visual, visual.kind, preferredSides[index]));
    const detections: (VisualBounds | null)[] = [];
    const crops: (VisualBounds | null)[] = [];
    const result: PaperVisual[] = [];
    for (let index = 0; index < visuals.length; index++) {
      const visual = visuals[index]!;
      const preferred = proposed[index]!;
      if (visual.imageBounds) {
        const bounds = visual.imageBounds;
        const padding = 8;
        const cropBounds = { x: Math.max(0, bounds.x - padding), y: Math.max(0, bounds.y - padding), width: Math.min(viewport.width, bounds.x + bounds.width + padding) - Math.max(0, bounds.x - padding), height: Math.min(viewport.height, bounds.y + bounds.height + padding) - Math.max(0, bounds.y - padding) };
        const imageCanvas = window.document.createElement('canvas');
        imageCanvas.width = Math.max(1, Math.ceil(cropBounds.width * scale));
        imageCanvas.height = Math.max(1, Math.ceil(cropBounds.height * scale));
        let imageURL: string | null = null;
        let extractionError: string | undefined;
        try {
          const imageContext = imageCanvas.getContext('2d');
          if (!imageContext) throw new Error('无法创建 PDF 图像对象导出画布');
          imageContext.drawImage(pageCanvas, cropBounds.x * scale, cropBounds.y * scale, cropBounds.width * scale, cropBounds.height * scale, 0, 0, imageCanvas.width, imageCanvas.height);
          imageURL = URL.createObjectURL(await canvasBlob(imageCanvas));
        } catch (cause) { extractionError = cause instanceof Error ? cause.message : String(cause); }
        finally { imageCanvas.width = 0; imageCanvas.height = 0; }
        detections.push(bounds);
        crops.push(cropBounds);
        result.push({ ...visual, imageURL, debugImageURL: null, sourcePDFURL: null, captionBounds: null, detectedBounds: bounds, cropBounds, extractionStatus: imageURL ? 'ready' : 'crop-failed', ...(extractionError ? { extractionError } : {}) });
        continue;
      }
      const alternate = cropRegion(viewport, visual, visual.kind, preferredSides[index] === 'before' ? 'after' : 'before');
      const preferredTrim = trimToCaptionAdjacentContent(pageCanvas, preferred, visual, visual.kind, preferredSides[index]!, scale);
      const alternateSide = preferredSides[index] === 'before' ? 'after' : 'before';
      const alternateTrim = trimToCaptionAdjacentContent(pageCanvas, alternate, visual, visual.kind, alternateSide, scale);
      const preferredScore = preferredTrim ? preferredTrim.height : 0;
      const alternateScore = alternateTrim ? alternateTrim.height * 0.82 : 0;
      const useAlternate = alternateScore > preferredScore;
      const detectedBounds = useAlternate ? alternate : preferred;
      const selectedCrop = (useAlternate ? alternateTrim : preferredTrim) ?? detectedBounds;
      let crop: VisualBounds | null = null;
      let imageURL: string | null = null;
      let extractionError: string | undefined;
      try {
        crop = selectedCrop;
        const canvas = window.document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(crop.width * scale));
        canvas.height = Math.max(1, Math.ceil(crop.height * scale));
        const cropContext = canvas.getContext('2d');
        if (!cropContext) throw new Error('无法创建图表裁剪画布');
        cropContext.drawImage(pageCanvas, crop.x * scale, crop.y * scale, crop.width * scale, crop.height * scale, 0, 0, canvas.width, canvas.height);
        imageURL = URL.createObjectURL(await canvasBlob(canvas));
        canvas.width = 0;
        canvas.height = 0;
      } catch (cause) {
        extractionError = cause instanceof Error ? cause.message : String(cause);
      }
      crops.push(crop);
      detections.push(detectedBounds);
      result.push({ ...visual, imageURL, debugImageURL: null, sourcePDFURL: null, captionBounds: visual.imageBounds ? null : { x: visual.x, y: visual.y, width: visual.width, height: visual.height }, detectedBounds, cropBounds: crop, extractionStatus: imageURL ? 'ready' : 'crop-failed', ...(extractionError ? { extractionError } : {}) });
    }
    const debugURL = await debugPageImage(pageCanvas, visuals, detections, crops, scale).catch(() => null);
    return result.map((item) => ({ ...item, debugImageURL: debugURL }));
  } finally {
    pageCanvas.width = 0;
    pageCanvas.height = 0;
  }
}

export function usePaperVisuals(document: PDFDocumentProxy | null, enabled: boolean) {
  const [visuals, setVisuals] = useState<PaperVisual[]>([]);
  const [progress, setProgress] = useState<PaperVisualProgress | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!document || !enabled) return;
    let cancelled = false;
    const urls: string[] = [];
    setVisuals([]);
    setError('');
    setProgress({ page: 0, total: document.numPages, phase: 'detecting', detected: 0, failed: 0 });
    void (async () => {
      try {
        const all: PaperVisual[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          setProgress({ page: pageNumber, total: document.numPages, phase: 'detecting', detected: all.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
          let page: PDFPageProxy;
          let captions: ReturnType<typeof findCaptions>;
          try {
            page = await document.getPage(pageNumber);
            captions = findCaptions(page, await page.getTextContent());
          } catch (cause) {
            if (!cancelled) setError((current) => [current, `第 ${pageNumber} 页图表检测失败：${cause instanceof Error ? cause.message : String(cause)}`].filter(Boolean).join('\n'));
            continue;
          }
          try {
            const viewport = page.getViewport({ scale: 1 });
            const images = await imageObjectBounds(page, viewport);
            captions = [...captions, ...uncaptionedImageCandidates(pageNumber, images, captions)];
          } catch { /* Caption-based detection remains usable when the PDF has no readable image operators. */ }
          setProgress({ page: pageNumber, total: document.numPages, phase: 'extracting', detected: all.length + captions.length, failed: all.filter((item) => item.extractionStatus === 'crop-failed').length });
          const crops = await renderPageCrops(page, captions);
          if (cancelled) {
            crops.forEach((item) => { if (item.imageURL) URL.revokeObjectURL(item.imageURL); if (item.debugImageURL) URL.revokeObjectURL(item.debugImageURL); });
            return;
          }
          crops.forEach((item) => { if (item.imageURL) urls.push(item.imageURL); if (item.debugImageURL && !urls.includes(item.debugImageURL)) urls.push(item.debugImageURL); });
          all.push(...crops);
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
            urls.push(pdfURL);
            const withSource = all.map((item) => ({ ...item, sourcePDFURL: pdfURL }));
            setVisuals(withSource);
          } catch { /* Keep the high-resolution rendered export when source bytes are unavailable. */ }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setProgress(null);
      }
    })();
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [document, enabled]);
  return { visuals, progress, error };
}
