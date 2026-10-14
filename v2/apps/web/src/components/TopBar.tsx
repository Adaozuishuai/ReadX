import type { WorkspacePhase } from '../hooks/useWorkspace';

const SECTIONS = [
  { id: 'library', label: '论文库', stage: 'S1' },
  { id: 'reading', label: '精读', stage: 'S3' },
  { id: 'notes', label: '批注', stage: 'S4' },
  { id: 'translate', label: '对照', stage: 'S5' },
  { id: 'trends', label: '趋势', stage: 'S6' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

interface Props {
  phase: WorkspacePhase;
  active: SectionId;
  onSelect: (id: SectionId) => void;
  onReload: () => void;
}

/** 顶栏：品牌 + 工作区导航 + 后端连接状态。状态直接暴露 schema/pid，方便排查「连的是哪个 server」。 */
export function TopBar({ phase, active, onSelect, onReload }: Props) {
  const meta = phase.kind === 'ready' ? phase.meta : null;

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-surface px-5 shadow-sm">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tracking-tight">CBCT 精读</span>
        <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">v2</span>
      </div>

      <nav className="ml-2 flex items-center gap-1 rounded-pill bg-surface-sunk p-1">
        {SECTIONS.map((section) => {
          const isActive = section.id === active;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              aria-current={isActive ? 'page' : undefined}
              title={`完整功能在 ${section.stage} 落地`}
              className={[
                'relative rounded-pill px-3 py-1.5 text-[13px] transition',
                isActive
                  ? 'bg-surface text-ink shadow-sm font-medium'
                  : 'text-ink-soft hover:text-ink',
              ].join(' ')}
            >
              {section.label}
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <ConnectionState phase={phase} />
        <button
          type="button"
          onClick={onReload}
          className="rounded-pill border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-soft shadow-sm transition hover:border-line-strong hover:text-ink active:translate-y-px"
        >
          重新连接
        </button>
      </div>

      {meta ? <span className="sr-only">{meta.dataRoot}</span> : null}
    </header>
  );
}

function ConnectionState({ phase }: { phase: WorkspacePhase }) {
  if (phase.kind === 'loading') {
    return <Pill tone="muted">连接中…</Pill>;
  }
  if (phase.kind === 'error') {
    return (
      <Pill tone="bad" title={phase.message}>
        后端未连接
      </Pill>
    );
  }
  return (
    <Pill tone="good" title={`${phase.meta.dbPath}`}>
      schema v{phase.meta.schemaVersion} · {phase.meta.documentsTotal} 篇
    </Pill>
  );
}

function Pill({
  tone,
  title,
  children,
}: {
  tone: 'good' | 'bad' | 'muted';
  title?: string;
  children: React.ReactNode;
}) {
  const palette = {
    good: 'bg-good/10 text-good',
    bad: 'bg-bad/10 text-bad',
    muted: 'bg-surface-sunk text-ink-faint',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-[12px] font-medium ${palette}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
