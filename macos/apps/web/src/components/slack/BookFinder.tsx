import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bookSources, mayDownload, readableFormats, type BookSource, type SourceBook, type BookSearchResult } from '../../api/bookSources';
import { useBookDownload } from '../../hooks/useBookDownload';
import { WebSourceFinder } from './WebSourceFinder';
import { ZLibraryConnection } from './ZLibraryConnection';
import { SourceBookCover } from './SourceBookCover';
import { ApiError } from '../../api/client';
import type { DownloadedBookMetadata, SlackItem } from './types';
import type { WebBookSource, WebSearchResult } from './sources/web-types';

const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const bytes = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const sourceLink = (raw?: string) => { try { const u = new URL(raw ?? ''); return u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; } };

export function BookFinder({ onImport, onImportWebNovel, onUpload, items, onOpen }: {
  onImport: (file: File, metadata: DownloadedBookMetadata) => Promise<void>;
  onImportWebNovel: (source: WebBookSource, book: WebSearchResult) => Promise<void>;
  onUpload: () => void; items: SlackItem[]; onOpen: (id: string) => void;
}) {
  const [sources, setSources] = useState<BookSource[]>([]);
  const [source, setSource] = useState('gutenberg');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [pageCursor, setPageCursor] = useState('');
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const [result, setResult] = useState<BookSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SourceBook | null>(null);
  const [format, setFormat] = useState('');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [settings, setSettings] = useState(false);
  const searchRun = useRef<AbortController | null>(null);
  const detailRun = useRef<AbortController | null>(null);
  const current = sources.find(item => item.providerId === source);
  const refreshSources = () => {
    setConnectionRevision(value => value + 1);
    searchRun.current?.abort(); detailRun.current?.abort(); setResult(null); setDetail(null); setLoading(false);
    void bookSources.list().then(data => setSources(data.sources)).catch(cause => setError(failure(cause)));
  };
  const download = useBookDownload(async (file, book) => {
    await onImport(file, {
      title: book.title, author: book.authors.join(', '),
      source: sources.find(item => item.providerId === book.providerId)?.name ?? book.providerId,
      providerId: book.providerId, providerBookId: book.id, sourceUrl: book.sourceUrl,
      sourceLicense: book.rights.basis,
    });
  });
  useEffect(() => {
    const controller = new AbortController();
    void bookSources.list(controller.signal).then(data => setSources(data.sources)).catch(cause => { if (!controller.signal.aborted) setError(failure(cause)); });
    return () => { controller.abort(); searchRun.current?.abort(); detailRun.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!detail && !settings) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      if (!download.busy) { setDetail(null); setSettings(false); }
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [detail, settings, download.busy]);
  const switchSource = (next: string) => {
    searchRun.current?.abort(); detailRun.current?.abort(); setSource(next); setError(''); setResult(null); setSearched(''); setPageCursor(''); setPageHistory([]); setLoading(false); setDetail(null);
  };
  const search = async (cursor = '', useSearched = false) => {
    const q = cursor || useSearched ? searched : query.trim();
    if (!q) { setError('请输入书名或作者'); return; }
    searchRun.current?.abort(); const controller = new AbortController(); searchRun.current = controller;
    setLoading(true); setError(''); setSearched(q);
    try {
      const data = await bookSources.search(source, q, cursor, controller.signal);
      if (!controller.signal.aborted) {
        setResult(data); setPageCursor(cursor);
        setPageHistory(history => !cursor ? [] : cursor === pageCursor ? history : history.at(-1) === cursor ? history.slice(0, -1) : [...history, pageCursor]);
      }
    }
    catch (cause) { if (!controller.signal.aborted) {
      setError(failure(cause)); setResult(null);
      if (source === 'zlibrary' && cause instanceof ApiError && cause.status === 401) refreshSources();
    } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const showDetail = async (book: SourceBook) => {
    setRightsConfirmed(false);
    download.reset();
    detailRun.current?.abort(); const controller = new AbortController(); detailRun.current = controller; setError(''); setLoading(true);
    try { const data = await bookSources.detail(book.providerId, book.id, controller.signal); if (!controller.signal.aborted) { setDetail(data); setFormat(readableFormats(data)[0] ?? ''); } }
    catch (cause) { if (!controller.signal.aborted) {
      setError(failure(cause));
      if (book.providerId === 'zlibrary' && cause instanceof ApiError && cause.status === 401) refreshSources();
    } }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const existing = detail && items.find(item => item.providerId === detail.providerId && item.providerBookId === detail.id);
  const submit = (event: FormEvent) => { event.preventDefault(); void search(); };
  return <main className="slack-finder">
    <section className="slack-finder__hero">
      <div className="book-source-heading"><h1>找本书读</h1><button type="button" onClick={() => setSettings(true)}>书源设置</button></div>
      <div className="slack-finder__sources" role="tablist" aria-label="书源">
        {sources.map(item => <button type="button" role="tab" aria-selected={source === item.providerId} className={source === item.providerId ? 'active' : ''} key={item.providerId} disabled={download.busy} onClick={() => switchSource(item.providerId)}>
          <strong>{item.name}</strong><small>{item.enabled ? (item.capabilities.requiresAuth ? '账号书源' : '可检索') : '未启用'}</small>
        </button>)}
        <button type="button" role="tab" aria-selected={source === 'web'} className={source === 'web' ? 'active' : ''} disabled={download.busy} onClick={() => switchSource('web')}><strong>中文连载</strong><small>Legado 书源</small></button>
      </div>
      {source !== 'web' && <p>{current?.reason ?? '正在读取书源…'}</p>}
      {current?.enabled && current.capabilities.search && <form className="slack-finder__search" onSubmit={submit}>
        <span aria-hidden="true">⌕</span><input aria-label="搜索书籍" placeholder="搜索书名或作者" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} />
        <button type="submit" disabled={loading || download.busy}>{loading ? '查询中…' : '搜索'}</button>
      </form>}
    </section>
    {error && <p className="slack-finder__error" role="alert">{error}<button type="button" onClick={() => void search()}>重试搜索</button></p>}
    {source === 'zlibrary' && !settings && <ZLibraryConnection onChange={refreshSources} refreshKey={connectionRevision} />}
    {source === 'web' ? <WebSourceFinder onImport={onImportWebNovel} /> : <>
      {loading && <p role="status" className="slack-loading">正在查询书目…</p>}
      {current && !current.enabled && <section className="slack-finder__note"><p>这个书源暂时不可用，可切换到其他书源；本地文件请回到书架导入。</p></section>}
      {!loading && result && <>
        <p className="slack-finder__summary">本页 {result.books.length} 本书 · 选择书籍查看格式与来源许可</p>
        {result.books.length ? <div className="slack-finder__grid">{result.books.map(book => {
          const format = book.formats.find(value => /epub|txt/i.test(value));
          const openDetail = () => { if (!download.busy) void showDetail(book); };
          return <article key={`${book.providerId}:${book.id}`} className="slack-finder__card" role="button" tabIndex={0}
            aria-label={`查看《${book.title}》详情与格式`}
            onClick={openDetail}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); } }}>
            <SourceBookCover book={book} />
            <div className="slack-finder__details"><div className="slack-finder__badges">
              <span className="slack-finder__source-badge">{current?.name}</span>
              {format ? <span className="slack-finder__format">{format.toUpperCase()}</span> : null}
            </div>
              <h2>{book.title}</h2><p className="slack-finder__author">{book.authors.join(', ') || '作者未知'}</p><p className="slack-finder__description">{book.description}</p>
              <span className="slack-finder__open">查看详情与格式 →</span>
            </div>
          </article>;
        })}</div> : <div className="slack-empty slack-empty--small"><h2>没有找到书籍</h2><p>试试更短的书名或作者名。</p></div>}
        <nav className="slack-finder__pages" aria-label="书目分页"><button type="button" disabled={!pageHistory.length || loading || download.busy} onClick={() => void search(pageHistory.at(-1), true)}>上一页</button><span>第 {pageHistory.length + 1} 页</span><button type="button" disabled={!result.nextCursor || loading || download.busy} onClick={() => void search(result.nextCursor)}>下一页</button></nav>
      </>}
    </>}
    {settings && <div className="slack-modal" role="dialog" aria-modal="true" aria-labelledby="source-settings-title"><div className="slack-modal__card book-source-dialog"><h2 id="source-settings-title">书源设置</h2>
      <ZLibraryConnection onChange={refreshSources} refreshKey={connectionRevision} />
      {sources.map(item => <section key={item.providerId}><strong>{item.name} · {item.enabled ? '可用' : '未启用'}</strong><p>{item.reason}</p><small>搜索 {item.capabilities.search ? '✓' : '—'} · 详情 {item.capabilities.detail ? '✓' : '—'} · 下载 {item.capabilities.download ? '✓' : '—'}</small></section>)}
      <p>OPDS 当前使用已登记的 Gutenberg 官方目录。新增目录需要服务端适配，不在浏览器保存站点凭据。</p><button type="button" onClick={() => setSettings(false)}>关闭</button>
    </div></div>}
    {detail && <div className="slack-modal" role="dialog" aria-modal="true" aria-labelledby="book-detail-title"><div className="slack-modal__card book-source-dialog">
      <h2 id="book-detail-title">{detail.title}</h2><p>{detail.authors.join(', ')}</p><p>{detail.description}</p>
      <dl><dt>来源</dt><dd>{current?.name}</dd><dt>语言</dt><dd>{detail.language || '未提供'}</dd><dt>书籍编号</dt><dd>{detail.id}</dd><dt>权利状态</dt><dd>{detail.rights.access === 'allowed' ? '允许获取' : detail.rights.access === 'denied' ? '不允许获取' : '尚未明确'} · {detail.rights.reason}</dd></dl>
      {readableFormats(detail).length ? <label>文件格式 <select aria-label="下载格式" value={format} disabled={download.busy} onChange={event => setFormat(event.target.value)}>{readableFormats(detail).map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label> : <p>没有可导入的 EPUB/TXT。PDF 请从科研书库导入。</p>}
      {detail.requiresRightsConfirmation && <label className="zlibrary-rights-confirm"><input type="checkbox" checked={rightsConfirmed} disabled={download.busy} onChange={event => setRightsConfirmed(event.target.checked)} />我有权下载、保存并阅读这本书</label>}
      {existing && <p>此书已在书架。可以打开已有版本；再次导入会保留旧版本及阅读进度，相同文件会跳过。</p>}
      {download.busy && <div className="book-download-progress" role="status"><p>{download.importing ? '校验完成，正在导入本地书架…' : download.task?.state === 'queued' ? '等待下载…' : '正在下载并校验…'}</p><progress max={download.task?.totalBytes || undefined} value={download.task?.totalBytes ? download.task.receivedBytes : undefined} /><span>{bytes(download.task?.receivedBytes ?? 0)}{download.task?.totalBytes ? ` / ${bytes(download.task.totalBytes)}` : ''}</span><button type="button" disabled={download.importing} onClick={download.cancel}>取消下载</button></div>}
      {download.error && <p role="alert" className="slack-finder__error">{download.error}</p>}
      <div className="slack-modal__actions">
        {existing && <button type="button" disabled={download.busy} onClick={() => onOpen(existing.id)}>打开已有版本</button>}
        <button type="button" className="slack-primary" disabled={download.busy || !mayDownload(detail, rightsConfirmed) || !format} onClick={() => void download.start(detail, format, rightsConfirmed)}>{existing ? '保留旧版并导入' : download.error ? '重试下载并阅读' : '下载并阅读'}</button>
        {sourceLink(detail.sourceUrl) && <a href={sourceLink(detail.sourceUrl)} target="_blank" rel="noreferrer">查看来源 ↗</a>}
        {!mayDownload(detail) && <button type="button" onClick={onUpload}>导入本地文件</button>}
        <button type="button" disabled={download.busy} onClick={() => { detailRun.current?.abort(); setDetail(null); }}>关闭</button>
      </div>
    </div></div>}
  </main>;
}
