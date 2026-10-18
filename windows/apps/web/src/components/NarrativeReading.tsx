import type { ReadingEntry, ReadingVisualAnalysis } from '../api/client';
import type { PaperVisual } from '../hooks/usePaperVisuals';
import { AssistantMessage } from './ChatWorkspace';
import { MathText } from './FormulaContent';
import { ReadingVisuals } from './ReadingVisuals';

export function NarrativeReading({ entry, analyses, visuals, onCite }: { entry: ReadingEntry; analyses: ReadingVisualAnalysis[]; visuals: PaperVisual[]; onCite: (page: number) => void }) {
  const byID = new Map(analyses.map((v) => [v.id, v]));
  const sections = entry.narrativeSections?.length ? entry.narrativeSections : [{ title: '', body: entry.narrative ?? '', status: 'ready' }];
  return <div className="paper-narrative">{sections.map((section, index) => <section className="reading-section" key={section.title || index}>
    {section.title && <h3>{section.title}</h3>}
    {section.body.split(/(\[\[visual:[^\]\n]+\]\]|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g).filter(Boolean).map((block, n) => {
      const id = /^\[\[visual:([^\]\n]+)\]\]$/.exec(block)?.[1];
      if (id) {
        const item = byID.get(id);
        return item ? <ReadingVisuals key={n} items={[item]} visuals={visuals} onCite={onCite} /> : null;
      }
      if (block.startsWith('$$') || block.startsWith('\\[')) return <div className="paper-narrative-equation" key={n}><MathText text={block} /></div>;
      return <AssistantMessage key={n} text={block.replace(/^(#{1,6}\s+.+)$/gm, '\n\n$1\n\n')} onCite={onCite} />;
    })}
  </section>)}</div>;
}
