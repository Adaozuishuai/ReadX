import { useEffect, useState } from 'react';
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
  imageURL: string;
}

interface TextRow { text: string; x: number; y: number; width: number; height: number }

function rowsFromPage(page: PDFPageProxy, content: TextContent): TextRow[] {
  const viewport = page.getViewport({ scale: 1 });
  const [a, b, c, d, e, f] = viewport.transform;
  const rows: TextRow[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [m0, m1, m2, m3, m4, m5] = item.transform;
    const dx = a! * m0! + c! * m1!;
    const dy = b! * m0! + d! * m1!;
    if (Math.abs(dy) > Math.abs(dx) * 0.2) continue;
    const height = Math.max(4, Math.hypot(m2!, m3!));
    const x = a! * m4! + c! * m5! + e!;
    const y = b! * m4! + d! * m5! + f! - height * 0.85;
    const row = rows.findLast((candidate) => Math.abs(candidate.y - y) < height * 0.35 && x >= candidate.x && x - (candidate.x + candidate.width) < height * 1.2);
    if (row) {
      row.text += (x - row.x - row.width > height * 0.1 ? ' ' : '') + item.str;
      row.width = Math.max(row.width, x + item.width - row.x);
      row.height = Math.max(row.height, height);
    } else rows.push({ text: item.str.trim(), x, y, width: item.width, height });
  }
  return rows.sort((left, right) => left.y - right.y || left.x - right.x);
}

