import { useCallback, useEffect, useRef, useState } from 'react';
import { getAssets } from './db';
import type { SlackAsset, SlackItem, SlackProgress } from './types';

type Fit = 'page' | 'width';

export function ComicReader({
  item,
  onProgress,
}: {
  item: SlackItem;
  onProgress: (progress: SlackProgress) => void;
}) {
  const [pages, setPages] = useState<SlackAsset[] | null>(null);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, item.progress.page));
  const [rtl, setRtl] = useState(false);
  const [fit, setFit] = useState<Fit>('page');
  const [zoom, setZoom] = useState(100);
  const [, setLoaded] = useState(0);
  const urls = useRef<Map<number, string>>(new Map());
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  useEffect(() => {
    let cancelled = false;
    void getAssets(item.id)
      .then((list) => {
        if (!cancelled) setPages(list);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  useEffect(() => {
    if (!pages?.length) return;
    setIndex((current) => Math.min(current, pages.length - 1));
  }, [pages]);

  // 只给当前页和前后两页建 blob URL；滚远了就回收，避免一本几百页的漫画把内存吃满。
  useEffect(() => {
    if (!pages?.length) return;
    const cache = urls.current;
    for (const [order, url] of cache) {
      if (Math.abs(order - index) > 4) {
        URL.revokeObjectURL(url);
        cache.delete(order);
      }
    }
    for (const order of [index - 1, index, index + 1, index + 2]) {
      if (order < 0 || order >= pages.length || cache.has(order)) continue;
      const asset = pages[order];
      if (!asset) continue;
      cache.set(order, URL.createObjectURL(asset.blob));
    }
    setLoaded((value) => value + 1);
  }, [index, pages]);

  useEffect(
    () => () => {
      for (const url of urls.current.values()) URL.revokeObjectURL(url);
      urls.current.clear();
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      progressRef.current({ chapter: 0, page: index, scroll: 0 });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [index]);

  const count = pages?.length ?? item.pageCount;
  const step = useCallback(
    (direction: 'next' | 'prev') => {
      setIndex((current) => {
        const next = current + (direction === 'next' ? 1 : -1);
        return Math.min(Math.max(next, 0), Math.max(count - 1, 0));
      });
    },
    [count],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        step(rtl ? 'prev' : 'next');
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        step(rtl ? 'next' : 'prev');
      } else if (event.key === ' ' || event.key === 'PageDown') {
        event.preventDefault();
        step('next');
      } else if (event.key === 'PageUp' || event.key === 'Backspace') {
        event.preventDefault();
        step('prev');
      } else if (event.key === 'Home') {
        event.preventDefault();
        setIndex(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        setIndex(Math.max(count - 1, 0));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [count, rtl, step]);

  const current = pages?.[index];
  const currentUrl = current ? urls.current.get(index) : undefined;
  const nextUrl = urls.current.get(index + 1);
  const afterUrl = urls.current.get(index + 2);

  if (error) {
    return <div className="slack-comic__error"><p>漫画加载失败：{error}</p></div>;
  }

  return (
    <div className={`slack-comic slack-comic--${fit}`}>
      <div className="slack-comic__stage">
        {pages === null ? (
          <p className="slack-comic__loading" role="status">正在读取漫画页…</p>
        ) : currentUrl ? (
          <img
            key={current?.id ?? index}
            className="slack-comic__image"
            src={currentUrl}
            alt={`第 ${index + 1} 页`}
            draggable={false}
            style={fit === 'width' ? { width: `${zoom}%` } : undefined}
          />
        ) : (
          <p className="slack-comic__loading" role="status">正在解码第 {index + 1} 页…</p>
        )}

        <button
          type="button"
          className="slack-comic__zone slack-comic__zone--left"
          onClick={() => step(rtl ? 'next' : 'prev')}
          aria-label={rtl ? '下一页' : '上一页'}
        />
        <button
          type="button"
          className="slack-comic__zone slack-comic__zone--right"
          onClick={() => step(rtl ? 'prev' : 'next')}
          aria-label={rtl ? '上一页' : '下一页'}
        />

        <div className="slack-comic__preload" aria-hidden="true">
          {nextUrl ? <img src={nextUrl} alt="" /> : null}
          {afterUrl ? <img src={afterUrl} alt="" /> : null}
        </div>

        {count <= 1 ? <span className="slack-comic__single">单页</span> : null}
      </div>

      <div className="slack-comic__bar">
        <div className="slack-comic__nav">
          <button
            type="button"
            onClick={() => step(rtl ? 'next' : 'prev')}
            disabled={rtl ? index >= count - 1 : index <= 0}
            aria-label={rtl ? '下一页' : '上一页'}
          >
            ‹
          </button>
          <input
            type="range"
            min={1}
            max={Math.max(count, 1)}
            value={index + 1}
            onChange={(event) => setIndex(Number(event.target.value) - 1)}
            aria-label="页码"
          />
          <span className="slack-comic__count">{index + 1} / {count}</span>
          <button
            type="button"
            onClick={() => step(rtl ? 'prev' : 'next')}
            disabled={rtl ? index <= 0 : index >= count - 1}
            aria-label={rtl ? '上一页' : '下一页'}
          >
            ›
          </button>
        </div>

        <div className="slack-comic__tools">
          <button
            type="button"
            className={fit === 'page' ? 'active' : ''}
            onClick={() => setFit((value) => (value === 'page' ? 'width' : 'page'))}
            title="在整页 / 适宽之间切换"
          >
            {fit === 'page' ? '整页' : '适宽'}
          </button>
          {fit === 'width' ? (
            <>
              <button type="button" onClick={() => setZoom((value) => Math.max(50, value - 10))} aria-label="缩小">−</button>
              <span className="slack-comic__zoom">{zoom}%</span>
              <button type="button" onClick={() => setZoom((value) => Math.min(200, value + 10))} aria-label="放大">＋</button>
            </>
          ) : null}
          <button
            type="button"
            className={rtl ? 'active' : ''}
            onClick={() => setRtl((value) => !value)}
            title="切换日漫从右往左翻页"
          >
            从右往左
          </button>
        </div>
      </div>
    </div>
  );
}
