import { useRef, useState } from 'react';

export function LibraryTrashButton({ title, deleted, onToggle, className = '' }: {
  title: string;
  deleted: boolean;
  onToggle: () => Promise<unknown>;
  className?: string;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const label = deleted ? '恢复到书库' : '移入回收站';
  return (
    <button
      type="button"
      className={`library-trash-button ${className}`}
      data-library-action={deleted ? 'restore' : 'trash'}
      aria-label={`${label}：${title}`}
      title={label}
      disabled={busy}
      aria-busy={busy}
      onClick={async (event) => {
        event.stopPropagation();
        if (pending.current) return;
        pending.current = true;
        setBusy(true);
        try {
          await onToggle();
        } catch {
          // useLibraryMeta displays the server error and keeps the document visible.
        } finally {
          pending.current = false;
          setBusy(false);
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {deleted ? <><path d="M3 10a9 9 0 1 1 2.6 8" /><path d="M3 4v6h6" /></> : <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>}
      </svg>
      {deleted ? <span>恢复</span> : null}
    </button>
  );
}
