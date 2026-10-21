import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import { fitPDFWidth, paragraphAt, mergePaperHeadings, type PaperHeading, type PDFLayout } from '@cbct/shared';
import { headingsFromPDFPage } from '../api/pdfOutline';
import type { SelectedParagraph } from './ParagraphActions';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { api, type Annotation, type NewAnnotation } from '../api/client';

GlobalWorkerOptions.workerSrc = workerURL;
export type PDFOutline = PaperHeading;
export interface PendingSelection {
  annotation: NewAnnotation;
  top: number;
  left: number;
}

export function textFromPDF(content: TextContent): string {
  return content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
    .join('')
    .trim();
}

type PDFMarkRect = { x: number; y: number; width: number; height: number };

function visualAt(layout: PDFLayout, x: number, y: number): number | null {
  const px = x * layout.width, py = y * layout.height;
  let index: number | null = null;
  for (let i = 0; i < (layout.visuals?.length ?? 0); i++) {
    const block = layout.visuals![i]!;
    if (px < block.x || px > block.x + block.width || py < block.y || py > block.y + block.height) continue;
    const previous = index === null ? null : layout.visuals![index]!;
    if (!previous || block.width * block.height < previous.width * previous.height) index = i;
  }
  return index;
}

function mergePDFMarkRects(rects: PDFMarkRect[]): PDFMarkRect[] {
  const rows: { top: number; bottom: number; rects: PDFMarkRect[] }[] = [];
  for (const rect of [...rects]
    .filter((item) => Number.isFinite(item.x + item.y + item.width + item.height) && item.width > 0 && item.height > 0)
    .sort((a, b) => a.y - b.y || a.x - b.x)) {
    const bottom = rect.y + rect.height;
    const center = rect.y + rect.height / 2;
    const row = rows.find((candidate) => {
      const overlap = Math.max(0, Math.min(bottom, candidate.bottom) - Math.max(rect.y, candidate.top));
      const minHeight = Math.min(rect.height, candidate.bottom - candidate.top);
      const rowCenter = (candidate.top + candidate.bottom) / 2;
      return overlap / minHeight >= 0.55 || Math.abs(center - rowCenter) <= minHeight * 0.32;
    });
    if (row) {
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, bottom);
      row.rects.push(rect);
    } else rows.push({ top: rect.y, bottom, rects: [rect] });
  }

  return rows.flatMap((row) => {
    const merged: PDFMarkRect[] = [];
    for (const rect of row.rects.sort((a, b) => a.x - b.x)) {
      const previous = merged[merged.length - 1];
      if (previous && rect.x <= previous.x + previous.width + 0.0025) {
        const right = Math.max(previous.x + previous.width, rect.x + rect.width);
        const top = Math.min(previous.y, rect.y);
        const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
        previous.x = Math.min(previous.x, rect.x);
        previous.width = right - previous.x;
        previous.y = top;
        previous.height = bottom - top;
      } else merged.push({ ...rect });
    }
    return merged;
  });
}

function pdfSelectionRects(range: Range, bounds: DOMRect): PDFMarkRect[] {
  const rects = Array.from(range.getClientRects()).flatMap((rect) => {
    const left = Math.max(bounds.left, rect.left);
    const top = Math.max(bounds.top, rect.top);
    const right = Math.min(bounds.right, rect.right);
    const bottom = Math.min(bounds.bottom, rect.bottom);
    if (right - left <= 1 || bottom - top <= 1) return [];
    return [{
      x: (left - bounds.left) / bounds.width,
      y: (top - bounds.top) / bounds.height,
      width: (right - left) / bounds.width,
      height: (bottom - top) / bounds.height,
    }];
  });
  return mergePDFMarkRects(rects);
}

