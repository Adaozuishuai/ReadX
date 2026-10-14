import { useMemo, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import type { WorkspacePhase } from '../hooks/useWorkspace';

interface Props {
  phase: WorkspacePhase;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_TONE: Record<string, string> = {
  reading: 'bg-accent-soft text-accent',
  done: 'bg-good/10 text-good',
  queue: 'bg-surface-sunk text-ink-soft',
  archive: 'bg-surface-sunk text-ink-faint',
};

/** 左栏：论文列表 + 本地过滤。数据来自 /v1/documents，过滤只做包含匹配，不做模糊打分（避免误藏论文）。 */
export function LibraryColumn({ phase, selectedId, onSelect }: Props) {
  const [query, setQuery] = useState('');

  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return documents;
    return documents.filter((doc) => matches(doc, needle));
  }, [documents, query]);

  return (
    <aside className="flex h-full min-h-0 w-full flex-col gap-3">
      <div className="card-surface flex min-h-0 flex-1 flex-col rounded-card">
        <div className="border-b border-line px-3 py-3">
          <label className="block">
            <span className="mb-1.5 block text-[12px] font-medium text-ink-soft">论文库</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="标题 / 作者 / 会场"
              className="w-full rounded-lg border border-line bg-surface-sunk px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:bg-surface focus:outline-none"
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {phase.kind === 'loading' ? <SkeletonRows /> : null}
          {phase.kind === 'error' ? (
            <p className="px-2 py-3 text-[13px] leading-relaxed text-ink-soft">{phase.message}</p>
          ) : null}
          {phase.kind === 'ready' && filtered.length === 0 ? (
            <EmptyLibrary hasAny={documents.length > 0} query={query} />
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {phase.kind === 'ready'
              ? filtered.map((doc) => (
                  <li key={doc.id}>
                    <DocumentRow
                      doc={doc}
                      selected={doc.id === selectedId}
                      onSelect={() => onSelect(doc.id)}
                    />
                  </li>
                ))
              : null}
          </ul>
        </div>

        {phase.kind === 'ready' ? (
          <div className="border-t border-line px-3 py-2 text-[11px] text-ink-faint">
            {filtered.length === documents.length
              ? `${documents.length} 篇`
              : `${filtered.length} / ${documents.length} 篇`}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function matches(doc: DocumentSummary, needle: string): boolean {
  const haystack = [doc.title, doc.venue, doc.doi, doc.url, ...doc.authors].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function DocumentRow({
  doc,
  selected,
  onSelect,
}: {
  doc: DocumentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft';
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={[
        'group w-full rounded-lg border px-2.5 py-2 text-left transition',
        selected
          ? 'border-accent/40 bg-accent-soft/60 shadow-sm'
          : 'border-transparent hover:border-line hover:bg-surface-sunk',
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

function EmptyLibrary({ hasAny, query }: { hasAny: boolean; query: string }) {
  if (hasAny) {
    return <p className="px-2 py-4 text-[13px] text-ink-soft">没有匹配「{query.trim()}」的论文。</p>;
  }
  return (
    <div className="px-2 py-5 text-[13px] leading-relaxed text-ink-soft">
      <p className="font-medium text-ink">库里还没有论文。</p>
      <p className="mt-1.5">
        S1 阶段会把旧版 <code className="rounded bg-surface-sunk px-1">queue.json</code> 与
        <code className="rounded bg-surface-sunk px-1"> papers/</code> 幂等导入 SQLite；
        在此之前 v2 保持空库，不会改写任何旧数据。
      </p>
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
