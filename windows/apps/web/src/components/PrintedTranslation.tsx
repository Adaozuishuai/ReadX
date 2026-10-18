import { useEffect, useRef, useState } from 'react';
import { getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { api } from '../api/client';

interface Props {
  documentKey: string;
  pdfDocument: PDFDocumentProxy;
  page: number;
  /** 每次点击「OCR 排版译文」递增，用来强制重新请求（绕过缓存）。 */
  nonce: number;
}

/**
 * 单页排版译文。
 *
 * 服务端先用 PaddleOCR 识别这一页的段落，再逐段翻译，最后由 rpr 引擎按原页坐标与字号
 * 把译文排回版面；这里把返回的单页 PDF 用 PDF.js 画到画布上，因而扫描件也能有与原文
 * 版式一致的译文窗格。
 */
export function PrintedTranslation({ documentKey, pdfDocument, page, nonce }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [extracted, setExtracted] = useState(false);
  const [phase, setPhase] = useState<
    { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }
  >({ kind: 'loading' });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(Math.floor(next));
    });
    observer.observe(element);
    setWidth(Math.floor(element.clientWidth));
    return () => observer.disconnect();
  }, []);

  // 只为「文档 / 页码 / 手动刷新」取一次 PDF；窗格拖动只触发重绘，不重复请求。
  useEffect(() => {
    if (!documentKey) return;
    let cancelled = false;
    const controller = new AbortController();
    setPdfData(null);
    setExtracted(false);
    setPhase({ kind: 'loading' });
    void (async () => {
      try {
        const sourcePage = await pdfDocument.getPage(page);
        const size = sourcePage.getViewport({ scale: 1 });
        const result = await api.translatedPage(
          documentKey,
          page,
          { width: size.width, height: size.height },
          controller.signal,
        );
        if (!cancelled) {
          setExtracted(result.extracted);
          setPdfData(result.data);
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [documentKey, page, nonce, pdfDocument]);

  // 画布按容器宽度缩放；再乘 devicePixelRatio 保证清晰度。
  useEffect(() => {
    if (!pdfData || !width) return;
    let cancelled = false;
    const task = getDocument({ data: new Uint8Array(pdfData) });
    void (async () => {
      try {
        const translated = await task.promise;
        const translatedPage = await translated.getPage(1);
        const base = translatedPage.getViewport({ scale: 1 });
        const scale = Math.max(0.2, width / base.width);
        const viewport = translatedPage.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
        canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建译图画布');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        await translatedPage.render({ canvasContext: context, viewport }).promise;
        if (!cancelled) setPhase({ kind: 'ready' });
      } catch (error) {
        if (!cancelled) {
          setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [pdfData, width]);

  return (
    <div className="printed-translation" ref={host}>
      {phase.kind === 'loading' ? (
        <p className="printed-translation-note">
          正在识别段落并生成排版译文……首次需要对整篇文档做 OCR，并调用模型翻译这一页，可能需要一会儿。
        </p>
      ) : null}
      {phase.kind === 'error' ? <p className="text-bad printed-translation-note">{phase.message}</p> : null}
      {extracted && phase.kind === 'ready' ? (
        <p className="printed-translation-note">
          这一页没有可翻译的正文（公式、表格或图片页），已保留原页。
        </p>
      ) : null}
      <canvas ref={canvasRef} hidden={phase.kind !== 'ready'} />
    </div>
  );
}
