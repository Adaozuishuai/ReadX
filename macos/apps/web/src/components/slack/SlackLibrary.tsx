import { useEffect, useMemo, useState } from 'react';
import { getAsset } from './db';
import type { SlackItem } from './types';

export type SlackFilter = 'all' | 'novel' | 'comic';

function progressRatio(item: SlackItem): number {
  if (item.kind === 'comic') {
    if (!item.pageCount) return 0;
    return Math.min(1, (item.progress.page + 1) / item.pageCount);
  }
  if (!item.chapterCount) return 0;
  return Math.min(1, (item.progress.chapter + item.progress.scroll) / item.chapterCount);
}

function progressLabel(item: SlackItem): string {
  if (item.kind === 'comic') {
    if (!item.pageCount) return '还没有页面';
    return `第 ${Math.min(item.progress.page + 1, item.pageCount)} / ${item.pageCount} 页`;
  }
  if (!item.chapterCount) return '还没有章节';
  return `第 ${Math.min(item.progress.chapter + 1, item.chapterCount)} / ${item.chapterCount} 章`;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60 * 1000) return '刚刚';
  if (delta < 60 * 60 * 1000) return `${Math.floor(delta / 60000)} 分钟前`;
  if (delta < 24 * 60 * 60 * 1000) return `${Math.floor(delta / 3600000)} 小时前`;
  if (delta < 48 * 60 * 60 * 1000) return '昨天';
  const date = new Date(timestamp);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function Cover({ item }: { item: SlackItem }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!item.coverAssetId) {
      setUrl('');
      return;
    }
    let cancelled = false;
    let objectURL = '';
    void getAsset(item.coverAssetId).then((asset) => {
      if (cancelled || !asset) return;
      objectURL = URL.createObjectURL(asset.blob);
      setUrl(objectURL);
    });
    return () => {
      cancelled = true;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [item.coverAssetId]);

  return (
    <div className={`slack-cover slack-cover--tone-${item.coverTone}`}>
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <div className="slack-cover__fallback">
          <span>{item.title.slice(0, 12)}</span>
          <small>{item.kind === 'novel' ? 'NOVEL' : 'COMIC'}</small>
        </div>
      )}
      <span className="slack-cover__kind">
        {item.kind === 'novel' ? (item.serial ? '连载' : '小说') : '漫画'}
      </span>
    </div>
  );
}

export function SlackLibrary({
  items,
  ready,
  query,
  onQuery,
  filter,
  onFilter,
  onOpen,
  onDelete,
  onUpload,
}: {
  items: SlackItem[];
  ready: boolean;
  query: string;
  onQuery: (value: string) => void;
  filter: SlackFilter;
  onFilter: (value: SlackFilter) => void;
  onOpen: (id: string) => void;
  onDelete: (item: SlackItem) => void;
  onUpload: () => void;
}) {
  const novels = items.filter((item) => item.kind === 'novel').length;
  const comics = items.filter((item) => item.kind === 'comic').length;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.kind !== filter) return false;
      if (!keyword) return true;
      return `${item.title} ${item.author}`.toLowerCase().includes(keyword);
    });
  }, [filter, items, query]);

  return (
    <main className="slack-library">
      <section className="slack-hero">
        <div className="slack-hero__copy">
          <p className="slack-eyebrow">LOCAL SHELF · 只存本机</p>
          <h1>我的资料</h1>
          <p>
            把 TXT、EPUB、图片或 CBZ 拖进来。正文和图片都保存在本机浏览器，不上传服务器，
            随时点「返回工作区」或按 Esc 一键切回去。
          </p>
          <div className="slack-hero__stats">
            <span><strong>{items.length}</strong> 份资料</span>
            <span><strong>{novels}</strong> 本小说</span>
            <span><strong>{comics}</strong> 本漫画</span>
          </div>
        </div>
        <button type="button" className="slack-upload" onClick={onUpload}>
          <span className="slack-upload__plus" aria-hidden="true">＋</span>
          <strong>添加资料</strong>
          <small>拖拽文件到窗口也可以</small>
        </button>
      </section>

      <div className="slack-toolbar">
        <div className="slack-filters" role="group" aria-label="资料类型">
          {([
            ['all', `全部 ${items.length}`],
            ['novel', `小说 ${novels}`],
            ['comic', `漫画 ${comics}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={filter === value ? 'active' : ''}
              onClick={() => onFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="slack-search">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索标题 / 作者"
            aria-label="搜索本地资料"
          />
        </label>
      </div>

      {!ready ? (
        <p className="slack-loading" role="status">正在读取本地书架…</p>
      ) : filtered.length ? (
        <div className="slack-grid">
          {filtered.map((item) => {
            const ratio = progressRatio(item);
            const size = formatSize(item.sizeBytes);
            return (
              <article className="slack-card" key={item.id}>
                <button
                  type="button"
                  className="slack-card__open"
                  onClick={() => onOpen(item.id)}
                  title={`继续阅读《${item.title}》`}
                >
                  <Cover item={item} />
                  <div className="slack-card__body">
                    <strong>{item.title}</strong>
                    <small>{item.author || (item.kind === 'novel' ? `${item.chapterCount} 章` : `${item.pageCount} 页`)}</small>
                    <div className="slack-card__progress" aria-hidden="true">
                      <span style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </div>
                    <span className="slack-card__meta">
                      {item.source ? <span className="slack-card__source">{item.source}</span> : null}
                      {progressLabel(item)} · {relativeTime(item.openedAt)}
                      {size ? ` · ${size}` : ''}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  className="slack-card__delete"
                  onClick={() => onDelete(item)}
                  title="从本地文库删除"
                  aria-label={`删除《${item.title}》`}
                >
                  ×
                </button>
              </article>
            );
          })}
        </div>
      ) : items.length ? (
        <div className="slack-empty slack-empty--small">
          <h2>没有匹配的资料</h2>
          <p>换个关键词，或者切回「全部」。</p>
        </div>
      ) : (
        <div className="slack-empty">
          <img src="/slack/qwen.png" alt="" />
          <div>
            <h2>书架还是空的</h2>
            <p>拖入 TXT / EPUB / 图片 / CBZ，或者点「添加资料」。</p>
            <button type="button" className="slack-primary" onClick={onUpload}>选择文件</button>
          </div>
        </div>
      )}
    </main>
  );
}
