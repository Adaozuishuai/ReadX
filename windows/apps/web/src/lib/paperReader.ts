import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { api, type GenerateProgress, type ReadingGenerationInput } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { prepareReadingVisuals } from './readingVisuals';

// The large text/LaTeX artifact is ordinary Markdown. Only transport metadata
// is serialized by the application; the model does not have to escape JSON.
async function renderPageView(page: PDFPageProxy, top: number, height: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, 2048 / Math.max(base.width, base.height * height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height * height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法读取 PDF 原页图像');
  const task = page.render({ canvasContext: context, viewport, transform: [1, 0, 0, 1, 0, -viewport.height * top], background: '#ffffff' });
  const abort = () => task.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await task.promise;
    signal.throwIfAborted();
    const image = canvas.toDataURL('image/png').split(',')[1]!;
    if (image.length > Math.ceil((8 << 20) * 4 / 3)) throw new Error('原页图像超过容量');
    return image;
  } finally {
    signal.removeEventListener('abort', abort);
    canvas.width = 0; canvas.height = 0;
  }
}

export async function preparePaperReading(key: string, pdf: PDFDocumentProxy | null, visuals: PaperVisual[], textOnly: boolean, signal: AbortSignal, report: (value: GenerateProgress) => void): Promise<ReadingGenerationInput> {
  const input: ReadingGenerationInput = { workflow: 'paper-reader', visuals: [] };
  if (!textOnly && pdf) {
    input.fingerprint = pdf.fingerprints[0] ?? '';
    if (!input.fingerprint) throw new Error('PDF 文档指纹不可用，请重新打开论文');
    input.pageCount = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      signal.throwIfAborted();
      const body = { key, page: pageNumber, fingerprint: input.fingerprint };
      report({ percent: Math.min(35, 3 + Math.round(pageNumber * 32 / pdf.numPages)), message: `通读原页与复核公式 · Page ${pageNumber} / ${pdf.numPages}` });
      try {
        const cached = await api.readPaperPage({ ...body, cachedOnly: true }, signal);
        if (cached.ready) continue;
        const page = await pdf.getPage(pageNumber);
        // Overlapping enlarged views preserve equations crossing the midline.
        const images = [];
        for (const [top, height] of [[0, 1], [0, 0.56], [0.44, 0.56]]) images.push(await renderPageView(page, top!, height!, signal));
        await api.readPaperPage({ ...body, images }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        // A single unreadable page does not discard the rest. The server sees
        // exactly which page caches are missing and limits the affected claims.
        report({ percent: Math.min(35, 3 + Math.round(pageNumber * 32 / pdf.numPages)), message: `Page ${pageNumber} 原页阅读暂未完成，继续读取后续页面` });
      }
    }
    input.unavailableVisuals = [];
    let encodedSize = 0;
    for (const visual of visuals) {
      signal.throwIfAborted();
      if (visual.extractionStatus !== 'ready' || visual.reviewStatus === 'needs-review') {
        input.unavailableVisuals.push(`Page ${visual.page} 的「${visual.caption.slice(0, 120)}」尚无完整、可用的原图选区`);
        continue;
      }
      try {
        const [reference] = await prepareReadingVisuals([visual], signal, () => report({ percent: 37, message: `正在准备正文原图 · Page ${visual.page}` }));
        if (!reference) continue;
        if (input.visuals.length >= 256 || encodedSize + reference.imagePNG.length > (60 << 20)) throw new Error('原图附件超过单次容量');
        input.visuals.push(reference);
        encodedSize += reference.imagePNG.length;
      } catch (error) {
        if (signal.aborted) throw error;
        input.unavailableVisuals.push(`Page ${visual.page} 的「${visual.caption.slice(0, 120)}」原图暂未附入正文`);
      }
    }
    if (input.unavailableVisuals.length > 256) input.unavailableVisuals = [...input.unavailableVisuals.slice(0, 255), `另有 ${input.unavailableVisuals.length - 255} 张原图尚未附入正文`];
  }
  return input;
}
