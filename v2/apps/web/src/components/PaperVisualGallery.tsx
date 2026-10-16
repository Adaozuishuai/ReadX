import type { ReadingEntry } from '../api/client';
import type { ReadingKind } from '../hooks/useReadings';
import type { PaperVisual } from '../hooks/usePaperVisuals';

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
  progress: { page: number; total: number } | null;
  error: string;
  waitingPDF: boolean;
  onCite: (page: number) => void;
}) {
  const { byId: notes, assignedStep } = visualNotes(entries);
  const items = visuals.filter((item) => (assignedStep.get(item.id) ?? item.suggestedStep) === activeStep);
  return <section className="paper-visuals" aria-label={`${activeStep}相关图表`}>
    <h3>论文图表 · {items.length}</h3>
    {waitingPDF && <p className="text-ink-soft">正在载入 PDF，图表识别稍后开始。</p>}
    {progress && <p className="text-ink-soft">正在识别并提取高清图表：第 {progress.page}/{progress.total} 页</p>}
    {error && <p className="text-bad">图表提取失败：{error}</p>}
    {!waitingPDF && !progress && !error && visuals.length === 0 && <p className="text-ink-soft">未找到带可识别图注的图表。</p>}
    {!progress && items.length === 0 && visuals.length > 0 && <p className="text-ink-soft">本步骤暂无匹配图表。</p>}
    {items.map((item) => <article className="paper-visual-card" key={item.id}>
      <a href={item.imageURL} target="_blank" rel="noreferrer" title="打开高清原图裁切">
        <img src={item.imageURL} alt={`${item.kind === 'table' ? '表' : '图'}：${item.caption}`} loading="lazy" />
      </a>
      <div className="paper-visual-caption">
        <strong>{item.caption}</strong>
        <span>{item.kind === 'table' ? '表格' : '插图'} · {notes.get(item.id)?.has(activeStep) ? 'AI 图注分析' : '按图注归类'}</span>
        {notes.get(item.id)?.get(activeStep) && <p>{notes.get(item.id)!.get(activeStep)}</p>}
        <button type="button" onClick={() => onCite(item.page)}>跳到 Page {item.page}</button>
      </div>
    </article>)}
  </section>;
}
