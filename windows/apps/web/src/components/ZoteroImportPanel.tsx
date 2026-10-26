import { useEffect, useRef, useState } from 'react';
import { zotero, type ZoteroCollection, type ZoteroPage, type ZoteroSelection } from '../api/zotero';
import './zotero-import.css';

export function ZoteroImportPanel({ busy, queuedKeys, onAdd }: {
  busy: boolean; queuedKeys: Set<string>; onAdd: (selection: ZoteroSelection[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<ZoteroCollection[]>([]);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState('');
  const [start, setStart] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<ZoteroPage | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Map<string, ZoteroSelection>>(() => new Map());
  const headerCheckbox = useRef<HTMLInputElement>(null);
  const available = page?.items.flatMap(item => item.attachments.filter(attachment => !queuedKeys.has(attachment.key)).map(attachment => ({ item, attachment }))) ?? [];
  const selectedCount = [...selected.keys()].filter(key => !queuedKeys.has(key)).length;
  const checkedCount = available.filter(({ attachment }) => selected.has(attachment.key)).length;

  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    setConnecting(true); setConnected(false); setError('');
    void zotero.collections(request.signal).then(result => {
      setCollections(result.collections); setConnected(true);
    }).catch(cause => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!request.signal.aborted) setConnecting(false); });
    return () => request.abort();
  }, [open, revision]);

  useEffect(() => {
    if (!open || !connected) return;
    const request = new AbortController();
    setLoading(true); setPage(null); setError('');
    const timer = window.setTimeout(() => {
      void zotero.items(query, collection, start, request.signal).then(setPage)
        .catch(cause => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { if (!request.signal.aborted) setLoading(false); });
    }, 250);
    return () => { window.clearTimeout(timer); request.abort(); };
  }, [open, connected, query, collection, start, revision]);

  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = checkedCount > 0 && checkedCount < available.length;
  }, [checkedCount, available.length]);

  const toggle = (entry: ZoteroSelection, checked: boolean) => setSelected(current => {
    const next = new Map(current);
    if (checked) next.set(entry.attachment.key, entry); else next.delete(entry.attachment.key);
    return next;
  });

  return <section className="zotero-import">
    <button type="button" className="zotero-import-toggle" aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}>
      <span className="zotero-import-mark" aria-hidden="true">Z</span><span>从 Zotero 导入</span><span className="zotero-import-chevron" aria-hidden="true">{open ? '−' : '+'}</span>
    </button>
    {open && <div className="zotero-import-body">
      <div className="zotero-import-connection"><span>{connecting ? '正在连接本机 Zotero…' : connected ? '本机 Zotero · 我的文库' : '打开 Zotero 后连接本机资料库'}</span><button type="button" disabled={busy || connecting} onClick={() => setRevision(value => value + 1)}>重新连接</button></div>
      {!connected && !connecting && <p className="zotero-import-help">需要 Zotero 7 或更新版本。在「设置 → 高级」中启用「允许此计算机上的其他应用程序与 Zotero 通信」。</p>}
      {connected && <>
        <div className="zotero-import-filters">
          <input aria-label="搜索 Zotero 文献" placeholder="搜索标题、作者" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setStart(0); }} />
          <select aria-label="Zotero 分类" value={collection} disabled={busy} onChange={event => { setCollection(event.target.value); setStart(0); }}>
            <option value="">全部分类</option>{collections.map(item => <option key={item.key} value={item.key}>{item.parent ? `${collections.find(parent => parent.key === item.parent)?.name ?? ''} / ` : ''}{item.name}</option>)}
          </select>
        </div>
        {loading ? <p className="zotero-import-empty" role="status">正在读取文献与 PDF 附件…</p> : page && <>
          <div className="zotero-import-list-heading"><label><input ref={headerCheckbox} type="checkbox" disabled={busy || !available.length} checked={available.length > 0 && checkedCount === available.length} onChange={event => {
            const checked = event.target.checked;
            setSelected(current => { const next = new Map(current); for (const entry of available) { if (checked) next.set(entry.attachment.key, entry); else next.delete(entry.attachment.key); } return next; });
          }} />选择本页 PDF</label><span>{page.total} 条文献</span></div>
          <div className="zotero-import-list">
            {page.items.map(item => <article className="zotero-import-item" key={item.key}>
              <h3>{item.title || '未命名文献'}</h3>
              <p>{[item.authors.slice(0, 3).join(' · '), item.year, item.venue].filter(Boolean).join(' / ')}</p>
              {item.attachments.map(attachment => <label className="zotero-import-attachment" key={attachment.key}><input type="checkbox" disabled={busy || queuedKeys.has(attachment.key)} checked={queuedKeys.has(attachment.key) || selected.has(attachment.key)} onChange={event => toggle({ item, attachment }, event.target.checked)} /><span>{attachment.name}</span>{queuedKeys.has(attachment.key) && <small>已加入队列</small>}</label>)}
              {!item.attachments.length && <small className={item.error ? 'text-bad' : 'zotero-import-no-pdf'}>{item.error || '无 PDF 附件'}</small>}
            </article>)}
            {!page.items.length && <p className="zotero-import-empty">没有找到文献</p>}
          </div>
          <div className="zotero-import-pagination"><button type="button" disabled={busy || start === 0} onClick={() => setStart(value => Math.max(0, value - 40))}>上一页</button><span>{page.items.length ? `${start + 1}–${start + page.items.length}` : '0'} / {page.total}</span><button type="button" disabled={busy || !page.hasMore} onClick={() => setStart(value => value + 40)}>下一页</button></div>
        </>}
      </>}
      {error && <p className="zotero-import-error" role="alert">{error}</p>}
      {connected && <div className="zotero-import-actions"><span>已选 {selectedCount} 个 PDF</span><button type="button" className="primary-button" disabled={busy || !selectedCount} onClick={() => void onAdd([...selected.values()].filter(entry => !queuedKeys.has(entry.attachment.key)))}>{busy ? '处理中…' : `加入导入队列${selectedCount ? `（${selectedCount}）` : ''}`}</button></div>}
    </div>}
  </section>;
}
