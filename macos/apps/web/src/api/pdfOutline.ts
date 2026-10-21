import { detectPaperHeadings, type PaperHeading } from '@cbct/shared';
import type { PDFPageProxy, TextContent } from 'pdfjs-dist/types/src/display/api';

export function headingsFromPDFPage(page: PDFPageProxy, content: TextContent): PaperHeading[] {
  const viewport = page.getViewport({ scale: 1 });
  const rows: { text: string; x: number; y: number; width: number; height: number }[] = [];
  for (const item of content.items) {
    if (!('str' in item) || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = viewport.transform;
    const dx = a! * item.transform[0]! + c! * item.transform[1]!;
    const dy = b! * item.transform[0]! + d! * item.transform[1]!;
    if (Math.abs(dy) > Math.abs(dx) * 0.2) continue;
    const height = Math.hypot(item.transform[2]!, item.transform[3]!);
    const x = a! * item.transform[4]! + c! * item.transform[5]! + e!;
    const y = b! * item.transform[4]! + d! * item.transform[5]! + f! - height * 0.85;
    const row = rows.findLast((row) => Math.abs(row.y - y) < height * 0.35 && x >= row.x && x - (row.x + row.width) < height * 1.2);
    if (row) {
      row.text += (x - row.x - row.width > height * 0.1 ? ' ' : '') + item.str;
      row.width = Math.max(row.width, x + item.width - row.x);
      row.height = Math.max(row.height, height);
    } else rows.push({ text: item.str, x, y, width: item.width, height });
  }
  return detectPaperHeadings(rows.map((row) => ({ ...row, x: row.x / viewport.width })), page.pageNumber, viewport.height);
}
