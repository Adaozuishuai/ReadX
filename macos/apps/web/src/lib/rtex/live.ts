import { PreviewModel } from './model';
import { FontStore, ImageStore } from './render';
import { openPdf, rasterizePdfImage, type PdfDoc } from './pdf';
import { decodeBase64, type RealtimeEvent } from './wire';
import type { Diagnostic } from './protocol';

/** One preview's state; React receives a revision notification after each engine update. */
export class LivePreview {
  readonly model = new PreviewModel();
  readonly fonts = new FontStore();
  readonly images = new ImageStore(rasterizePdfImage);
  readonly diagnostics = new Map<string, Diagnostic[]>();
  readonly pagePdfSerial = new Map<number, number>();
  readonly pageRevisions = new Map<number, number>();
  pdf?: PdfDoc;
  pdfSerial = 0;
  private serial = 0;
  private disposed = false;
  private revision = 0;
  status = '正在启动实时排版…';
  error = '';
  timing?: number;
  pending = true;
  changed: () => void = () => {};

  constructor() { this.images.onLoaded = () => this.invalidate(this.model.pages.keys()); }

  invalidate(pages: Iterable<number>) {
    if (this.disposed) return;
    for (const page of pages) this.pageRevisions.set(page, ++this.revision);
    this.changed();
  }

  receive(event: RealtimeEvent) {
    if (this.disposed) return;
    if ('reply' in event) {
      if (event.reply === 'error') { this.error = event.message; this.changed(); }
      return;
    }
    switch (event.event) {
      case 'ReadXResources':
        for (const [key, resource] of event.fonts) this.fonts.add(key, resource.kind === 'sfnt' ? { kind: 'sfnt', data: decodeBase64(resource.dataBase64) } : resource);
        for (const [key, resource] of event.images) this.images.add(key, resource.kind === 'missing' ? resource : { kind: resource.kind, mime: resource.mime, data: decodeBase64(resource.dataBase64) });
        this.invalidate(this.model.pages.keys());
        return;
      case 'ParagraphUpdate': {
        if (event.status === 'error') { this.diagnostics.set(`paragraph:${event.par_id}`, event.diagnostics); break; }
        this.diagnostics.set(`paragraph:${event.par_id}`, event.diagnostics ?? []);
        this.timing = event.timing.total_us / 1000;
        const missingFont = Object.values(event.dl.fonts ?? {}).some(desc => this.fonts.get(desc)?.kind === 'missing');
        const missingImage = Object.values(event.dl.images_info ?? {}).some(info => this.images.get(info.file)?.kind === 'missing');
        if (missingFont || missingImage) {
          this.pending = true;
          this.status = '此段落正在通过整页排版更新…';
          this.invalidate(this.model.dropOverlays([event.par_id]));
          return;
        }
        this.pending = event.pagination_stale || event.context_stale;
        this.status = this.pending ? '段落已更新，正在刷新整页…' : '实时段落已更新';
        this.invalidate(this.model.applyParagraph(event.par_id, event.dl, event.status === 'removed' ? [] : event.fragments, event.versions.source_revision));
        return;
      }
      case 'LayoutUpdate': {
        this.pending = event.convergence.state === 'Stale' || event.convergence.state === 'Converging';
        if (event.compile.state === 'Failed') {
          this.error = '整页排版失败，保留上次预览。' + ('reasons' in event.convergence ? event.convergence.reasons.join('\n') : '请查看下方 LaTeX 诊断。');
          this.status = '排版失败';
          break;
        }
        this.error = '';
        this.status = event.compile.state === 'CompiledWithErrors' ? '整页已更新，存在 LaTeX 错误'
          : this.pending ? '正在更新分页与引用…' : event.convergence.state === 'PassLimitReached' ? '整页已更新，引用尚未收敛' : '整页已同步';
        const dirty = this.model.applyLayout({ pages: event.pages_changed, pagesTotal: event.pages_total, placements: event.placements,
          keepFromRevision: event.convergence.state === 'Stale' ? event.convergence.pending_since : null });
        if (event.convergence.state !== 'Stale') {
          for (const key of this.diagnostics.keys()) if (key.startsWith('paragraph:')) this.diagnostics.delete(key);
        }
        const serial = event.pdfBase64 ? ++this.serial : this.serial;
        for (const page of event.pages_changed) this.pagePdfSerial.set(page.page, event.pdfBase64 ? serial : Infinity);
        if (event.pdfBase64) void openPdf(decodeBase64(event.pdfBase64)).then(doc => {
          if (this.disposed || serial !== this.serial) { void doc.destroy(); return; }
          const old = this.pdf;
          this.pdf = doc;
          this.pdfSerial = serial;
          void old?.destroy();
          this.invalidate(this.model.pages.keys());
        }).catch(error => { if (!this.disposed && serial === this.serial) { this.error = `PDF 预览加载失败：${String(error)}`; this.changed(); } });
        this.invalidate(dirty);
        return;
      }
      case 'Diagnostics': this.diagnostics.set(event.source, event.items); break;
      case 'BackgroundScheduled': this.pending = true; this.status = '正在后台更新整页…'; break;
      case 'EngineState':
        if (event.state === 'Failed') this.error = event.reason || '实时排版引擎启动失败';
        else if (event.state === 'Starting' || event.state === 'Restarting') { this.pending = true; this.status = '正在准备 LuaLaTeX…'; }
        break;
      case 'ReadXError': this.error = event.message; this.pending = false; break;
      case 'ReadXStopped': this.pending = false; this.status = '实时预览已停止'; break;
    }
    this.changed();
  }

  dispose() {
    this.disposed = true;
    this.changed = () => {};
    this.images.onLoaded = () => {};
    void this.pdf?.destroy();
    this.model.clear();
  }
}
