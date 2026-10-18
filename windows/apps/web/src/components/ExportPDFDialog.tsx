import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  api,
  type OCRSettings,
  type RenderStatus,
  type TranslatedPDFPageInput,
  type TranslatedPDFResponse,
} from '../api/client';

/**
 * 生成保留排版的译文 PDF。
 *
 * 只走 RetainPDF 链路：PaddleOCR 识别段落 → 模型翻译 → rpr 引擎按原页坐标回填。
 * 旧的「PDF.js 文本层分段 + 翻译接口」路径已删除，因此必须先配置 PaddleOCR 与 AI。
 */
type Phase = 'idle' | 'working' | 'done' | 'error';

interface Props {
  documentKey: string;
  document: PDFDocumentProxy;
  pageCount: number;
  onClose: () => void;
  onOpenAISettings: () => void;
}

export function ExportPDFDialog({ documentKey, document, pageCount, onClose, onOpenAISettings }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<TranslatedPDFResponse | null>(null);
  const [renderStatus, setRenderStatus] = useState<RenderStatus | null>(null);
  const [ocr, setOCR] = useState<OCRSettings | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
    cancelled.current = false;
    void Promise.all([api.renderStatus(), api.ocrSettings()])
      .then(([status, settings]) => {
        if (cancelled.current) return;
        setRenderStatus(status);
        setOCR(settings);
      })
      .catch((cause) => {
        if (!cancelled.current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled.current = true;
    };
  }, []);

  const download = async () => {
    const blob = await api.downloadTranslatedPDF(documentKey);
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `${documentKey}-translated.pdf`;
    window.document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const run = async () => {
    if (phase === 'working') return;
    setPhase('working');
    setError('');
    setResult(null);
    setProgress('');
    try {
      if (!renderStatus?.available) {
        throw new Error(renderStatus?.error || '当前安装缺少排版引擎（resources/rendering-engine）');
      }
      if (!ocr?.configured) {
        throw new Error('导出译文 PDF 需要 PaddleOCR：请先到 AI 助手设置中配置访问令牌。');
      }
      setProgress(`读取 ${pageCount} 页尺寸…`);
      const pages: TranslatedPDFPageInput[] = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, blocks: [] });
      }
      setProgress(`OCR、翻译并排版 ${pageCount} 页（可能需要数分钟）…`);
      const response = await api.translatedPDF(documentKey, { pages, ocr: true });
      setResult(response);
      setPhase('done');
      setProgress('');
      await download();
    } catch (cause) {
      if (cancelled.current) return;
      setPhase('error');
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress('');
    }
  };

  return (
    <dialog
      className="app-dialog export-pdf-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (phase !== 'working') onClose();
      }}
    >
      <header>
        <div>
          <h2>导出译文 PDF</h2>
          <small>PaddleOCR 识别段落 → 翻译 → rpr 按原页坐标排版；公式/表格/图片保持原样。</small>
        </div>
        <button type="button" disabled={phase === 'working'} onClick={onClose}>关闭</button>
      </header>

      <div className="export-pdf-body">
        {renderStatus && !renderStatus.available ? (
          <p className="text-bad">排版引擎不可用：{renderStatus.error}</p>
        ) : null}

        <div className={`export-pdf-ocr${ocr?.configured ? ' ok' : ''}`}>
          <div>
            <strong>PaddleOCR</strong>
            <span>{ocr?.configured ? '已配置（导出必需）' : '未配置（导出必需）'}</span>
          </div>
          <p>令牌和识别模型在 AI 助手设置中统一管理。</p>
          {!ocr?.configured ? <button type="button" onClick={onOpenAISettings}>打开 AI 助手设置</button> : null}
        </div>

        {progress ? <p className="export-pdf-progress">{progress}</p> : null}
        {error ? <p className="text-bad">{error}</p> : null}
        {result ? (
          <div className="export-pdf-result">
            <strong>译文 PDF 已生成并开始下载</strong>
            <span>
              {result.pages} 页 / {result.blocks} 块 · {(result.bytes / 1024 / 1024).toFixed(1)} MB
              {result.overflow > 0 ? ` · ${result.overflow} 块排得较紧` : ''}
              {result.collisions > 0 ? ` · ${result.collisions} 处重叠` : ''}
            </span>
            <button type="button" onClick={() => void download()}>再下载一次</button>
          </div>
        ) : null}
      </div>

      <footer>
        <button type="button" onClick={onClose} disabled={phase === 'working'}>取消</button>
        <button type="button" className="primary" disabled={phase === 'working' || !renderStatus?.available} onClick={() => void run()}>
          {phase === 'working' ? '生成中…' : '生成译文 PDF'}
        </button>
      </footer>
    </dialog>
  );
}
