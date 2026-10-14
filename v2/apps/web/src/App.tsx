import { useMemo, useState } from 'react';
import { BodyColumn } from './components/BodyColumn';
import { LibraryColumn } from './components/LibraryColumn';
import { SideColumn } from './components/SideColumn';
import { TopBar, type SectionId } from './components/TopBar';
import { useWorkspace } from './hooks/useWorkspace';

export default function App() {
  const { phase, reload } = useWorkspace();
  const [section, setSection] = useState<SectionId>('library');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const selected = useMemo(
    () => documents.find((doc) => doc.id === selectedId) ?? null,
    [documents, selectedId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar phase={phase} active={section} onSelect={setSection} onReload={reload} />

      {section === 'library' || section === 'reading' ? (
        <main className="grid min-h-0 flex-1 grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(320px,380px)] gap-3 p-3">
          <LibraryColumn phase={phase} selectedId={selectedId} onSelect={setSelectedId} />
          <BodyColumn phase={phase} selected={selected} />
          <SideColumn selected={selected} />
        </main>
      ) : (
        <SectionPlaceholder section={section} />
      )}

      {phase.kind === 'error' ? (
        <footer className="shrink-0 border-t border-bad/30 bg-bad/5 px-5 py-2">
          <p className="text-[12px] leading-relaxed text-bad">
            {phase.message}
            <span className="mx-2 text-line-strong">|</span>
            {phase.hint}
          </p>
        </footer>
      ) : null}
    </div>
  );
}

/** 未实现的入口只做说明，不摆假界面——空壳交互会让人误以为功能可用。 */
function SectionPlaceholder({ section }: { section: SectionId }) {
  const text: Record<string, { stage: string; body: string }> = {
    notes: { stage: 'S4', body: '选区高亮、问题批注、颜色标签与 Markdown 导出。' },
    translate: { stage: 'S5', body: '段落级中英对照，译文按段落哈希缓存，重复阅读零额度成本。' },
    trends: { stage: 'S6', body: '趋势与计数、想法工作流、复现任务板，全部沿用旧版 evidence-first 判定。' },
  };
  const info = text[section] ?? { stage: '未命名', body: '' };
  return (
    <main className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="card-surface max-w-md rounded-card px-6 py-7 text-center">
        <p className="text-[15px] font-semibold">该入口在 {info.stage} 落地</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{info.body}</p>
        <p className="stage-note mt-3">现在能用的是论文库三栏骨架与后端连通验证。</p>
      </div>
    </main>
  );
}
