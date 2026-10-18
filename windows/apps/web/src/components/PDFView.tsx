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
        const data = translated
          ? await api.translatedFile(key, controller.signal)
          : await api.file(key, controller.signal);
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
              ? `${empty} 页是扫描页；OCR 与译文由 RetainPDF 处理，可切换到译文查看`
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
  headingTarget,
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
  headingTarget?: { page: number; y: number; nonce: number } | null;
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
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState('');
  const [hoveredParagraph, setHoveredParagraph] = useState<number | null>(null);
  const headingRef = useRef(headingTarget);
  headingRef.current = headingTarget;
  const scrollToHeading = () => {
    const target = headingRef.current;
    if (!target || target.page !== page || !container.current || !paper.current) return;
    const top = paper.current.getBoundingClientRect().top - container.current.getBoundingClientRect().top + container.current.scrollTop;
    container.current.scrollTo({ top: Math.max(0, top + target.y * paper.current.clientHeight - 18) });
  };
  useEffect(() => { scrollToHeading(); }, [headingTarget?.nonce, page]);
  useEffect(() => setHoveredParagraph(null), [page, layout, paragraphMode]);
  useEffect(() => {
    if (!container.current) return;
    let frame = 0;
    const measure = () => {
      if (!container.current) return;
      const next = fitPDFWidth(container.current.clientWidth);
      setWidth((current) => current === next ? current : next);
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    measure();
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
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
        const scale = (width / natural.width) * zoom;
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
          scrollToHeading();
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
  }, [document, page, width, zoom]);
  useEffect(() => {
    container.current?.scrollTo(0, 0);
  }, [page]);
  useEffect(() => {
    if (!focusedId) return;
    container.current
      ?.querySelector(`[data-annotation-id="${CSS.escape(focusedId)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId, page]);
  const select = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !paper.current) return;
    const range = selection.getRangeAt(0);
    if (!paper.current.contains(range.commonAncestorContainer)) return;
    const quote = selection.toString().trim();
    if (!quote) return;
    const bounds = paper.current.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({
        x: Math.max(0, (r.left - bounds.left) / bounds.width),
        y: Math.max(0, (r.top - bounds.top) / bounds.height),
        width: Math.min(r.width, bounds.right - r.left) / bounds.width,
        height: Math.min(r.height, bounds.bottom - r.top) / bounds.height,
      }));
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
    <div className="pdf-reader">
      <div className="reader-format-tools">
        <button onClick={() => setZoom((value) => Math.max(0.5, value - 0.2))}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
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
          onParagraph?.({ text: block.text, position: page, index, kind: 'pdf', top: anchor.bottom, left: anchor.left });
        }}><option value="">识别 {paragraphLayout.blocks.length} 段 · 点击原文或选择</option>
          {paragraphLayout.blocks.map((block, index) => <option key={index} value={index + 1}>第 {index + 1} 段：{block.text.slice(0, 60)}</option>)}
        </select>}
      </div>
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
            const index = paragraphAt(paragraphLayout, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
            setHoveredParagraph((previous) => previous === index ? previous : index);
          }}
          onMouseLeave={() => setHoveredParagraph(null)}
          onClick={(event) => {
            if (!paragraphMode || !paragraphLayout || event.detail > 1) return;
            const selection = window.getSelection();
            if (selection && !selection.isCollapsed && selection.rangeCount && event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const index = paragraphAt(paragraphLayout, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height);
            if (index === null) return;
            const block = paragraphLayout.blocks[index]!;
            onParagraph?.({ text: block.text, position: page, index, kind: 'pdf', top: event.clientY, left: event.clientX });
          }}
          onKeyUp={(event) => {
            if (event.key === 'Shift') select();
          }}
        >
          <canvas ref={canvas} />
          {headingTarget?.page === page && <div className="pdf-heading-focus" aria-hidden="true" style={{ top: `${headingTarget.y * 100}%` }} />}
          <div className="textLayer" ref={textLayer} />
          {paragraphMode && paragraphLayout && hoveredParagraph !== null && (() => {
            const block = paragraphLayout.blocks[hoveredParagraph];
            return block && <div className="pdf-paragraph-hover" aria-hidden="true" style={{ left: `${block.x / paragraphLayout.width * 100}%`, top: `${block.y / paragraphLayout.height * 100}%`, width: `${block.width / paragraphLayout.width * 100}%`, height: `${block.height / paragraphLayout.height * 100}%` }} />;
          })()}
          <div className="pdf-marks">
            {annotations
              .filter((a) => a.page === page)
              .flatMap((a) =>
                (a.locator?.rects ?? []).map((rect, index) => (
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
                )),
              )}
          </div>
        </div>
      </div>
    </div>
  );
}
