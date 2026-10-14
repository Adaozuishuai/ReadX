// 内置 PDF 阅读器（渲染进程内，pdfjs + canvas 连续滚动视图）。
//
// 设计取舍：
// - 惰性渲染：只为进入视口（含 300px 预取边距）的页面创建 canvas，其余用占位高度；
//   论文一般 10–30 页，全量渲染会白白吃掉几百 MB 位图内存。
// - 淘汰上限：已渲染 canvas 超过 MAX_RENDERED 时，回收离当前页最远的，防长 PDF 内存无界。
// - 清晰渲染：canvas 按 devicePixelRatio（上限 2）超采样，CSS 尺寸保持逻辑像素。
// - 缩放两态：「适宽」（每页独立按容器宽度适配，混合页宽也整齐）与显式倍率（0.5–3）。
// - 证据联动：jumpToPage 供「点 Page N 跳原文」使用，落点页短暂描边提示。
//
// worker 配置与 pdfRaster.ts 共用（ensureWorker）。

import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { ensureWorker } from './pdfRaster';

const MAX_RENDERED = 28;          // 同时保留的已渲染页数上限
const OBSERVE_MARGIN = '300px';   // 视口外预渲染边距
const DPR_CAP = 2;

export interface PdfViewerOptions {
  onPageChange?: (page: number, total: number) => void;
  onZoomChange?: (label: string) => void;
}

export class PdfViewer {
  private doc: any = null;
  private host: HTMLElement;
  private scroller!: HTMLDivElement;
  private wrappers: HTMLDivElement[] = [];            // index = page-1
  private baseSizes: Array<{ w: number; h: number }> = [];
  private rendered = new Map<number, HTMLCanvasElement>();
  private rendering = new Set<number>();
  private observer: IntersectionObserver | null = null;
  private zoom = 0;                                    // 0 = 适宽；>0 显式倍率
  private current = 1;
  private destroyed = false;
  private generation = 0;                              // relayout 代号：在途渲染完成后校验，旧代号的位图直接丢弃
  private scrollRaf = 0;      // 滚动节流 timer 句柄
  private resizeTimer: number | undefined;
  private opts: PdfViewerOptions;

  private constructor(host: HTMLElement, opts: PdfViewerOptions) {
    this.host = host;
    this.opts = opts;
  }

  /** 载入 PDF 字节并挂载到 host。失败抛错（调用方展示）。 */
  static async open(host: HTMLElement, bytes: Uint8Array, opts: PdfViewerOptions = {}): Promise<PdfViewer> {
    ensureWorker();
    const v = new PdfViewer(host, opts);
    // 与 OCR 光栅化不同：显示用途保留内嵌字体渲染（disableFontFace 默认 false），
    // 二进制数据由 FontFace API 注入，不发生网络请求，不违反 CSP。
    v.doc = await (pdfjs as any).getDocument({ data: bytes, isEvalSupported: false }).promise;
    await v.build();
    return v;
  }

  get numPages(): number { return this.baseSizes.length; }
  get currentPage(): number { return this.current; }

