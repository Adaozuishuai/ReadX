import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerURL;
export type PdfDoc = PDFDocumentProxy;

export async function openPdf(data: Uint8Array): Promise<PdfDoc> {
  return getDocument({ data: data.slice(), isEvalSupported: false }).promise;
}

export async function renderPdfPage(doc: PdfDoc, n: number, ctx: CanvasRenderingContext2D, width: number, height: number): Promise<void> {
  const page = await doc.getPage(n);
  const initial = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(width / initial.width, height / initial.height) });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;
}

export async function rasterizePdfImage(data: Uint8Array, n: number): Promise<CanvasImageSource> {
  const doc = await openPdf(data);
  try {
    const page = await doc.getPage(Math.max(1, Math.min(n, doc.numPages)));
    const initial = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(6, 2400 / Math.max(initial.width, initial.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    return canvas;
  } finally { void doc.destroy(); }
}
