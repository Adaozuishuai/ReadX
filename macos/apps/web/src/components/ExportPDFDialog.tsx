import { useEffect, useRef, useState } from 'react';
import { api, type TranslatedPDFResponse } from '../api/client';

/**
 * 生成保留排版的译文 PDF。
 *
 * LeePDF creates the translated PDF during import. ReadX only reuses and downloads it.
 */
type Phase = 'idle' | 'working' | 'done' | 'error';

interface Props {
  documentKey: string;
  pageCount: number;
  onClose: () => void;
}

export function ExportPDFDialog({ documentKey, pageCount, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<TranslatedPDFResponse | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    dialog.current?.showModal();
    cancelled.current = false;
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
      setProgress(`正在读取 LeePDF 已生成的译文（共 ${pageCount} 页）…`);
      const response = await api.translatedPDF(documentKey, { pageCount });
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
          <small>译文由 LeePDF 在导入时生成；ReadX 直接提供成品下载。</small>
        </div>
        <button type="button" disabled={phase === 'working'} onClick={onClose}>关闭</button>
      </header>

      <div className="export-pdf-body">
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
        <button type="button" className="primary" disabled={phase === 'working'} onClick={() => void run()}>
          {phase === 'working' ? '准备下载…' : '下载译文 PDF'}
        </button>
      </footer>
    </dialog>
  );
}
