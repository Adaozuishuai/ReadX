import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { api, type LeeVisualBlock } from '../api/client';
import type { PaperVisual, ReadingKind, VisualBounds, VisualSelection } from '../hooks/usePaperVisuals';

const STEPS: { value: ReadingKind; label: string }[] = [{ value: 'motivation', label: '实验动机' }, { value: 'method', label: '方法公式' }, { value: 'experiment', label: '实验配置' }, { value: 'results', label: '结果分析' }, { value: 'reproduction', label: '代码复现' }];
function clamp(bounds: VisualBounds): VisualBounds {
  const width = Math.max(0.01, Math.min(1, bounds.width)), height = Math.max(0.01, Math.min(1, bounds.height));
  return { x: Math.max(0, Math.min(1 - width, bounds.x)), y: Math.max(0, Math.min(1 - height, bounds.y)), width, height };
}

export function VisualRegionEditor({ documentKey, document, visual, activeStep, onSave, onClose }: {
  documentKey?: string; document: PDFDocumentProxy; visual: PaperVisual | null; activeStep: ReadingKind;
  onSave: (selection: VisualSelection) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pageNumber, setPageNumber] = useState(visual?.page ?? 1);
  const [preview, setPreview] = useState('');
  const [bounds, setBounds] = useState<VisualBounds>({ x: 0.08, y: 0.08, width: 0.84, height: 0.4 });
  const [kind, setKind] = useState<'figure' | 'table'>(visual?.kind ?? 'figure');
  const [caption, setCaption] = useState(visual?.caption ?? '');
  const [step, setStep] = useState<ReadingKind>(visual?.suggestedStep ?? activeStep);
  const [loading, setLoading] = useState(true);
  const [ocrBlocks, setOcrBlocks] = useState<LeeVisualBlock[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 612, height: 792 });
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let cancelled = false;
    let url = '';
    let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | null = null;
    const canvas = window.document.createElement('canvas');
    setLoading(true); setPreview(''); setError(''); drag.current = null;
    void (async () => {
      try {
        const page = await document.getPage(pageNumber); if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        setSize({ width: base.width, height: base.height });
        const previous = visual?.page === pageNumber ? visual.cropBounds ?? visual.detectedBounds : null;
        setBounds(previous ? clamp({ x: previous.x / base.width, y: previous.y / base.height, width: previous.width / base.width, height: previous.height / base.height }) : { x: 0.08, y: 0.08, width: 0.84, height: 0.4 });
        const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d'); if (!context) throw new Error('无法显示原 PDF 页面');
        task = page.render({ canvasContext: context, viewport }); await task.promise;
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('页面图像编码失败')), 'image/png'));
        if (cancelled) return;
        url = URL.createObjectURL(blob); setPreview(url);
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { canvas.width = 0; canvas.height = 0; if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; task?.cancel(); if (url) URL.revokeObjectURL(url); };
  }, [document, pageNumber, visual]);
  useEffect(() => {
    if (!documentKey) { setOcrBlocks([]); return; }
    const controller = new AbortController();
    setOcrLoading(true);
    setOcrBlocks([]);
    void api.paragraphs(documentKey, pageNumber, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setOcrBlocks(result.visuals ?? []); })
      .catch(() => { if (!controller.signal.aborted) setOcrBlocks([]); })
      .finally(() => { if (!controller.signal.aborted) setOcrLoading(false); });
    return () => controller.abort();
  }, [documentKey, pageNumber]);
  const save = async () => {
    if (lock.current || loading || !preview) return;
    lock.current = true; setBusy(true); setError('');
    try {
      await onSave({ id: visual?.id ?? 'manual-' + crypto.randomUUID(), page: pageNumber, kind, caption: visual?.caption ?? (caption.trim() || `手动选定${kind === 'table' ? '表格' : '插图'} · Page ${pageNumber}`), suggestedStep: step, bounds: clamp(bounds) });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  };
  return <dialog ref={dialog} className="app-dialog visual-region-dialog" aria-labelledby="visual-region-title" aria-busy={busy || loading} onCancel={(event) => { if (lock.current) event.preventDefault(); else onClose(); }}>
    <header><div><h2 id="visual-region-title">{visual ? '校正图表范围' : '补选遗漏图表'}</h2></div><button className="precision-button" disabled={busy} onClick={onClose} aria-label="关闭选区编辑">×</button></header>
    <div className="visual-region-body"><div className="visual-region-page-scroll">
      {loading && <p role="status">正在渲染原 PDF 页面…</p>}
      {preview && <div className="visual-region-page" style={{ aspectRatio: `${size.width} / ${size.height}` }} tabIndex={0} role="group" aria-label="原页框选区，拖动选区或用方向键移动"
        onPointerDown={(e) => { if (busy || e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); drag.current = point(e); }}
        onPointerMove={(e) => { if (!drag.current) return; const p = point(e), start = drag.current; setBounds(clamp({ x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) })); }}
        onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(e) => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || busy) return; e.preventDefault(); const shift = e.shiftKey ? 0.001 : 0.01; setBounds((b) => clamp({ ...b, x: b.x + (e.key === 'ArrowLeft' ? -shift : e.key === 'ArrowRight' ? shift : 0), y: b.y + (e.key === 'ArrowUp' ? -shift : e.key === 'ArrowDown' ? shift : 0) })); }}>
        <img src={preview} alt={`原 PDF 第 ${pageNumber} 页`} draggable={false} />
        <div className="visual-region-selection" style={{ left: `${bounds.x * 100}%`, top: `${bounds.y * 100}%`, width: `${bounds.width * 100}%`, height: `${bounds.height * 100}%` }}><span>图表选区</span></div>
        {ocrBlocks.map((block) => {
          const x = block.box[0] / size.width, y = block.box[1] / size.height;
          const width = (block.box[2] - block.box[0]) / size.width, height = (block.box[3] - block.box[1]) / size.height;
          if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
          return <div key={`${block.index}-${block.kind}`} className="visual-region-ocr" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}><span>OCR {block.kind === 'table' ? '表格' : '图片'}</span></div>;
        })}
      </div>}
    </div><aside className="visual-region-controls"><label>原 PDF 页码<select value={pageNumber} disabled={busy || !!visual} onChange={(e) => setPageNumber(Number(e.target.value))}>{Array.from({ length: document.numPages }, (_, i) => <option key={i + 1} value={i + 1}>Page {i + 1}</option>)}</select></label>
      <p className="visual-region-ocr-status" role="status">{ocrLoading ? '正在读取该页 OCR 图表框…' : ocrBlocks.length ? `OCR 识别到 ${ocrBlocks.length} 个结构框。蓝色虚线为 OCR 框，绿色实线为当前图表选区。` : '该页 OCR 未返回表格或图片结构框；可结合原页调整图表选区。'}</p>
      <label>图表类型<select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as 'figure' | 'table')}><option value="figure">插图</option><option value="table">表格</option></select></label>
      <label>{visual ? '原图注' : '标题（可选）'}<textarea value={caption} readOnly={!!visual} disabled={busy} onChange={(e) => setCaption(e.target.value)} rows={4} maxLength={3900} placeholder="图注" /></label>
      <label>所属精读步骤<select value={step} disabled={busy} onChange={(e) => setStep(e.target.value as ReadingKind)}>{STEPS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select></label>
      <fieldset disabled={busy || loading}><legend>微调边界（页面百分比）</legend>{([['x', '左边距'], ['y', '顶边距'], ['width', '宽度'], ['height', '高度']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" min={key === 'width' || key === 'height' ? 1 : 0} max={100} step={0.1} value={Math.round(bounds[key] * 1000) / 10} onChange={(e) => { if (e.target.value !== '') setBounds((b) => clamp({ ...b, [key]: Number(e.target.value) / 100 })); }} />%</label>)}</fieldset>
      {error && <p role="alert" className="text-bad">{error}</p>}
    </aside></div><footer><button className="precision-button" disabled={busy} onClick={onClose}>取消</button><button className="precision-button primary" disabled={busy || loading || !preview} onClick={() => void save()}>{busy ? '保存高清选区…' : '保存选区'}</button></footer>
  </dialog>;
}
