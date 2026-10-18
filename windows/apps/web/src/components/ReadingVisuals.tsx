import type { ReadingVisualAnalysis } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { MathText } from './FormulaContent';
import { EvidenceField } from './DeepReadingBlocks';
import { AssistantMessage } from './ChatWorkspace';

export function ReadingVisuals({ items, visuals, onCite }: { items: ReadingVisualAnalysis[]; visuals: PaperVisual[]; onCite: (page: number) => void }) {
  if (!items.length) return null;
  const byID = new Map(visuals.map((visual) => [visual.id, visual]));
  return <div className="reading-inline-visuals">{items.map((item) => {
    const visual = byID.get(item.id);
    if (!visual?.imageURL) return null;
    return <figure className="reading-inline-visual" id={'reading-visual-' + item.id} key={item.id}>
      <div className="reading-visual-topline"><span>{item.kind === 'table' ? '原文表格' : '原文插图'} · {item.section}</span><button className="assistant-citation" onClick={() => onCite(item.page)}>Page {item.page} ↗</button></div>
      <a className="reading-visual-image" href={visual.imageURL} target="_blank" rel="noreferrer" title="打开高清原图"><img src={visual.imageURL} alt={item.caption} loading="lazy" /></a>
      <figcaption><strong><MathText text={item.caption} /></strong><a href={visual.imageURL} target="_blank" rel="noreferrer">放大原图 ↗</a></figcaption>
      <div className="reading-visual-analysis">{item.observation && <p><MathText text={item.observation} /></p>}<AssistantMessage text={item.analysis} onCite={onCite} />{item.limitations && <p className="reading-visual-limit"><MathText text={item.limitations} /></p>}
        {item.evidence && <details><summary>关联正文证据</summary><EvidenceField field={item.evidence} onCite={onCite} /></details>}
      </div>
    </figure>;
  })}</div>;
}