export function usePDF(key: string | null, translated = false) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [outline, setOutline] = useState<PDFOutline[]>([]);
  const [error, setError] = useState('');
  const [indexing, setIndexing] = useState('');
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let task: ReturnType<typeof getDocument> | undefined;
    setDocument(null);
    setOutline([]);
    setError('');
    setIndexing('');
    void (async () => {
      try {
        let data!: ArrayBuffer;
        if (translated) {
          // Import writes translated pages before assembling the final PDF.
          // Keep checking so a reader opened mid-import switches to the complete
          // document as soon as LeePDF finishes its render stage.
          while (!controller.signal.aborted) {
            try {
              data = await api.translatedFile(key, controller.signal);
              break;
            } catch {
              if (controller.signal.aborted) return;
              await new Promise<void>((resolve) => {
                const timer = window.setTimeout(resolve, 2500);
                controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
              });
            }
          }
          if (controller.signal.aborted) return;
        } else {
          data = await api.file(key, controller.signal);
        }
        if (controller.signal.aborted) return;
        task = getDocument({
          data,
          isEvalSupported: false,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
        });
        const doc = await task.promise;
        if (controller.signal.aborted) return;
        setDocument(doc);
        const tree = await doc.getOutline();
        const entries: PDFOutline[] = [];
        const visit = async (
          items: NonNullable<typeof tree>,
          depth: number,
        ) => {
          for (const item of items) {
            try {
              const dest =
                typeof item.dest === 'string'
                  ? await doc.getDestination(item.dest)
                  : item.dest;
              if (dest?.[0] != null) {
                const page =
                  typeof dest[0] === 'number'
                    ? dest[0] + 1
                    : (await doc.getPageIndex(dest[0])) + 1;
                const mode = dest[1]?.name;
                const top = mode === 'XYZ' ? dest[3] : mode === 'FitH' || mode === 'FitBH' ? dest[2] : mode === 'FitR' ? dest[5] : undefined;
                let y: number | undefined;
                if (typeof top === 'number') {
                  const viewport = (await doc.getPage(page)).getViewport({ scale: 1 });
                  const left = mode === 'XYZ' && typeof dest[2] === 'number' ? dest[2] : 0;
                  y = Math.max(0, Math.min(1, viewport.convertToViewportPoint(left, top)[1]! / viewport.height));
                }
                entries.push({ title: item.title, page, depth, y });
              }
            } catch {
              /* An invalid PDF destination should not prevent reading. */
            }
            await visit(item.items, depth + 1);
          }
        };
        if (tree) await visit(tree, 0);
        if (!controller.signal.aborted) setOutline(entries);
        if (translated) {
          if (!controller.signal.aborted) setIndexing('');
          return;
        }
        const cached = new Set(
          (await api.pages(key, controller.signal)).pages.map(
            (item) => item.page,
          ),
        );
        let empty = 0;
        const inferred: PDFOutline[] = [];
        for (let page = 1; page <= doc.numPages; page++) {
          if (controller.signal.aborted) return;
          const pdfPage = await doc.getPage(page);
          const content = await pdfPage.getTextContent();
          if (controller.signal.aborted) return;
          inferred.push(...headingsFromPDFPage(pdfPage, content));
          setOutline(mergePaperHeadings(entries, inferred));
          if (cached.has(page)) { await new Promise((resolve) => setTimeout(resolve, 0)); continue; }
          setIndexing(`正在提取正文与目录 ${page}/${doc.numPages}`);
          const text = textFromPDF(content);
          if (controller.signal.aborted) return;
          if (text) await api.putPage(key, page, text, controller.signal);
          else empty++;
        }
        if (!controller.signal.aborted)
          setIndexing(
            empty
              ? `${empty} 页是扫描页；OCR 与译文由 LeePDF 处理，可切换到译文查看`
              : '',
          );
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message =
            cause instanceof Error ? cause.message : String(cause);
          if (task) setIndexing(`正文提取未完成：${message}`);
          else setError(message);
        }
      }
    })();
    return () => {
      controller.abort();
      void task?.destroy();
    };
  }, [key, translated]);
  return { document, outline, error, indexing };
}

