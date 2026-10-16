import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export function EmptyTrashDialog({ keysToDelete, onClose, onCleared }: {
  keysToDelete: string[];
  onClose: () => void;
  onCleared: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const clear = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await api.emptyTrash(keysToDelete);
      await onCleared();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialog} className="app-dialog [&>p]:mb-3" aria-labelledby="empty-trash-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
      <header><h2 id="empty-trash-title">清空回收站</h2></header>
      <p>将永久移除回收站中的 {keysToDelete.length} 篇论文条目，以及关联的批注、译文、精读和复现记录。此操作无法在回收站恢复。</p>
      <p className="text-good">所有 PDF / EPUB 文件均保留，包括原始位置的论文和 library 文件夹中的副本。</p>
      <p>这次清空不会释放论文文件占用的磁盘空间。</p>
      {error ? <p role="alert" className="text-bad">{error}</p> : null}
      <footer>
        <button type="button" onClick={onClose} disabled={busy} autoFocus>取消</button>
        <button type="button" onClick={() => void clear()} disabled={busy} className="text-bad">{busy ? '清空中…' : '确认清空'}</button>
      </footer>
    </dialog>
  );
}