function captionType(text: string): PaperVisualKind | null {
  if (/^(?:table|表)\s*[\divxlcdm一二三四五六七八九十]/i.test(text)) return 'table';
  if (/^(?:fig(?:ure)?\.?|图)\s*[\divxlcdm一二三四五六七八九十]/i.test(text)) return 'figure';
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

function findCaptions(page: PDFPageProxy, content: TextContent): (PaperVisualMetadata & { x: number; y: number; width: number; height: number })[] {
  const rows = rowsFromPage(page, content);
  const out: (PaperVisualMetadata & { x: number; y: number; width: number; height: number })[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const kind = captionType(row.text);
    if (!kind) continue;
    const lines = [row];
    for (let next = index + 1; next < rows.length && lines.length < 4; next++) {
      const candidate = rows[next]!;
      const previous = lines.at(-1)!;
      const gap = candidate.y - (previous.y + previous.height);
      if (gap > Math.max(5, previous.height * 0.65) || gap < -2) break;
      if (Math.abs(candidate.x - row.x) > Math.max(30, row.width * 0.2)) break;
      if (captionType(candidate.text)) break;
      lines.push(candidate);
    }
    const caption = lines.map((line) => line.text).join(' ').replace(/\s+/g, ' ').trim();
    const number = caption.match(/^(?:table|fig(?:ure)?\.?|图|表)\s*([\divxlcdm一二三四五六七八九十]+[a-z]?)/i)?.[1] ?? String(out.length + 1);
    const id = `${kind}-${page.pageNumber}-${number.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`;
    const endY = Math.max(...lines.map((line) => line.y + line.height));
    out.push({
      id, kind, page: page.pageNumber, caption,
      suggestedStep: suggestedStep(kind, caption),
      x: row.x, y: row.y, width: Math.max(...lines.map((line) => line.x + line.width)) - row.x,
      height: endY - row.y,
    });
    index += lines.length - 1;
  }
  return out;
}

function cropRegion(viewport: { width: number; height: number }, visual: { x: number; y: number; width: number; height: number }, kind: PaperVisualKind) {
  // Captions commonly occupy one column even when the figure itself spans the page.
  // Treat broad captions as full-width, otherwise preserve the column containing the caption.
  const fullWidth = visual.x < viewport.width * 0.16 && visual.x + visual.width > viewport.width * 0.84
    || visual.width > viewport.width * 0.58;
  const x = fullWidth ? 0 : visual.x + visual.width / 2 < viewport.width / 2 ? 0 : viewport.width / 2;
  const width = fullWidth ? viewport.width : viewport.width / 2;
  const context = viewport.height * 0.45;
  // Keep the caption for identification in the card, but crop it out of the image itself.
  const top = kind === 'figure' ? Math.max(0, visual.y - context) : Math.min(viewport.height, visual.y + visual.height + 6);
  const bottom = kind === 'figure'
    ? Math.max(top + 1, visual.y - 6)
    : Math.min(viewport.height, top + context);
  return { x, y: top, width, height: Math.max(1, bottom - top) };
}

function trimToCaptionAdjacentContent(
  pageCanvas: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
  visual: { y: number; height: number },
  kind: PaperVisualKind,
  scale: number,
) {
  const x = Math.max(0, Math.floor(crop.x * scale));
  const y = Math.max(0, Math.floor(crop.y * scale));
  const width = Math.min(pageCanvas.width - x, Math.ceil(crop.width * scale));
  const height = Math.min(pageCanvas.height - y, Math.ceil(crop.height * scale));
  const context = pageCanvas.getContext('2d');
  if (!context || width <= 0 || height <= 0) return crop;
  const pixels = context.getImageData(x, y, width, height).data;
  const columnStride = 4;
  const sampledWidth = Math.ceil(width / columnStride);
  const anchor = kind === 'figure'
    ? Math.max(0, Math.min(height - 1, Math.floor((visual.y - 8 - crop.y) * scale)))
    : Math.max(0, Math.min(height - 1, Math.floor((visual.y + visual.height + 8 - crop.y) * scale)));
  const direction = kind === 'figure' ? -1 : 1;
  let nearest = -1;
  let farthest = -1;
  let blankRows = 0;
  const blankGap = Math.max(12, scale * 4);
  for (let row = anchor; row >= 0 && row < height; row += direction) {
    let ink = 0;
    const offset = row * width * 4;
    for (let column = 0; column < width; column += columnStride) {
      const pixel = offset + column * 4;
      if (pixels[pixel]! < 242 || pixels[pixel + 1]! < 242 || pixels[pixel + 2]! < 242) ink += 1;
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
  if (nearest < 0 || farthest < 0 || Math.abs(nearest - farthest) < scale * 8) return crop;
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

async function renderPageCrops(page: PDFPageProxy, visuals: ReturnType<typeof findCaptions>): Promise<PaperVisual[]> {
  if (!visuals.length) return [];
  const scale = 3;
  const viewport = page.getViewport({ scale: 1 });
  const highResolution = page.getViewport({ scale });
  const pageCanvas = window.document.createElement('canvas');
  pageCanvas.width = Math.ceil(highResolution.width);
  pageCanvas.height = Math.ceil(highResolution.height);
  const context = pageCanvas.getContext('2d');
  if (!context) throw new Error('无法创建高清图表画布');
  try {
    await page.render({ canvasContext: context, viewport: highResolution }).promise;
    const result: PaperVisual[] = [];
    for (const visual of visuals) {
      const crop = trimToCaptionAdjacentContent(pageCanvas, cropRegion(viewport, visual, visual.kind), visual, visual.kind, scale);
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(crop.width * scale));
      canvas.height = Math.max(1, Math.ceil(crop.height * scale));
      const cropContext = canvas.getContext('2d');
      if (!cropContext) continue;
      cropContext.drawImage(pageCanvas, crop.x * scale, crop.y * scale, crop.width * scale, crop.height * scale, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      result.push({ ...visual, imageURL: URL.createObjectURL(blob) });
      canvas.width = 0;
      canvas.height = 0;
    }
    return result;
  } finally {
    pageCanvas.width = 0;
    pageCanvas.height = 0;
  }
}

export function usePaperVisuals(document: PDFDocumentProxy | null, enabled: boolean) {
  const [visuals, setVisuals] = useState<PaperVisual[]>([]);
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!document || !enabled) return;
    let cancelled = false;
    const urls: string[] = [];
    setVisuals([]);
    setError('');
    setProgress({ page: 0, total: document.numPages });
    void (async () => {
      try {
        const all: PaperVisual[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
          const page = await document.getPage(pageNumber);
          const captions = findCaptions(page, await page.getTextContent());
          const crops = await renderPageCrops(page, captions);
          if (cancelled) {
            crops.forEach((item) => URL.revokeObjectURL(item.imageURL));
            return;
          }
          crops.forEach((item) => urls.push(item.imageURL));
          all.push(...crops);
          setVisuals([...all]);
          setProgress({ page: pageNumber, total: document.numPages });
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
