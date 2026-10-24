import { useEffect, useRef, useState } from 'react';
import { bookSources, type BookDownloadTask, type SourceBook } from '../api/bookSources';

const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 600);
  if (signal.aborted) { abort(); return; }
  signal.addEventListener('abort', abort, { once: true });
});
export function useBookDownload(onImport: (file: File, book: SourceBook) => Promise<void>) {
  const [task, setTask] = useState<BookDownloadTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<{ controller: AbortController; id?: string; leaseId?: string; importing: boolean } | null>(null);
  useEffect(() => () => {
    const run = active.current;
    if (run && !run.importing) { run.controller.abort(); if (run.id && run.leaseId) void bookSources.cancel(run.id, run.leaseId).catch(() => {}); }
  }, []);
  const start = async (book: SourceBook, format: string, userAuthorized = false) => {
    if (active.current) return;
    const run = { controller: new AbortController(), id: undefined as string | undefined, leaseId: undefined as string | undefined, importing: false };
    active.current = run; setBusy(true); setImporting(false); setError(''); setTask(null);
    const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(150_000)]);
    try {
      let current = await bookSources.start(book, format, signal, userAuthorized); run.id = current.id; run.leaseId = current.leaseId; setTask(current);
      while (current.state === 'queued' || current.state === 'running') {
        await pause(signal); current = await bookSources.status(current.id, signal); setTask(current);
      }
      if (current.state !== 'ready') throw new Error(current.message || '下载未完成，请重试');
      const file = await bookSources.file(current, signal);
      signal.throwIfAborted(); run.importing = true; setImporting(true);
      await onImport(file, userAuthorized && book.providerId === 'zlibrary'
        ? { ...book, rights: { ...book.rights, basis: 'user_authorized' } } : book);
    } catch (cause) {
      setError(run.controller.signal.aborted ? '已取消下载' : cause instanceof Error ? cause.message : '下载失败，请重试');
    } finally {
      if (run.id && run.leaseId) void bookSources.cancel(run.id, run.leaseId).catch(() => {});
      active.current = null; setBusy(false); setImporting(false);
    }
  };
  return { task, busy, importing, error, start, reset: () => { if (!active.current) { setError(''); setTask(null); } }, cancel: () => { if (!active.current?.importing) active.current?.controller.abort(); } };
}
