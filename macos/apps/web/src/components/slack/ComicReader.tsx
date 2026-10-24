import { useCallback, useEffect, useRef, useState } from 'react';
import { getAssets } from './db';
import type { SlackAsset, SlackItem, SlackProgress } from './types';
import { STORAGE_KEYS } from '../../lib/storage';
import { recordPages } from './stats';

type Fit = 'page' | 'width';
type ComicPrefs = { fit: Fit; rtl: boolean; double: boolean };

const PREFS_KEY = STORAGE_KEYS.comicPrefs;

function readPrefs(): ComicPrefs {
  const fallback: ComicPrefs = { fit: 'page', rtl: false, double: false };
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ComicPrefs>;
    return {
      fit: parsed.fit === 'width' ? 'width' : 'page',
      rtl: typeof parsed.rtl === 'boolean' ? parsed.rtl : fallback.rtl,
      double: typeof parsed.double === 'boolean' ? parsed.double : fallback.double,
    };
  } catch {
    return fallback;
  }
}

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
  const [prefs, setPrefs] = useState<ComicPrefs>(readPrefs);
  const { fit, rtl, double } = prefs;
  const updatePrefs = (patch: Partial<ComicPrefs>) => setPrefs((current) => ({ ...current, ...patch }));
  const [zoom, setZoom] = useState(100);
  const [, setLoaded] = useState(0);
  // 底栏自动隐藏：翻页后淡出，指针移到页面底部或键盘聚焦时再出现。
  const [barShown, setBarShown] = useState(true);
  const barHover = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const [pipToken, setPipToken] = useState(0);
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
    for (const order of [index - 1, index, index + 1, index + 2, index + 3]) {
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
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍然生效。 */
    }
  }, [prefs]);

  // 摸鱼周报：正向翻了几页就记几页，回翻不重复计。
  const statPage = useRef(index);
  useEffect(() => {
    const delta = index - statPage.current;
    statPage.current = index;
    if (delta > 0) recordPages(delta);
  }, [index]);

  const cancelHide = useCallback(() => window.clearTimeout(hideTimer.current), []);
  const hideBarSoon = useCallback((delay = 1600) => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setBarShown(false), delay);
  }, []);
  const showBar = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    setBarShown(true);
  }, []);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);
  useEffect(() => {
    hideBarSoon(2400);
  }, [hideBarSoon]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      progressRef.current({ chapter: 0, page: index, scroll: 0 });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [index]);

  // 翻页或跳页后短暂亮一下页码，底栏藏起来时也有反馈。
  useEffect(() => {
    setPipToken((value) => value + 1);
  }, [index]);

  const count = pages?.length ?? item.pageCount;
  // 双页只在整页模式下成立：适宽需要横向滚动，两页并排会互相挤压。
  const spreadView = double && fit === 'page' && count > 1;
  const stride = spreadView ? 2 : 1;
  const lastPageStart = Math.floor(Math.max(count - 1, 0) / stride) * stride;
  useEffect(() => {
    setIndex(current => Math.min(Math.floor(current / stride) * stride, lastPageStart));
  }, [stride, lastPageStart]);
  const step = useCallback(
    (direction: 'next' | 'prev') => {
      setIndex((current) => {
        const next = current + (direction === 'next' ? stride : -stride);
        return Math.min(Math.max(next, 0), lastPageStart);
      });
      if (!barHover.current) hideBarSoon();
    },
    [stride, lastPageStart, hideBarSoon],
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
        setIndex(lastPageStart);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lastPageStart, rtl, step]);

  const current = pages?.[index];
  const currentUrl = current ? urls.current.get(index) : undefined;
  const nextUrl = urls.current.get(index + 1);

  if (error) {
    return <div className="slack-comic__error"><p>漫画加载失败：{error}</p></div>;
  }

  return (
    <div
      className={`slack-comic slack-comic--${fit}${barShown ? '' : ' slack-comic--bar-hidden'}`}
      onPointerMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientY >= bounds.bottom - 120) {
          showBar();
          hideBarSoon();
        } else if (!barHover.current) {
          hideBarSoon(700);
        }
      }}
      onPointerLeave={() => hideBarSoon(300)}
    >
      <div className="slack-comic__stage">
        {pages === null ? (
          <p className="slack-comic__loading" role="status">正在读取漫画页…</p>
        ) : currentUrl ? (
          spreadView ? (
            <div className={`slack-comic__spread${rtl ? ' slack-comic__spread--rtl' : ''}`}>
              <img
                key={current?.id ?? index}
                className="slack-comic__image"
                src={currentUrl}
                alt={`第 ${index + 1} 页`}
                draggable={false}
              />
              {nextUrl ? (
                <img
                  className="slack-comic__image"
                  src={nextUrl}
                  alt={`第 ${index + 2} 页`}
                  draggable={false}
                />
              ) : (
                <span className="slack-comic__blank" aria-hidden="true" />
              )}
            </div>
          ) : (
            <img
              key={current?.id ?? index}
              className="slack-comic__image"
              src={currentUrl}
              alt={`第 ${index + 1} 页`}
              draggable={false}
              style={fit === 'width' ? { width: `${zoom}%` } : undefined}
            />
          )
        ) : (
          <p className="slack-comic__loading" role="status">正在解码第 {index + 1} 页…</p>
        )}

        <button
          type="button"
          className="slack-comic__zone slack-comic__zone--left"
          disabled={rtl ? index >= lastPageStart : index <= 0}
          onClick={() => step(rtl ? 'next' : 'prev')}
          aria-label={rtl ? '下一页' : '上一页'}
        />
        <button
          type="button"
          className="slack-comic__zone slack-comic__zone--right"
          disabled={rtl ? index <= 0 : index >= lastPageStart}
          onClick={() => step(rtl ? 'prev' : 'next')}
          aria-label={rtl ? '上一页' : '下一页'}
        />

        <div className="slack-comic__preload" aria-hidden="true">
          {nextUrl ? <img src={nextUrl} alt="" /> : null}
          {urls.current.get(index + 2) ? <img src={urls.current.get(index + 2)} alt="" /> : null}
          {urls.current.get(index + 3) ? <img src={urls.current.get(index + 3)} alt="" /> : null}
        </div>

        {count <= 1 ? <span className="slack-comic__single">单页</span> : null}
        {barShown ? null : (
          <span className="slack-comic__pip" key={pipToken} aria-hidden="true">{index + 1} / {count}</span>
        )}
      </div>

      <div
        className="slack-comic__bar"
        onPointerEnter={() => {
          barHover.current = true;
          cancelHide();
        }}
        onPointerLeave={() => {
          barHover.current = false;
          hideBarSoon(400);
        }}
      >
        <div className="slack-comic__nav">
          <button
            type="button"
            onClick={() => step(rtl ? 'next' : 'prev')}
            disabled={rtl ? index >= lastPageStart : index <= 0}
            aria-label={rtl ? '下一页' : '上一页'}
          >
            ‹
          </button>
          <input
            type="range"
            min={1}
            max={Math.max(count, 1)}
            value={index + 1}
            onChange={(event) => setIndex(Math.floor((Number(event.target.value) - 1) / stride) * stride)}
            aria-label="页码"
          />
          <span className="slack-comic__count">{index + 1} / {count}</span>
          <button
            type="button"
            onClick={() => step(rtl ? 'prev' : 'next')}
            disabled={rtl ? index <= 0 : index >= lastPageStart}
            aria-label={rtl ? '上一页' : '下一页'}
          >
            ›
          </button>
        </div>

        <div className="slack-comic__tools">
          <button
            type="button"
            className={fit === 'page' ? 'active' : ''}
            onClick={() => updatePrefs({ fit: fit === 'page' ? 'width' : 'page' })}
            title="在整页 / 适宽之间切换"
          >
            {fit === 'page' ? '整页' : '适宽'}
          </button>
          <button
            type="button"
            className={double ? 'active' : ''}
            disabled={fit === 'width'}
            onClick={() => updatePrefs({ double: !double })}
            title={fit === 'width' ? '适宽模式下双页不可用' : '宽屏时两页并排阅读'}
          >
            双页
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
            onClick={() => updatePrefs({ rtl: !rtl })}
            title="切换日漫从右往左翻页"
          >
            从右往左
          </button>
        </div>
      </div>
    </div>
  );
}
