// Adapted from realtime-tex-vsc-plugin/webview/main.ts (Henry Yang, MIT; see LICENSE).
import { cachedPictureMoves, type Rect, type OverlayRow } from './model';
import { inexactReason, Painter, type Mat } from './render';
import { renderPdfPage } from './pdf';
import type { LivePreview } from './live';

const PT = 65536;
function deviceRect(base: Mat, r: Rect): [number, number, number, number] {
  const x = Math.round(r.x * base[0]), y = Math.round(r.y * base[3]);
  return [x, y, Math.max(0, Math.round((r.x + r.w) * base[0]) - x), Math.max(0, Math.round((r.y + r.h) * base[3]) - y)];
}
function rowBands(rows: OverlayRow[]): [number, number, number, number][] {
  const result: [number, number, number, number][] = [];
  let previousBottom: number | undefined, previousBase = -Infinity;
  for (const { line, dx, dy } of rows) {
    const base = line.y + dy, ownTop = base - line.h - PT;
    const top = previousBottom !== undefined && base > previousBase && base - previousBase < 4 * (line.h + line.d + 2*PT) ? Math.min(ownTop, previousBottom) : ownTop;
    const bottom = base + Math.max(line.d, 3*PT);
    result.push([line.x + dx - PT, top, line.x + dx + line.w + PT, bottom]);
    previousBottom = bottom; previousBase = base;
  }
  return result;
}

export async function drawLivePage(live: LivePreview, page: number, width: number, height: number, dpr: number) {
  const update = live.model.pages.get(page);
  if (!update) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width*dpr));
  canvas.height = Math.max(1, Math.round(height*dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / (update.dl.page_width || 39157760);
  const base: Mat = [scale, 0, 0, scale, 0, 0];
  const hidden = live.model.hiddenLines(page);
  const lines = update.dl.lines.filter((_, i) => !hidden.has(i));
  const reason = update.exact ? inexactReason(update.dl, live.fonts, live.images, lines) : '此页含复杂图形或排版指令';
  let fromPdf = Boolean(reason && live.pdf && page <= live.pdf.numPages && live.pdfSerial >= (live.pagePdfSerial.get(page) ?? Infinity));
  const overlays = live.model.overlaysOn(page);
  const pictures: { img: ImageData; dst: Rect }[] = [];
  const drawList = () => {
    const painter = new Painter(ctx, base, live.fonts, live.images);
    painter.draw(update.dl, update.dl.other ?? []);
    for (const line of lines) painter.draw(update.dl, line.items);
  };
  if (fromPdf && live.pdf) {
    try {
      await renderPdfPage(live.pdf, page, ctx, canvas.width, canvas.height);
      for (const { overlay, rows } of overlays) {
        for (const { src, dst } of cachedPictureMoves(update.dl, rows, live.model.ownLines(page, overlay.parId))) {
          const [x,y,w,h] = deviceRect(base, src);
          if (w > 0 && h > 0 && x+w > 0 && y+h > 0 && x < canvas.width && y < canvas.height) pictures.push({ img: ctx.getImageData(x,y,w,h), dst });
        }
      }
      new Painter(ctx, base, live.fonts, live.images).clearLines(update.dl.lines.filter((_, i) => hidden.has(i)).map(line => ({ line, dx: 0, dy: 0 })), '#fff');
    } catch {
      fromPdf = false;
      ctx.setTransform(1,0,0,1,0,0); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      drawList();
    }
  } else drawList();
  const painters = overlays.map(() => new Painter(ctx, base, live.fonts, live.images));
  overlays.forEach(({ rows }, i) => painters[i]!.clearRects(rowBands(rows), '#fff'));
  for (const { img, dst } of pictures) { const [x,y] = deviceRect(base,dst); ctx.putImageData(img,x,y); }
  overlays.forEach(({ overlay, rows }, i) => {
    painters[i]!.draw(overlay.dl, overlay.dl.other ?? []);
    for (const row of rows) painters[i]!.draw(overlay.dl, row.line.items, row.dx, row.dy);
  });
  return { canvas, badge: fromPdf ? 'PDF 整页 + 实时段落' : reason ? '近似预览' : '', reason: reason || '' };
}
