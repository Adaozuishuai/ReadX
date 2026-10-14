import { useEffect, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import type { Filters, WorkspacePhase } from '../hooks/useWorkspace';
import { useDebouncedValue } from '../hooks/useWorkspace';

interface Props {
  phase: WorkspacePhase;
  filters: Filters;
  setFilters: (next: Partial<Filters>) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  importing: boolean;
  importError: string | null;
  runImport: () => void;
}

const STATUS_TONE: Record<string, string> = {
  reading: 'bg-accent-soft text-accent',
  done: 'bg-good/10 text-good',
  queue: 'bg-surface-sunk text-ink-soft',
  archive: 'bg-surface-sunk text-ink-faint',
};

const STATUS_TABS = [
  { id: '', label: '全部' },
  { id: 'reading', label: '在读' },
  { id: 'queue', label: '待读' },
  { id: 'done', label: '已精读' },
];

export function LibraryColumn({
  phase,
  filters,
  setFilters,
  selectedId,
  onSelect,
  importing,
  importError,
  runImport,
}: Props) {
  const [input, setInput] = useState(filters.q);
  const debounced = useDebouncedValue(input, 300);

  useEffect(() => {
    if (debounced !== filters.q) setFilters({ q: debounced });
    // 只在去抖值变化时提交，避免输入过程中反复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const total = phase.kind === 'ready' ? phase.meta.documentsTotal : 0;

  return (
    <aside className="card-surface flex h-full min-h-0 w-full flex-col rounded-card">
      <div className="flex flex-col gap-2 border-b border-line px-3 py-3">
        <label className="block">
          <span className="mb-1.5 block text-[12px] font-medium text-ink-soft">论文库</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="标题 / 作者 / 会场"
            className="w-full rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-1">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id || 'all'}
              type="button"
              onClick={() => setFilters({ status: tab.id })}
              className={[
                'rounded-pill px-2 py-1 text-[12px] transition',
                filters.status === tab.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:text-ink',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {phase.kind === 'loading' ? <SkeletonRows /> : null}
        {phase.kind === 'error' ? (
          <p className="px-2 py-3 text-[13px] leading-relaxed text-ink-soft">{phase.message}</p>
        ) : null}
        {phase.kind === 'ready' && documents.length === 0 ? (
          <EmptyLibrary filtering={Boolean(filters.q || filters.status)} total={total} onImport={runImport} importing={importing} importError={importError} />
        ) : null}
        <ul className="flex flex-col gap-1.5">
          {phase.kind === 'ready'
            ? documents.map((doc) => (
                <li key={doc.id}>
                  <DocumentRow doc={doc} selected={doc.id === selectedId} onSelect={() => onSelect(doc.id)} />
                </li>
              ))
            : null}
        </ul>
      </div>

      {phase.kind === 'ready' ? (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-[11px] text-ink-faint">
          <span>
            {documents.length === total ? `${total} 篇` : `筛出 ${documents.length} / ${total} 篇`}
          </span>
          {total === 0 ? (
            <button
              type="button"
              onClick={runImport}
              disabled={importing}
              className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-soft transition hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              {importing ? '导入中…' : '导入旧数据'}
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function DocumentRow({ doc, selected, onSelect }: { doc: DocumentSummary; selected: boolean; onSelect: () => void }) {
  const tone = STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={[
        'w-full rounded-lg border px-2.5 py-2 text-left transition',
        selected ? 'border-accent/40 bg-accent-soft/60 shadow-sm' : 'border-transparent hover:border-line hover:bg-surface-sunk',
      ].join(' ')}
    >
      <p className="line-clamp-2 text-[13px] font-medium leading-snug text-ink">{doc.title || '（无标题）'}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
        <span className={`rounded-pill px-1.5 py-0.5 font-medium ${tone}`}>{statusLabel(doc.status)}</span>
        <span className="truncate">
          {doc.authors[0] ?? '作者未知'}
          {doc.authors.length > 1 ? ' 等' : ''}
          {doc.year ? ` · ${doc.year}` : ''}
        </span>
      </p>
    </button>
  );
}

function EmptyLibrary({
  filtering,
  total,
  onImport,
  importing,
  importError,
}: {
  filtering: boolean;
  total: number;
  onImport: () => void;
  importing: boolean;
  importError: string | null;
}) {
  if (filtering && total > 0) {
    return <p className="px-2 py-4 text-[13px] text-ink-soft">没有符合条件的论文。</p>;
  }
  return (
    <div className="px-2 py-5 text-[13px] leading-relaxed text-ink-soft">
      <p className="font-medium text-ink">库里还没有论文。</p>
      <p className="mt-1.5">
        点「导入旧数据」把旧版 <code className="rounded bg-surface-sunk px-1">queue.json</code>、逐页正文缓存与精读记录导入
        SQLite。导入前会自动备份到 <code className="rounded bg-surface-sunk px-1">app/data/v2/backups</code>，旧文件只读不改。
      </p>
      <button
        type="button"
        onClick={onImport}
        disabled={importing}
        className="mt-3 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-surface shadow-sm transition hover:brightness-105 disabled:opacity-50"
      >
        {importing ? '导入中…' : '导入旧数据'}
      </button>
      {importError ? <p className="mt-2 text-[12px] leading-relaxed text-bad">{importError}</p> : null}
    </div>
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-2 p-1">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="h-12 animate-pulse rounded-lg bg-surface-sunk" />
      ))}
    </div>
  );
}
