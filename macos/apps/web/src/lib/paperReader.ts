import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { GenerateProgress, ReadingGenerationInput } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { prepareReadingVisuals } from './readingVisuals';

export async function preparePaperReading(_key: string, pdf: PDFDocumentProxy | null, visuals: PaperVisual[], textOnly: boolean, signal: AbortSignal, report: (value: GenerateProgress) => void): Promise<ReadingGenerationInput> {
  const input: ReadingGenerationInput = { workflow: 'paper-reader', visuals: [] };
  if (!textOnly && pdf) {
    input.fingerprint = pdf.fingerprints[0] ?? '';
    if (!input.fingerprint) throw new Error('PDF 文档指纹不可用，请重新打开论文');
    input.pageCount = pdf.numPages;
    signal.throwIfAborted();
    report({ percent: 8, message: '复用导入时准备的论文记忆' });
    let encodedSize = 0;
    for (const visual of visuals) {
      signal.throwIfAborted();
      if (visual.extractionStatus !== 'ready' || visual.reviewStatus === 'needs-review') {
        // A missing or manually unreviewed crop must not mark every workbook
        // section as incomplete. The section can still be generated from text.
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
      }
    }
  }
  return input;
}