/** Continuous document canvas. It preserves a single scroll surface and renders nearby pages lazily. */
export function PDFDocumentView({
  document,
  page,
  onPage,
  annotations,
  focusedId,
  onSelect,
  onText,
  layout,
  paragraphMode = false,
  onParagraph,
  onAnnotationClick,
  navigationRequest,
}: {
  document: PDFDocumentProxy;
  page: number;
  onPage: (page: number) => void;
  annotations: Annotation[];
  focusedId: string | null;
  onSelect: (selection: PendingSelection) => void;
  onText: (text: string) => void;
  layout?: PDFLayout | null;
  paragraphMode?: boolean;
  onParagraph?: (paragraph: SelectedParagraph) => void;
  onAnnotationClick?: (annotation: Annotation, position: { top: number; left: number }) => void;
  navigationRequest?: { page: number; y?: number; viewportOffset?: number; nonce: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  const slots = useRef(new Map<number, HTMLDivElement>());
  const onPageRef = useRef(onPage);
  onPageRef.current = onPage;
  const activePageRef = useRef(page);
  activePageRef.current = page;
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [nearPages, setNearPages] = useState<Set<number>>(() => new Set([page]));
  const [pageRatios, setPageRatios] = useState<number[]>([]);
  const [zoom, setZoom] = useState(1);

  useEffect(() => setScrollRoot(root.current), []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ratios = await Promise.all(
        Array.from({ length: document.numPages }, async (_, index) => {
          const pdfPage = await document.getPage(index + 1);
          const viewport = pdfPage.getViewport({ scale: 1 });
          return viewport.width / viewport.height;
        }).map((ratioPromise) => ratioPromise.catch(() => 0.707)),
      );
      if (!cancelled) setPageRatios(ratios);
    })();
    return () => { cancelled = true; };
  }, [document]);
  useEffect(() => {
    if (!scrollRoot || pageRatios.length !== document.numPages) return;
    const nearObserver = new IntersectionObserver((entries) => {
      setNearPages((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(pageNumber);
          else next.delete(pageNumber);
        }
        return next;
      });
    }, { root: scrollRoot, rootMargin: '1200px 0px' });
    for (const slot of slots.current.values()) {
      nearObserver.observe(slot);
    }
    let frame = 0;
    const updateActivePage = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rootBounds = scrollRoot.getBoundingClientRect();
        const marker = rootBounds.top + Math.min(96, rootBounds.height * 0.2);
        let nearestPage = 1;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const [pageNumber, slot] of slots.current) {
          const bounds = slot.getBoundingClientRect();
          if (bounds.top <= marker && bounds.bottom > marker) {
            nearestPage = pageNumber;
            nearestDistance = 0;
            break;
          }
          const distance = Math.min(Math.abs(bounds.top - marker), Math.abs(bounds.bottom - marker));
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPage = pageNumber;
          }
        }
        if (nearestPage !== activePageRef.current) {
          activePageRef.current = nearestPage;
          onPageRef.current(nearestPage);
        }
      });
    };
    scrollRoot.addEventListener('scroll', updateActivePage, { passive: true });
    updateActivePage();
    return () => {
      nearObserver.disconnect();
      scrollRoot.removeEventListener('scroll', updateActivePage);
      cancelAnimationFrame(frame);
    };
  }, [scrollRoot, document, pageRatios.length]);

  useEffect(() => {
    if (!scrollRoot || pageRatios.length !== document.numPages) return;
    const targetPage = navigationRequest?.page ?? page;
    const slot = slots.current.get(targetPage);
    if (!slot) return;
    const rootTop = scrollRoot.getBoundingClientRect().top;
    const top = slot.getBoundingClientRect().top - rootTop + scrollRoot.scrollTop - 14
      + Math.max(0, Math.min(1, navigationRequest?.y ?? 0)) * slot.clientHeight
      - Math.max(0, Math.min(scrollRoot.clientHeight, navigationRequest?.viewportOffset ?? 0));
    scrollRoot.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [navigationRequest?.nonce, scrollRoot, pageRatios.length, document.numPages]);

  return (
    <div className="pdf-reader pdf-document-reader">
      <div className="reader-format-tools">
        <button onClick={() => setZoom((value) => Math.max(0.5, value - 0.2))} aria-label="缩小">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(3, value + 0.2))} aria-label="放大">＋</button>
        <button onClick={() => setZoom(1)}>适合宽度</button>
        <span className="pdf-document-page-count">第 {page} / {document.numPages} 页</span>
      </div>
      <div className="pdf-document-scroll" ref={root}>
        {pageRatios.length !== document.numPages ? (
          <p className="pdf-page-placeholder-status" role="status">正在准备连续阅读…</p>
        ) : Array.from({ length: document.numPages }, (_, index) => {
          const pageNumber = index + 1;
          return (
            <div
              className="pdf-page-slot"
              data-page={pageNumber}
              key={pageNumber}
              ref={(element) => {
                if (!element) { slots.current.delete(pageNumber); return; }
                slots.current.set(pageNumber, element);
              }}
              style={{ aspectRatio: `${(pageRatios[pageNumber - 1] ?? 0.707) / zoom}` }}
            >
              {nearPages.has(pageNumber) ? (
                <PDFPage
                  document={document}
                  page={pageNumber}
                  annotations={annotations}
                  focusedId={focusedId}
                  onSelect={onSelect}
                  onText={onText}
                  layout={pageNumber === page ? layout : null}
                  paragraphMode={paragraphMode}
                  onParagraph={onParagraph}
                  onAnnotationClick={onAnnotationClick}
                  continuousPage
                  scrollRoot={scrollRoot}
                  zoomLevel={zoom}
                />
              ) : <span className="pdf-page-placeholder">{pageNumber}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function PDFPage({
  document,
  page,
  annotations,
  focusedId,
  onSelect,
  onText,
  layout,
  paragraphMode = false,
  onParagraph,
  onAnnotationClick,
  continuousPage = false,
  scrollRoot,
  zoomLevel,
}: {
  document: PDFDocumentProxy;
  page: number;
  annotations: Annotation[];
  focusedId: string | null;
  onSelect: (selection: PendingSelection) => void;
  onText: (text: string) => void;
  layout?: PDFLayout | null;
  paragraphMode?: boolean;
  onParagraph?: (paragraph: SelectedParagraph) => void;
  onAnnotationClick?: (annotation: Annotation, position: { top: number; left: number }) => void;
  continuousPage?: boolean;
  scrollRoot?: HTMLElement | null;
  zoomLevel?: number;
}) {
  const paragraphLayout = layout;
  const container = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const previousRender = useRef<Promise<void>>(Promise.resolve());
  const [width, setWidth] = useState(600);
  const [zoom, setZoom] = useState(1);
  const activeZoom = zoomLevel ?? zoom;
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [hoveredRegion, setHoveredRegion] = useState<{ kind: 'paragraph' | 'visual'; index: number } | null>(null);
  useEffect(() => setHoveredRegion(null), [page, layout, paragraphMode]);
  useEffect(() => {
    if (!container.current) return;
    let frame = 0;
    const measure = () => {
      if (!container.current) return;
      const next = fitPDFWidth(container.current.clientWidth, continuousPage ? 0 : 40);
      setWidth((current) => current === next ? current : next);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    measure();
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [continuousPage]);
  useEffect(() => {
    let cancelled = false;
    let render:
      | ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>
      | undefined;
    let layer: TextLayer | undefined;
    setError('');
    setRendering(true);
    void (async () => {
      try {
        await previousRender.current.catch(() => undefined);
        if (cancelled) return;
        const pdfPage = await document.getPage(page);
        if (
          cancelled ||
          !canvas.current ||
          !paper.current ||
          !textLayer.current
        )
          return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = (width / natural.width) * activeZoom;
        const viewport = pdfPage.getViewport({ scale });
        const ratio = Math.min(2, window.devicePixelRatio || 1);
        const element = canvas.current;
        element.width = Math.floor(viewport.width * ratio);
        element.height = Math.floor(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        paper.current.style.width = `${viewport.width}px`;
        paper.current.style.height = `${viewport.height}px`;
        textLayer.current.replaceChildren();
        textLayer.current.style.setProperty('--scale-factor', String(scale));
        const context = element.getContext('2d');
        if (!context) throw new Error('无法创建 PDF 画布');
        render = pdfPage.render({
          canvasContext: context,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        previousRender.current = render.promise.catch(() => undefined);
        const content = await pdfPage.getTextContent();
        if (cancelled) return;
        onTextRef.current(textFromPDF(content));
        layer = new TextLayer({
          textContentSource: content,
          container: textLayer.current,
          viewport,
        });
        const renderDone = Promise.allSettled([render.promise, layer.render()]).then((results) => {
          const failed = results.find((result) => result.status === 'rejected');
          if (failed?.status === 'rejected' && !cancelled) throw failed.reason;
        });
        previousRender.current = renderDone.catch(() => undefined);
        await renderDone;
        if (!cancelled) {
          setRenderedPage(page);
          setRendering(false);
        }
      } catch (cause) {
        if (!cancelled) {
          setRendering(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [document, page, width, activeZoom]);
  useEffect(() => {
    if (!continuousPage) container.current?.scrollTo(0, 0);
  }, [page, continuousPage]);
  useEffect(() => {
    if (!focusedId) return;
    (scrollRoot ?? container.current)
      ?.querySelector(`[data-annotation-id="${CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId, page, scrollRoot]);
  const select = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !paper.current) return;
    const range = selection.getRangeAt(0);
    if (!paper.current.contains(range.commonAncestorContainer)) return;
    const quote = selection.toString().trim();
    if (!quote) return;
    const bounds = paper.current.getBoundingClientRect();
    const rects = pdfSelectionRects(range, bounds);
    const anchor = range.getBoundingClientRect();
    onSelect({
      annotation: {
        page,
        quote,
        kind: 'highlight',
        locator: { kind: 'pdf', rects },
      },
      top: anchor.bottom,
      left: anchor.left,
    });
  };
  return (
    <div className={`pdf-reader${continuousPage ? ' pdf-reader-page' : ''}`}>
      {!continuousPage && <div className="reader-format-tools">
        <button onClick={() => setZoom((value) => Math.max(0.5, value - 0.2))}>
          −
        </button>
        <span>{Math.round(activeZoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(3, value + 0.2))}>
          ＋
        </button>
        <button onClick={() => setZoom(1)}>适合宽度</button>
        {paragraphMode && paragraphLayout && <select aria-label="选择段落" className="paragraph-picker" value="" onChange={(event) => {
          if (!event.target.value) return;
          const index = Number(event.target.value) - 1;
          const block = paragraphLayout.blocks[index];
          if (!block) return;
          const anchor = event.currentTarget.getBoundingClientRect();
          const targetY = block.y / paragraphLayout.height;
          const viewportOffset = paper.current && scrollRoot
            ? paper.current.getBoundingClientRect().top + targetY * paper.current.getBoundingClientRect().height - scrollRoot.getBoundingClientRect().top
            : undefined;
          onParagraph?.({ text: block.text, position: page, index, targetY, viewportOffset, kind: 'pdf', top: anchor.bottom, left: anchor.left });
        }}><option value="">识别 {paragraphLayout.blocks.length} 段 · 点击原文或选择</option>
          {paragraphLayout.blocks.map((block, index) => <option key={index} value={index + 1}>第 {index + 1} 段：{block.text.slice(0, 60)}</option>)}
        </select>}
      </div>}
      <div className="pdf-scroll" ref={container}>
        {error && <p role="alert">PDF 渲染失败：{error}</p>}
        <div
          className="pdf-paper"
          data-page={page}
          data-rendered-page={renderedPage ?? undefined}
          data-rendering={rendering}
          ref={paper}
          onMouseUp={select}
          onMouseMove={(event) => {
            if (!paragraphMode || !paragraphLayout) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / bounds.width;
            const y = (event.clientY - bounds.top) / bounds.height;
            const visual = visualAt(paragraphLayout, x, y);
            if (visual !== null) {
              setHoveredRegion((previous) => previous?.kind === 'visual' && previous.index === visual ? previous : { kind: 'visual', index: visual });
              return;
            }
            const paragraph = paragraphAt(paragraphLayout, x, y);
            if (paragraph !== null) {
              setHoveredRegion((previous) => previous?.kind === 'paragraph' && previous.index === paragraph ? previous : { kind: 'paragraph', index: paragraph });
              return;
            }
            setHoveredRegion(null);
          }}
          onMouseLeave={() => setHoveredRegion(null)}
          onClick={(event) => {
            if (event.detail > 1) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && selection.rangeCount && event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
            const highlighted = annotations.filter((item) => item.page === page && item.kind === 'highlight').findLast((item) =>
              (item.locator?.rects ?? []).some((rect) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height),
            );
            if (highlighted) {
              onAnnotationClick?.(highlighted, { top: event.clientY, left: event.clientX });
              return;
            }
            if (!paragraphMode || !paragraphLayout) return;
            const visualIndex = visualAt(paragraphLayout, x, y);
            if (visualIndex !== null) {
              const visual = paragraphLayout.visuals?.[visualIndex];
              if (visual?.kind === 'formula') {
                const rect = {
                  x: visual.x / paragraphLayout.width,
                  y: visual.y / paragraphLayout.height,
                  width: visual.width / paragraphLayout.width,
                  height: visual.height / paragraphLayout.height,
                };
                onSelect({
                  annotation: {
                    page,
                    quote: visual.text.trim() || '公式',
                    kind: 'highlight',
                    locator: { kind: 'pdf', rects: [rect] },
                  },
                  top: event.clientY,
                  left: event.clientX,
                });
              }
              return;
            }
            const index = paragraphAt(paragraphLayout, x, y);
            if (index === null) return;
            const block = paragraphLayout.blocks[index]!;
            const targetY = block.y / paragraphLayout.height;
            const viewportOffset = scrollRoot
              ? bounds.top + targetY * bounds.height - scrollRoot.getBoundingClientRect().top
              : undefined;
            onParagraph?.({ text: block.text, position: page, index, targetY, viewportOffset, kind: 'pdf', top: event.clientY, left: event.clientX });
          }}
          onKeyUp={(event) => {
            if (event.key === 'Shift') select();
          }}
        >
          <canvas ref={canvas} />
          <div className="textLayer" ref={textLayer} />
          {paragraphMode && paragraphLayout && hoveredRegion !== null && (() => {
            const isVisual = hoveredRegion.kind === 'visual';
            const block = isVisual ? paragraphLayout.visuals?.[hoveredRegion.index] : paragraphLayout.blocks[hoveredRegion.index];
            return block && <div className={`pdf-paragraph-hover${isVisual ? ' pdf-visual-hover' : ''}`} aria-hidden="true" style={{ left: `${block.x / paragraphLayout.width * 100}%`, top: `${block.y / paragraphLayout.height * 100}%`, width: `${block.width / paragraphLayout.width * 100}%`, height: `${block.height / paragraphLayout.height * 100}%` }}>{isVisual && <span>{paragraphLayout.visuals?.[hoveredRegion.index]?.kind === 'table' ? 'OCR 表格' : paragraphLayout.visuals?.[hoveredRegion.index]?.kind === 'formula' ? 'OCR 公式 · 点击添加高亮' : 'OCR 图片'}</span>}</div>;
          })()}
          <div className="pdf-marks">
            {(() => {
              const pageAnnotations = annotations.filter((annotation) => annotation.page === page);
              const highlights = pageAnnotations.filter((item) => item.kind === 'highlight');
              return <>
                {highlights.map((annotation) => {
                  const paths: string[] = [];
                for (const rect of annotation.locator?.rects ?? []) {
                  if (Number.isFinite(rect.x + rect.y + rect.width + rect.height) && rect.width > 0 && rect.height > 0) {
                    paths.push(`M${rect.x} ${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`);
                  }
                }
                  return paths.length > 0 && (
                  <svg
                    key={`highlight-${annotation.id}`}
                    aria-hidden="true"
                    data-annotation-id={annotation.id}
                    className={`pdf-mark pdf-mark-highlight ann-highlight-${annotation.color}${focusedId === annotation.id ? ' ann-focused' : ''}`}
                    viewBox="0 0 1 1"
                    preserveAspectRatio="none"
                  >
                    <path d={paths.join('')} />
                  </svg>
                  );
                })}
                {pageAnnotations
                  .filter((annotation) => annotation.kind !== 'highlight')
                  .flatMap((a) => mergePDFMarkRects(a.locator?.rects ?? []).map((rect, index) => (
                  <span
                    key={`${a.id}-${index}`}
                    data-annotation-id={a.id}
                    title={a.note || a.quote}
                    className={`pdf-mark ann-${a.kind}-${a.color}${focusedId === a.id ? ' ann-focused' : ''}`}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                  />
                  )))}
              </>;
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
