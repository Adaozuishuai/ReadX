import { useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ReadingVisualAnalysis } from '../api/client';
import type { ReadingKind } from '../hooks/useReadings';
import type { PaperVisual, PaperVisualProgress, VisualSelection, VisualMention } from '../hooks/usePaperVisuals';
import { VisualRegionEditor } from './VisualRegionEditor';

export function PaperVisualGallery({
  visuals,
  analyses,
  activeStep,
  progress,
  error,
  waitingPDF,
  onCite,
  pdfDocument,
  onSaveSelection,
  onResetSelection,
  onRedetect,
  unlocated = [],
  ignoredCount = 0,
  onDismiss,
  onRestoreIgnored,
}: {
  visuals: PaperVisual[];
  analyses: ReadingVisualAnalysis[];
  activeStep: ReadingKind;
  progress: PaperVisualProgress | null;
  error: string;
  waitingPDF: boolean;
  onCite: (page: number) => void;
  pdfDocument?: PDFDocumentProxy | null;
  onSaveSelection?: (selection: VisualSelection) => Promise<void>;
  onResetSelection?: (id: string) => void;
  onRedetect?: () => void;
  unlocated?: VisualMention[];
  ignoredCount?: number;
  onDismiss?: (id: string) => void;
  onRestoreIgnored?: () => void;
}) {
  const [filter, setFilter] = useState<'step' | 'all' | 'review'>('all');
  const [editor, setEditor] = useState<PaperVisual | null | undefined>(undefined);
  const notes = new Map(analyses.map((item) => [item.id, item]));
  const stepFor = (item: PaperVisual) => notes.get(item.id)?.step;
  const reviewCount = visuals.filter((item) => item.reviewStatus === 'needs-review' || item.extractionStatus !== 'ready').length;
  const items = visuals.filter((item) => filter === 'all' || (filter === 'review' ? item.reviewStatus === 'needs-review' || item.extractionStatus !== 'ready' : stepFor(item) === activeStep));
  return <section className="paper-visuals" aria-label={`${activeStep}相关图表`}>
    <header className="paper-visuals-heading"><div><h3>已定位图表 · {visuals.length}</h3><p>插图 {visuals.filter((v) => v.kind === 'figure').length} · 表格 {visuals.filter((v) => v.kind === 'table').length} · 显示 {items.length} 项</p></div><div>{onRedetect && <button className="precision-button" disabled={!!progress || waitingPDF} onClick={onRedetect}>重新识别</button>}{pdfDocument && onSaveSelection && <button className="precision-button" disabled={!!progress || waitingPDF} onClick={() => setEditor(null)}>＋ 补选遗漏图表</button>}</div></header>
    <div className="paper-visual-filters" aria-label="图表显示范围"><button aria-pressed={filter === 'step'} onClick={() => setFilter('step')}>本步骤</button><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部图表 {visuals.length}</button><button aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>待确认 {reviewCount}</button></div>
    {ignoredCount > 0 && onRestoreIgnored && <p className="text-[11px] text-ink-soft">已忽略 {ignoredCount} 个候选。<button className="text-accent underline" disabled={!!progress} onClick={onRestoreIgnored}>恢复已忽略候选</button></p>}
    {waitingPDF && <p className="text-ink-soft">正在载入 PDF，图表识别稍后开始。</p>}
    {progress && <p className="text-ink-soft">{progress.phase === 'detecting' ? '正在检测图注和图表位置' : progress.phase === 'source-pdf' ? '正在准备无损原 PDF 页面入口' : '正在按 PDF 高分辨率重新渲染裁切'}：第 {progress.page}/{progress.total} 页 · 已检测 {progress.detected} 项 · 裁切失败 {progress.failed} 项</p>}
    {error && <p className="text-bad">图表检测失败（PDF 文本或页面读取错误）：{error}</p>}
    {!progress && unlocated.length > 0 && <div className="visual-unlocated"><strong>正文提及但尚未定位 · {unlocated.length} 项</strong><div>{unlocated.map((m) => <span key={m.kind + m.label}>{m.kind === 'table' ? 'Table' : 'Figure'} {m.label}{m.pages.slice(0, 3).map((page) => <button className="assistant-citation" key={page} onClick={() => onCite(page)}>Page {page}</button>)}</span>)}</div></div>}
    {!waitingPDF && !progress && !error && visuals.length === 0 && <p className="text-ink-soft">暂无图表</p>}
    {!progress && items.length === 0 && visuals.length > 0 && <p className="text-ink-soft">{filter === 'review' ? '暂无待确认选区' : '暂无图表'}</p>}
    {items.map((item) => <article className="paper-visual-card" key={item.id}>
      {item.imageURL
        ? <a href={item.imageURL} target="_blank" rel="noreferrer" title="打开高清图表">
            <img src={item.imageURL} alt={`${item.kind === 'table' ? '表' : '图'}：${item.caption}`} loading="lazy" />
          </a>
        : <div className="text-bad" role="status">已检测到图注，但图表裁切失败：{item.extractionError ?? '未知错误'}</div>}
      <div className="paper-visual-caption">
        <strong>{item.caption}</strong>
        <span>{item.kind === 'table' ? '表格' : '插图'} · {item.reviewStatus === 'manual' ? '手动选区' : item.extractionStatus === 'ready' ? item.reviewStatus === 'needs-review' ? '选区待确认' : '自动选区 · 可校正' : '边界未确定'}</span>
        {item.reviewReason && <p className="visual-review-notice">{item.reviewReason}</p>}
        {item.imageURL && <a href={item.imageURL} download={`page-${item.page}-${item.id}.png`}>下载高清图表 PNG</a>}
        {item.sourcePDFURL && <a href={`${item.sourcePDFURL}#page=${item.page}`} target="_blank" rel="noreferrer">打开无损原 PDF · Page {item.page}</a>}
        <details>
          <summary>查看选区定位信息</summary>
          {item.debugImageURL && <><a href={item.debugImageURL} download={`page-${item.page}-visual-debug.png`}>下载整页定位图</a><small>蓝色：图注；橙色：搜索范围；绿色：裁切范围。</small></>}
          {item.captionBounds && <small>图注框（pt）：{item.captionBounds.x.toFixed(1)}, {item.captionBounds.y.toFixed(1)}, {item.captionBounds.width.toFixed(1)} × {item.captionBounds.height.toFixed(1)}</small>}
          <small>PDF 页面坐标（pt）：{item.detectedBounds.x.toFixed(1)}, {item.detectedBounds.y.toFixed(1)}, {item.detectedBounds.width.toFixed(1)} × {item.detectedBounds.height.toFixed(1)}</small>
          {item.cropBounds && <small>实际裁切（pt）：{item.cropBounds.x.toFixed(1)}, {item.cropBounds.y.toFixed(1)}, {item.cropBounds.width.toFixed(1)} × {item.cropBounds.height.toFixed(1)}</small>}
        </details>
        {notes.get(item.id) ? <p>AI 归类：{notes.get(item.id)!.section} · {notes.get(item.id)!.analysis}</p> : <p className="precision-muted">尚未分析</p>}
        <div className="paper-visual-actions"><button type="button" className="precision-button" onClick={() => onCite(item.page)}>跳到 Page {item.page}</button>{pdfDocument && onSaveSelection && <button className="precision-button" disabled={!!progress} onClick={() => setEditor(item)}>校正范围</button>}{item.reviewStatus === 'manual' && onResetSelection && <button className="precision-button" disabled={!!progress} onClick={() => onResetSelection(item.id)}>{item.id.startsWith('manual-') ? '移除手动选区' : '恢复自动选区'}</button>}{item.reviewStatus !== 'manual' && onDismiss && <button className="precision-button" disabled={!!progress} onClick={() => onDismiss(item.id)}>忽略此候选</button>}</div>
      </div>
    </article>)}
    {editor !== undefined && pdfDocument && onSaveSelection && <VisualRegionEditor key={editor?.id || 'new'} document={pdfDocument} visual={editor} activeStep={activeStep} onSave={onSaveSelection} onClose={() => setEditor(undefined)} />}
  </section>;
}