  private async build(): Promise<void> {
    this.host.innerHTML = '';
    this.scroller = document.createElement('div');
    this.scroller.className = 'pdfv';
    this.host.appendChild(this.scroller);

    for (let n = 1; n <= this.doc.numPages; n++) {
      const page = await this.doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      this.baseSizes.push({ w: vp.width, h: vp.height });
      const wrap = document.createElement('div');
      wrap.className = 'pdfv-page';
      wrap.dataset.page = String(n);
      this.scroller.appendChild(wrap);
      this.wrappers.push(wrap);
    }

    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const n = Number((en.target as HTMLElement).dataset.page);
        if (en.isIntersecting) void this.renderPage(n);
      }
    }, { root: this.scroller, rootMargin: OBSERVE_MARGIN });
    for (const w of this.wrappers) this.observer.observe(w);

    this.scroller.addEventListener('scroll', () => this.onScroll());
    window.addEventListener('resize', this.onResize);
    this.relayout();
    this.emitPage();
    this.emitZoom();
  }

  /** 每页的生效缩放：适宽 = 容器可用宽度 / 页宽；显式 = zoom。 */
  private scaleFor(n: number): number {
    if (this.zoom > 0) return this.zoom;
    const avail = Math.max(120, this.scroller.clientWidth - 28);
    return avail / (this.baseSizes[n - 1]?.w ?? avail);
  }

  /** 按当前缩放重排全部占位尺寸，并丢弃已渲染位图（可见页会由 observer 重新触发）。 */
  private relayout(): void {
    this.generation += 1;
    for (let i = 0; i < this.wrappers.length; i++) {
      const n = i + 1;
      const s = this.scaleFor(n);
      const { w, h } = this.baseSizes[i];
      const wrap = this.wrappers[i];
      wrap.style.width = `${Math.round(w * s)}px`;
      wrap.style.height = `${Math.round(h * s)}px`;
      const old = this.rendered.get(n);
      if (old) { old.remove(); this.rendered.delete(n); }
    }
    this.rendering.clear();
    // 重新触发视口内页面的渲染
    this.observer?.disconnect();
    if (this.observer) for (const w of this.wrappers) this.observer.observe(w);
    for (let n = 1; n <= this.wrappers.length; n++) {
      const w = this.wrappers[n - 1];
      if (w.offsetTop < this.scroller.scrollTop + this.scroller.clientHeight + 300 &&
          w.offsetTop + w.offsetHeight > this.scroller.scrollTop - 300) void this.renderPage(n);
    }
  }

  private async renderPage(n: number): Promise<void> {
    if (this.destroyed || this.rendered.has(n) || this.rendering.has(n)) return;
    const wrap = this.wrappers[n - 1];
    if (!wrap) return;
    this.rendering.add(n);
    const gen = this.generation;
    try {
      const page = await this.doc.getPage(n);
      if (this.destroyed) return;
      const s = this.scaleFor(n);
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      const viewport = page.getViewport({ scale: s * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${Math.round(this.baseSizes[n - 1].w * s)}px`;
      canvas.style.height = `${Math.round(this.baseSizes[n - 1].h * s)}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      await page.render({ canvasContext: ctx, viewport }).promise;
      if (this.destroyed) { canvas.remove(); return; }
      if (gen !== this.generation) return;   // 渲染期间发生缩放/重排：丢弃旧代号位图
      wrap.appendChild(canvas);
      this.rendered.set(n, canvas);
      this.evictIfNeeded();
    } catch {
      // 单页渲染失败不拖垮整个视图：占位仍在，滚动离开再回来会重试
    } finally {
      this.rendering.delete(n);
    }
  }

  private evictIfNeeded(): void {
    while (this.rendered.size > MAX_RENDERED) {
      let worst = -1, worstDist = -1;
      for (const n of this.rendered.keys()) {
        const d = Math.abs(n - this.current);
        if (d > worstDist) { worstDist = d; worst = n; }
      }
      if (worst < 0) break;
      this.rendered.get(worst)?.remove();
      this.rendered.delete(worst);
    }
  }

  private onScroll(): void {
    if (this.scrollRaf) return;
    // 用 setTimeout 节流而不是 rAF：窗口被遮挡/失焦时 rAF 会停摆，页码指示随之冻结
    this.scrollRaf = window.setTimeout(() => {
      this.scrollRaf = 0;
      const top = this.scroller.scrollTop;
      let page = 1;
      for (let n = 1; n <= this.wrappers.length; n++) {
        if (this.wrappers[n - 1].offsetTop - 8 <= top) page = n;
      }
      if (page !== this.current) { this.current = page; this.emitPage(); }
    }, 60) as unknown as number;
  }

  private onResize = (): void => {
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.destroyed && this.zoom === 0) this.relayout();
    }, 200);
  };

  private emitPage(): void { this.opts.onPageChange?.(this.current, this.baseSizes.length); }
  private emitZoom(): void {
    this.opts.onZoomChange?.(this.zoom === 0 ? '适宽' : `${Math.round(this.zoom * 100)}%`);
  }

  /** 跳到第 n 页（平滑滚动 + 短暂描边提示）。 */
  async jumpToPage(n: number): Promise<void> {
    const target = Math.min(Math.max(1, Math.trunc(n) || 1), this.baseSizes.length);
    const wrap = this.wrappers[target - 1];
    if (!wrap) return;
    this.current = target;
    this.emitPage();
    this.scroller.scrollTo({ top: Math.max(0, wrap.offsetTop - 8), behavior: 'smooth' });
    wrap.classList.add('flash');
    setTimeout(() => wrap.classList.remove('flash'), 1400);
    void this.renderPage(target);
  }

  zoomBy(factor: number): void {
    const base = this.zoom > 0 ? this.zoom : this.scaleFor(this.current);
    this.zoom = Math.min(3, Math.max(0.5, base * factor));
    this.relayout();
    this.emitZoom();
  }

  zoomFit(): void {
    this.zoom = 0;
    this.relayout();
    this.emitZoom();
  }

  destroy(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('resize', this.onResize);
    if (this.scrollRaf) clearTimeout(this.scrollRaf);
    window.clearTimeout(this.resizeTimer);
    for (const c of this.rendered.values()) c.remove();
    this.rendered.clear();
    this.host.innerHTML = '';
    this.doc?.destroy?.();
    this.doc = null;
  }
}
