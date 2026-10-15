import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { layoutFromPDF } from './pdfLayout';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerURL;

export interface PDFMetadataHint {
  title: string;
  author: string;
  doi: string;
  arxiv: string;
  firstPage: string;
  source?: string;
  pages?: { page: number; text: string; segments: string[] }[];
}

/** Read the PDF info and first page for AI recognition before library import. */
export async function readPDFMetadata(file: File, signal?: AbortSignal, onProgress?: (page: number, total: number) => void): Promise<PDFMetadataHint> {
  const result: PDFMetadataHint = {
    title: '',
    author: '',
    doi: '',
    arxiv: '',
    firstPage: '',
  };
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return result;
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    isEvalSupported: false,
  });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await task.promise;
    try {
      const metadata = await pdf.getMetadata();
      const info = metadata.info as Record<string, unknown>;
      result.title = typeof info.Title === 'string' ? info.Title.trim() : '';
      result.author = typeof info.Author === 'string' ? info.Author.trim() : '';
    } catch {
      // Many papers omit the optional PDF info dictionary.
    }
    if (pdf.numPages > 0) {
      const content = await (await pdf.getPage(1)).getTextContent();
      result.firstPage = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
        .join('')
        .slice(0, 16000);
    }
    result.pages = [];
    onProgress?.(0, pdf.numPages);
    for (let page = 1; page <= pdf.numPages; page++) {
      signal?.throwIfAborted();
      const layout = await layoutFromPDF(pdf, page);
      const segments = layout.blocks.map((block) => block.text);
      const raw = await (await pdf.getPage(page)).getTextContent();
      const text = raw.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      result.pages.push({ page, text, segments });
      onProgress?.(page, pdf.numPages);
    }
    return result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
