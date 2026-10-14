// PDF 页面光栅化（渲染进程内，用 pdfjs + canvas）——为公式/图片的视觉转写提供页面截图。
//
// 为什么放在渲染进程：主进程没有 canvas；pdfjs 需要 DOM canvas 才能渲染页面。
// 输出 JPEG dataURL（长边压到 1800px，避免数 MB 负载被视觉接口拒收），
// 再交主进程调用兼容 API 的视觉输入。

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

// 让 pdfjs 用随包分发的 worker（copy-static.js 会把 pdf.worker.min.mjs 拷到 dist/renderer，
// 与 app.js 同级；CSP worker-src 'self' 允许同源 worker）。
let workerReady = false;
export function ensureWorker(): void {
  if (workerReady) return;
  const url = new URL('pdf.worker.min.mjs', document.baseURI).toString();
  (pdfjs as any).GlobalWorkerOptions.workerSrc = url;
  workerReady = true;
}

export interface RasterResult { dataURL: string; width: number; height: number }

/**
 * 把 PDF 的第 pageNumber 页渲染为 JPEG dataURL。
 * @param bytes PDF 字节；@param pageNumber 1-based；@param maxEdge 长边上限（默认 1800）
 */
export async function rasterizePage(bytes: Uint8Array, pageNumber: number, maxEdge = 1800): Promise<RasterResult> {
  ensureWorker();
  const doc = await (pdfjs as any).getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true }).promise;
  try {
    if (pageNumber < 1 || pageNumber > doc.numPages) throw new Error(`页码 ${pageNumber} 超出范围（共 ${doc.numPages} 页）`);
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    // 缩放：让长边接近 maxEdge，但不超过；同时放大低分辨率页以便 OCR
    const scale = Math.min(Math.max(maxEdge / Math.max(base.width, base.height), 1), 4);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { dataURL: canvas.toDataURL('image/jpeg', 0.85), width: canvas.width, height: canvas.height };
  } finally {
    await doc.destroy?.();
  }
}

/** 页数（用于 UI 选择）。 */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  ensureWorker();
  const doc = await (pdfjs as any).getDocument({ data: bytes, isEvalSupported: false }).promise;
  try { return doc.numPages; } finally { await doc.destroy?.(); }
}
