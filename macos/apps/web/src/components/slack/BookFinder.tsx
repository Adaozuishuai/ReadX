import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { formatLabel } from './sources/types';
import type { WebBookSource, WebSearchResult } from './sources/web-types';
import { WebSourceFinder } from './WebSourceFinder';

const GUTENDEX = 'https://gutendex.com/books/';

type FinderSource = 'gutenberg' | 'web';

interface GutendexBook {
  id: number;
  title: string;
  authors: { name: string }[];
  summaries?: string[];
  languages: string[];
  download_count: number;
  formats: Record<string, string>;
}

interface GutendexResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: GutendexBook[];
}

interface FinderBook {
  key: string;
  source: 'gutenberg';
  sourceLabel: string;
  title: string;
  author: string;
  info: string;
  format: string;
  size: string;
  cover: string;
  detailUrl: string;
  description: string;
  gutenberg?: GutendexBook;
}

const SOURCE_TABS: { id: FinderSource; label: string; hint: string }[] = [
  { id: 'gutenberg', label: 'Project Gutenberg', hint: '公版书' },
  { id: 'web', label: '中文连载', hint: 'Legado 书源' },
];

const SOURCE_INTRO: Record<FinderSource, string> = {
  gutenberg: '搜索 Gutenberg 的英文公版书。下载 EPUB 或 TXT 后会自动放进 ReadX 本地书架。',
  web: '导入 Legado 书源 JSON，搜索中文连载小说。章节按需抓取并缓存，目录可随时更新。',
};

function bookFile(book: GutendexBook): { url: string; extension: 'epub' | 'txt' } | null {
  const epub = book.formats['application/epub+zip'];
  if (epub) return { url: epub, extension: 'epub' };
  const text = Object.entries(book.formats).find(([type]) => type.startsWith('text/plain'))?.[1];
  return text ? { url: text, extension: 'txt' } : null;
}

function checkedBookURL(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.gutenberg.org', 'gutenberg.org'].includes(url.hostname)) {
    throw new Error('下载地址不是 Project Gutenberg 的安全地址');
  }
  return url;
}

function gutenbergFinderBook(book: GutendexBook): FinderBook {
  const file = bookFile(book);
  return {
    key: `gutenberg:${book.id}`,
    source: 'gutenberg',
    sourceLabel: 'Project Gutenberg',
    title: book.title,
    author: book.authors.map((author) => author.name).join(', '),
    info: `${book.download_count.toLocaleString()} 次下载 · ${book.languages.join(', ').toUpperCase()}`,
    format: file?.extension ?? '',
    size: '',
    cover: book.formats['image/jpeg'] ?? '',
    detailUrl: `https://www.gutenberg.org/ebooks/${book.id}`,
    description: book.summaries?.[0] ?? '',
    gutenberg: book,
  };
}

function BookCover({ book }: { book: FinderBook }) {
  if (!book.cover) {
    return <div className="slack-finder__cover"><span>READ</span></div>;
  }
  return (
    <div className="slack-finder__cover">
      <img src={book.cover} alt="" loading="lazy" />
    </div>
  );
}

