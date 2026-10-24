import { useRef, useState } from 'react';
import { api } from '../api/client';
import { AppDialog } from './AppDialog';

export function EmptyTrashDialog({ keysToDelete, onClose, onCleared }: {
  keysToDelete: string[];
  onClose: () => void;
  onCleared: () => Promise<void>;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    <AppDialog open busy={busy} onClose={onClose} className="[&>p]:mb-3" aria-labelledby="empty-trash-title">
      <header><h2 id="empty-trash-title">清空回收站</h2></header>
      <p>将永久移除回收站中的 {keysToDelete.length} 篇论文条目，以及关联的批注、译文、精读和复现记录。此操作无法在回收站恢复。</p>
      <p className="text-good">会删除 ReadX library 文件夹中这些论文的导入副本；原始位置的 PDF / EPUB 文件保留。若副本仍被其他论文引用，则不会删除。</p>
      <p>清空后，译文、精读和论文记忆等关联数据也无法恢复。</p>
      {error ? <p role="alert" className="text-bad">{error}</p> : null}
      <footer>
        <button type="button" onClick={onClose} disabled={busy} autoFocus>取消</button>
        <button type="button" onClick={() => void clear()} disabled={busy} className="text-bad">{busy ? '清空中…' : '确认清空'}</button>
      </footer>
    </AppDialog>
  );
}
