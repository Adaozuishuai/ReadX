import type { PDFLayout } from '@cbct/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api } from './client';

// Nearby visible pages share completed layouts and in-flight requests. The PDF
// document owns the cache, so changing the selected page does not clear it.
const layouts = new WeakMap<PDFDocumentProxy, Map<number, Promise<PDFLayout | null>>>();

export function loadPDFParagraphLayout(document: PDFDocumentProxy, key: string, page: number): Promise<PDFLayout | null> {
  let pages = layouts.get(document);
  if (!pages) { pages = new Map(); layouts.set(document, pages); }
  const cached = pages.get(page);
  if (cached) return cached;
  const cache = pages;
  // Requests are shared by the current-page panel and the continuous canvas;
  // changing one consumer's page must not cancel another visible page's load.
  const pending = api.paragraphs(key, page).then((result): PDFLayout | null => {
    if (!result.available) { cache.delete(page); return null; }
    return {
      width: result.width,
      height: result.height,
      blocks: result.blocks.map((block) => ({
        text: block.text,
        x: block.box[0], y: block.box[1],
        width: Math.max(0, block.box[2] - block.box[0]),
        height: Math.max(0, block.box[3] - block.box[1]),
        fontSize: Math.max(8, (block.box[3] - block.box[1]) * 0.8),
      })),
      visuals: (result.visuals ?? []).map((block) => ({
        text: block.text,
        x: block.box[0], y: block.box[1],
        width: Math.max(0, block.box[2] - block.box[0]),
        height: Math.max(0, block.box[3] - block.box[1]),
        kind: block.kind,
        label: block.text || (block.kind === 'table' ? 'OCR 表格' : block.kind === 'formula' ? 'OCR 公式' : 'OCR 图片'),
      })),
    };
  }).catch((error: unknown) => { cache.delete(page); throw error; });
  cache.set(page, pending);
  return pending;
}
