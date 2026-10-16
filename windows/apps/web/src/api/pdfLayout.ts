import { buildPDFLayout, type PDFLayout } from '@cbct/shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';

export async function layoutFromPDF(document: PDFDocumentProxy, page: number): Promise<PDFLayout> {
  const pdfPage = await document.getPage(page);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const content = await pdfPage.getTextContent();
  const items = content.items.flatMap((item) => {
    if (!('str' in item) || !item.str.trim()) return [];
    const [a, b, c, d, e, f] = viewport.transform;
    const dx = a! * item.transform[0]! + c! * item.transform[1]!;
    const dy = b! * item.transform[0]! + d! * item.transform[1]!;
    // Preserve rotated marginal identifiers on the canvas instead of turning them
    // into a horizontal paragraph across the middle of the translated page.
    if (Math.abs(dy) > Math.abs(dx) * 0.2) return [];
    const x = a! * item.transform[4]! + c! * item.transform[5]! + e!;
    const baseline = b! * item.transform[4]! + d! * item.transform[5]! + f!;
    const fontHeight = Math.hypot(item.transform[2]!, item.transform[3]!);
    const font = content.styles[item.fontName];
    const hasMetrics = (font?.ascent ?? 0) > 0;
    const ascent = hasMetrics ? font!.ascent : 0.9;
    const descent = hasMetrics ? (font!.descent ?? -0.2) : -0.2;
    return [{ text: item.str, x, y: baseline - fontHeight * ascent, width: item.width, height: fontHeight * (ascent - descent), textFontSize: fontHeight }];
  });
  const layout = buildPDFLayout(viewport.width, viewport.height, items);
  layout.ornaments = items.filter(item => /^[A-Z]$/.test(item.text) && layout.blocks.some(block =>
    block.text.length > 60 && /^[a-z]/.test(block.text) &&
    item.textFontSize > (block.textFontSize ?? block.fontSize) * 2 &&
    Math.abs(item.y - block.y) < block.fontSize &&
    block.x - item.x - item.width >= -1 && block.x - item.x - item.width < block.fontSize * .8));
  return layout;
}
