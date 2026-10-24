import { useEffect, useMemo, useState } from 'react';
import { getAsset } from './db';
import { formatSlackDuration, type SlackStatsWeek } from './stats';
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
  onFind,
  stats,
  countdownHidden,
  onShowCountdown,
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
  onFind: () => void;
  stats: SlackStatsWeek;
  countdownHidden: boolean;
  onShowCountdown: () => void;
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

  // 摸鱼回访的第一诉求是「接着上次看」：把最近打开的一本顶到首屏。
  const latest = useMemo(
    () => items.reduce<SlackItem | null>((best, item) => (!best || item.openedAt > best.openedAt ? item : best), null),
    [items],
  );
  const showContinue = Boolean(latest && (filter === 'all' || latest.kind === filter) && !query.trim());

  return (
    <main className="slack-library">
      {!ready ? (
        <p className="slack-loading" role="status">正在读取本地书架…</p>
      ) : !items.length ? (
        <div className="slack-empty slack-empty--hero">
          <div>
            <h2>书架还是空的</h2>
            <p>把 TXT / EPUB / 图片 / CBZ 拖到窗口任意位置，点「选择文件」导入，或者先去书源找一本。</p>
            <div className="slack-empty__actions">
              <button type="button" className="slack-primary" onClick={onUpload}>选择文件</button>
              <button type="button" className="slack-empty__find" onClick={onFind}>去找书 →</button>
            </div>
          </div>
          <img src="/slack/qwen.png" alt="" />
        </div>
      ) : (
        <>
          {stats.seconds > 0 || stats.chapters > 0 || stats.pages > 0 ? (
            <section className="slack-stats" aria-label="摸鱼周报">
              <span>本周摸鱼 <strong>{formatSlackDuration(stats.seconds)}</strong></span>
              <span>读完 <strong>{stats.chapters}</strong> 章{stats.pages > 0 ? <> · <strong>{stats.pages}</strong> 页</> : null}</span>
              {stats.streak > 1 ? <span>连续 <strong>{stats.streak}</strong> 天</span> : null}
            </section>
          ) : null}

          {showContinue && latest ? (
            <section className="slack-continue" aria-label="继续阅读">
              <button
                type="button"
                className="slack-continue__open"
                onClick={() => onOpen(latest.id)}
                title={`继续阅读《${latest.title}》`}
              >
                <Cover item={latest} />
                <div className="slack-continue__info">
                  <small>继续阅读 · {relativeTime(latest.openedAt)}</small>
                  <strong>{latest.title}</strong>
                  <span>{progressLabel(latest)}</span>
                </div>
                <div className="slack-continue__bar" aria-hidden="true">
                  <span style={{ width: `${Math.round(progressRatio(latest) * 100)}%` }} />
                </div>
                <span className="slack-continue__go" aria-hidden="true">继续 →</span>
              </button>
            </section>
          ) : null}

          <div className="slack-toolbar">
            <h1 className="slack-toolbar__title">我的焚决</h1>
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
            <button type="button" className="slack-add" onClick={onUpload}>＋ 添加资料</button>
            {countdownHidden ? (
              <button type="button" className="slack-countdown-toggle" onClick={onShowCountdown} title="显示下班倒计时挂件">⏱ 倒计时</button>
            ) : null}
          </div>
        </>
      )}

      {ready && items.length ? (
        filtered.length ? (
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
      ) : (
        <div className="slack-empty slack-empty--small">
          <h2>没有匹配的资料</h2>
          <p>换个关键词，或者切回「全部」。</p>
        </div>
      )) : null}
    </main>
  );
}