export function BookFinder({
  onImport,
  onImportWebNovel,
}: {
  onImport: (file: File, metadata: { title: string; author: string; source?: string }) => Promise<void>;
  onImportWebNovel: (source: WebBookSource, book: WebSearchResult) => Promise<void>;
}) {
  const [source, setSource] = useState<FinderSource>('gutenberg');
  const [query, setQuery] = useState('');
  const [requestURL, setRequestURL] = useState('');
  const [result, setResult] = useState<GutendexResponse | null>(null);
  const [gutenbergLoading, setGutenbergLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [licenseOpen, setLicenseOpen] = useState(false);

  useEffect(() => {
    if (source !== 'gutenberg' || !requestURL) return;
    const controller = new AbortController();
    let active = true;
    setGutenbergLoading(true);
    setError('');
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    void api.searchFreeBooks(requestURL, signal)
      .then((data) => {
        if (active) setResult(data);
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setResult(null);
      })
      .finally(() => {
        if (active) setGutenbergLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [requestURL, source]);

  const switchSource = (next: FinderSource) => {
    if (next === source) return;
    setSource(next);
    setError('');
    setRequestURL('');
    setResult(null);
    setGutenbergLoading(false);
  };

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) {
      setError('输入书名或作者再搜索');
      return;
    }
    if (source === 'gutenberg') {
      setRequestURL(`${GUTENDEX}?search=${encodeURIComponent(value)}&languages=en`);
      return;
    }
  };

  const download = async (book: FinderBook) => {
    if (downloading !== null) return;
    setDownloading(book.key);
    setError('');
    try {
      const sourceBook = book.gutenberg;
      if (!sourceBook) throw new Error('书目信息缺失');
      const fileInfo = bookFile(sourceBook);
      if (!fileInfo) throw new Error('这本书没有可导入的 EPUB 或 TXT 格式');
      const url = checkedBookURL(fileInfo.url);
      const blob = await api.downloadFreeBook(url.toString(), AbortSignal.timeout(120_000));
      if (!blob.size) throw new Error('下载文件为空');
      const safeTitle = sourceBook.title.replace(/[\\/:*?"<>|]/g, '_').trim() || `gutenberg-${sourceBook.id}`;
      const file = new File([blob], `${safeTitle}.${fileInfo.extension}`, {
        type: fileInfo.extension === 'epub' ? 'application/epub+zip' : 'text/plain;charset=utf-8',
      });
      await onImport(file, {
        title: sourceBook.title,
        author: sourceBook.authors.map((author) => author.name).join(', '),
        source: 'Project Gutenberg',
      });

    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloading(null);
    }
  };

  const renderBook = (book: FinderBook) => {
    const unavailable = !book.format;
    return (
      <article className="slack-finder__card" key={book.key}>
        <BookCover book={book} />
        <div className="slack-finder__details">
          <div className="slack-finder__badges">
            <span className={`slack-finder__source-badge slack-finder__source-badge--${book.source}`}>
              {book.sourceLabel}
            </span>
            {book.format ? (
              <span className={`slack-finder__format${unavailable ? ' unsupported' : ''}`}>
                {formatLabel(book.format)}
              </span>
            ) : null}
            {book.size ? <span className="slack-finder__size">{book.size}</span> : null}
          </div>
          <h2>{book.title}</h2>
          <p className="slack-finder__author">{book.author || '作者未知'}</p>
          {book.info ? <p className="slack-finder__meta">{book.info}</p> : null}
          {book.description ? <p className="slack-finder__description">{book.description}</p> : null}
          <div className="slack-finder__actions">
            <button
              type="button"
              className="slack-primary slack-finder__download"
              disabled={downloading !== null || unavailable}
              onClick={() => void download(book)}
            >
              {downloading === book.key
                ? '下载并导入中…'
                : unavailable
                  ? book.format
                    ? `${formatLabel(book.format)} 暂不支持`
                    : '没有可用格式'
                  : book.format
                    ? `下载 ${formatLabel(book.format)} 并加入书架`
                    : '下载并加入书架'}
            </button>
            <a className="slack-finder__open" href={book.detailUrl} target="_blank" rel="noreferrer">
              在网页中打开 ↗
            </a>
          </div>
        </div>
      </article>
    );
  };

  const busy = source === 'gutenberg' && gutenbergLoading;

  return (
    <main className="slack-finder">
      <section className="slack-finder__hero">
        <p className="slack-eyebrow">BOOK SOURCES · 多源检索</p>
        <h1>找本书读</h1>
        <p>{SOURCE_INTRO[source]}</p>

        <div className="slack-finder__sources" role="tablist" aria-label="书源">
          {SOURCE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={source === tab.id}
              className={source === tab.id ? 'active' : ''}
              onClick={() => switchSource(tab.id)}
            >
              <strong>{tab.label}</strong>
              <small>{tab.hint}</small>
            </button>
          ))}
        </div>

        {source === 'web' ? null : (
          <form className="slack-finder__search" onSubmit={search}>
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                '搜索书名或作者，例如 Pride and Prejudice'
              }
              aria-label="搜索书籍"
            />
            <button type="submit" disabled={busy}>{busy ? '搜索中…' : '搜索'}</button>
          </form>
        )}
      </section>

      {source === 'web' ? (
        <WebSourceFinder onImport={onImportWebNovel} />
      ) : (
        <>
          {error ? <p className="slack-finder__error" role="alert">{error}</p> : null}
          {busy ? <p className="slack-loading" role="status">正在查询书目…</p> : null}

          {source === 'gutenberg' ? (
        !busy && result ? (
          <>
            <div className="slack-finder__summary">
              <strong>{result.count.toLocaleString()} 本书</strong>
              <span>仅显示含 EPUB 或 TXT 下载格式的条目</span>
            </div>
            {result.results.length ? (
              <div className="slack-finder__grid">
                {result.results.map((book) => renderBook(gutenbergFinderBook(book)))}
              </div>
            ) : (
              <div className="slack-empty slack-empty--small"><h2>没有找到可导入的书</h2><p>试试更短的书名或作者名。</p></div>
            )}
            {result.previous || result.next ? (
              <nav className="slack-finder__pages" aria-label="书目分页">
                <button type="button" disabled={!result.previous || busy} onClick={() => result.previous && setRequestURL(result.previous)}>上一页</button>
                <button type="button" disabled={!result.next || busy} onClick={() => result.next && setRequestURL(result.next)}>下一页</button>
              </nav>
            ) : null}
          </>
        ) : null
      ) : null}

          {source === 'gutenberg' && !requestURL && !gutenbergLoading ? (
            <div className="slack-finder__note">
              <span aria-hidden="true">✦</span>
              <p>由 Project Gutenberg 提供书目和文件。公版状态因地区而异，请按所在地规则使用。</p>
              <a href="https://www.gutenberg.org/" target="_blank" rel="noreferrer">访问 Project Gutenberg ↗</a>
            </div>
          ) : null}
        </>
      )}

      <div className="slack-finder__legal">
        <button type="button" onClick={() => setLicenseOpen(true)}>许可信息</button>
      </div>

      {licenseOpen ? (
        <div
          className="slack-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="slack-license-title"
          onClick={() => setLicenseOpen(false)}
        >
          <div className="slack-modal__card slack-license" onClick={(event) => event.stopPropagation()}>
            <h2 id="slack-license-title">许可与源码</h2>
            <p>
              ReadX 按 MIT 许可发布。本应用内的书源检索、解析和导入适配器均为 ReadX 独立实现。许可正文见工程根目录的 <code>LICENSE</code>。
            </p>
            <p>
              源码随 ReadX 源码工程提供；已安装的应用包不包含完整工程。
            </p>
            <div className="slack-modal__actions">
              <button type="button" onClick={() => setLicenseOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
