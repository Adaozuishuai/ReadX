import type { ReadingEntry } from '../api/client';
import type { ReadingKind } from '../hooks/useReadings';
import type { PaperVisual, PaperVisualProgress } from '../hooks/usePaperVisuals';

const STEPS = new Set<ReadingKind>(['motivation', 'method', 'experiment', 'results', 'reproduction']);

function visualNotes(entries: Partial<Record<ReadingKind, ReadingEntry>>) {
  const byId = new Map<string, Map<ReadingKind, string>>();
  const assignedStep = new Map<string, ReadingKind>();
  for (const kind of ['motivation', 'method', 'experiment', 'results', 'reproduction'] as const) {
    const entry = entries[kind];
    if (!entry) continue;
    try {
      const items = (JSON.parse(entry.value) as { visuals?: unknown }).visuals;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.id !== 'string' || typeof record.step !== 'string' || !STEPS.has(record.step as ReadingKind)) continue;
        const step = record.step as ReadingKind;
        assignedStep.set(record.id, step);
        const analyses = byId.get(record.id) ?? new Map<ReadingKind, string>();
        analyses.set(kind, typeof record.analysis === 'string' ? record.analysis : '');
        byId.set(record.id, analyses);
      }
    } catch { /* Older reading JSON has no visual analysis. */ }
  }
  return { byId, assignedStep };
}

export function PaperVisualGallery({
  visuals,
  entries,
  activeStep,
  progress,
  error,
  waitingPDF,
  onCite,
}: {
  visuals: PaperVisual[];
  entries: Partial<Record<ReadingKind, ReadingEntry>>;
  activeStep: ReadingKind;
  progress: PaperVisualProgress | null;
  error: string;
  waitingPDF: boolean;
  onCite: (page: number) => void;
}) {
  const { byId: notes, assignedStep } = visualNotes(entries);
  const items = visuals.filter((item) => (assignedStep.get(item.id) ?? item.suggestedStep) === activeStep);
  return <section className="paper-visuals" aria-label={`${activeStep}相关图表`}>
    <h3>论文图表 · {items.length}</h3>
    {waitingPDF && <p className="text-ink-soft">正在载入 PDF，图表识别稍后开始。</p>}
    {progress && <p className="text-ink-soft">{progress.phase === 'detecting' ? '正在检测图注和图表位置' : progress.phase === 'source-pdf' ? '正在准备无损原 PDF 页面入口' : '正在按 PDF 高分辨率重新渲染裁切'}：第 {progress.page}/{progress.total} 页 · 已检测 {progress.detected} 项 · 裁切失败 {progress.failed} 项</p>}
    {error && <p className="text-bad">图表检测失败（PDF 文本或页面读取错误）：{error}</p>}
    {!waitingPDF && !progress && !error && visuals.length === 0 && <p className="text-ink-soft">未检测到可识别图注；这是检测未命中，不是图表裁切失败。</p>}
    {!progress && items.length === 0 && visuals.length > 0 && <p className="text-ink-soft">本步骤暂无匹配图表。</p>}
    {items.map((item) => <article className="paper-visual-card" key={item.id}>
      {item.imageURL
        ? <a href={item.imageURL} target="_blank" rel="noreferrer" title="打开高清图表">
            <img src={item.imageURL} alt={`${item.kind === 'table' ? '表' : '图'}：${item.caption}`} loading="lazy" />
          </a>
        : <div className="text-bad" role="status">已检测到图注，但图表裁切失败：{item.extractionError ?? '未知错误'}</div>}
      <div className="paper-visual-caption">
        <strong>{item.caption}</strong>
        <span>{item.kind === 'table' ? '表格' : '插图'} · {item.extractionStatus === 'ready' ? (notes.get(item.id)?.has(activeStep) ? 'AI 图注分析' : '按图注归类') : '检测成功，裁切失败'}</span>
        {item.imageURL && <a href={item.imageURL} download={`page-${item.page}-${item.id}.png`}>下载高清图表 PNG</a>}
        {item.sourcePDFURL && <a href={`${item.sourcePDFURL}#page=${item.page}`} target="_blank" rel="noreferrer">打开无损原 PDF · Page {item.page}</a>}
        {item.debugImageURL && <><a href={item.debugImageURL} download={`page-${item.page}-visual-debug.png`}>下载检测框调试图</a><small>调试图颜色：蓝色图注框、橙色候选区域、绿色最终裁切框</small></>}
        <details>
          <summary>检测框坐标</summary>
          <small>图注框（pt）：{item.captionBounds.x.toFixed(1)}, {item.captionBounds.y.toFixed(1)}, {item.captionBounds.width.toFixed(1)} × {item.captionBounds.height.toFixed(1)}</small>
          <small>PDF 页面坐标（pt）：{item.detectedBounds.x.toFixed(1)}, {item.detectedBounds.y.toFixed(1)}, {item.detectedBounds.width.toFixed(1)} × {item.detectedBounds.height.toFixed(1)}</small>
          {item.cropBounds && <small>实际裁切（pt）：{item.cropBounds.x.toFixed(1)}, {item.cropBounds.y.toFixed(1)}, {item.cropBounds.width.toFixed(1)} × {item.cropBounds.height.toFixed(1)}</small>}
        </details>
        {notes.get(item.id)?.get(activeStep) && <p>{notes.get(item.id)!.get(activeStep)}</p>}
        <button type="button" onClick={() => onCite(item.page)}>跳到 Page {item.page}</button>
      </div>
    </article>)}
  </section>;
}
