import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SlackAsset, SlackChapter, SlackItem, SlackProgress } from './types';
import { STORAGE_KEYS } from '../../lib/storage';
import { recordChapters } from './stats';

type ProseMode = 'paper' | 'ink' | 'plain' | 'night';
type PageTurn = { from: number; to: number; direction: 1 | -1 };

interface NovelPrefs {
  fontSize: number;
  lineHeight: number;
  width: number;
  mode: ProseMode;
}

const PREFS_KEY = STORAGE_KEYS.novelPrefs;
const LINE_HEIGHTS = [1.7, 1.9, 2.1, 2.4];
const WIDTHS = [640, 760, 900];
const MODES: ProseMode[] = ['paper', 'ink', 'plain', 'night'];
const MODE_LABEL: Record<ProseMode, string> = { paper: '纸张', ink: '水墨屏', plain: '跟随主题', night: '夜间' };
const WIDTH_LABEL: Record<number, string> = { 640: '窄', 760: '中', 900: '宽' };

function readPrefs(): NovelPrefs {
  const fallback: NovelPrefs = { fontSize: 19, lineHeight: 1.9, width: 760, mode: 'paper' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<NovelPrefs>;
    return {
      fontSize:
        typeof parsed.fontSize === 'number' && parsed.fontSize >= 15 && parsed.fontSize <= 34
          ? parsed.fontSize
          : fallback.fontSize,
      lineHeight: LINE_HEIGHTS.includes(Number(parsed.lineHeight))
        ? Number(parsed.lineHeight)
        : fallback.lineHeight,
      width: WIDTHS.includes(Number(parsed.width)) ? Number(parsed.width) : fallback.width,
      mode: MODES.includes(parsed.mode as ProseMode) ? (parsed.mode as ProseMode) : fallback.mode,
    };
  } catch {
    return fallback;
  }
}

export function NovelReader({
  item,
  chapters,
  assets,
  onProgress,
  onNeedChapter,
  onRefreshToc,
}: {
  item: SlackItem;
  chapters: SlackChapter[];
  assets: SlackAsset[];
  onProgress: (progress: SlackProgress) => void;
  /** 连载书源：当前章节正文为空且带 URL 时按需加载。 */
  onNeedChapter?: (index: number) => Promise<void>;
  /** 连载书源：重新抓取目录，返回更新后的章节数。 */
  onRefreshToc?: () => Promise<number>;
}) {
  const [prefs, setPrefs] = useState<NovelPrefs>(readPrefs);
  const [index, setIndex] = useState(() => {
    const last = Math.max(0, chapters.length - 1);
    return Math.min(Math.max(item.progress.chapter, 0), last);
  });
  const [tocOpen, setTocOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const aaPanel = useRef<HTMLDivElement>(null);
  const [scrollRatio, setScrollRatio] = useState(item.progress.scroll);
  const [spread, setSpread] = useState({ page: 0, count: 1, step: 0 });
  const [pageTurn, setPageTurn] = useState<PageTurn | null>(null);
  const turning = useRef(false);
  const turnTimer = useRef<number | undefined>(undefined);
  const requestedRatio = useRef<number | null>(null);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(onProgress);
  const indexRef = useRef(index);
  const initialChapter = useRef(index);
  const initialScroll = useRef(item.progress.scroll);
  const restored = useRef(false);
  const displayedChapter = useRef<number | null>(null);
  const ratioRef = useRef(item.progress.scroll);
  const spreadRef = useRef(spread);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const wheelTime = useRef(0);
  const restoring = useRef(true);
  const loadingRef = useRef<number | null>(null);
  const [loadingChapter, setLoadingChapter] = useState<number | null>(null);
  const [chapterError, setChapterError] = useState('');
  const [refreshTocBusy, setRefreshTocBusy] = useState(false);
  const [tocMessage, setTocMessage] = useState('');
  const [retryToken, setRetryToken] = useState(0);

  const chapter = chapters[index];
  const html = useMemo(() => {
    if (!chapter?.html) return '';
    return chapter.html.replace(/slack-asset:\/\/([A-Za-z0-9-]+)/g, (_match, id: string) => assetUrls[id] ?? '');
  }, [assetUrls, chapter]);

  progressRef.current = onProgress;
  indexRef.current = index;
  spreadRef.current = spread;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍然生效。 */
    }
  }, [prefs]);

  // 摸鱼周报：正向翻了几章就记几章，回翻不重复计。
  const statChapter = useRef(index);
  useEffect(() => {
    const delta = index - statChapter.current;
    statChapter.current = index;
    if (delta > 0) recordChapters(delta);
  }, [index]);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const asset of assets) map[asset.id] = URL.createObjectURL(asset.blob);
    setAssetUrls(map);
    return () => {
      for (const url of Object.values(map)) URL.revokeObjectURL(url);
    };
  }, [assets]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (assets.some((asset) => !assetUrls[asset.id])) return;
    restoring.current = true;
    const prose = element.querySelector<HTMLElement>('.slack-prose');
    if (!prose) return;
    if (!restored.current) {
      ratioRef.current = index === initialChapter.current ? initialScroll.current : 0;
    } else if (displayedChapter.current !== index) {
      ratioRef.current = requestedRatio.current ?? 0;
    }
    requestedRatio.current = null;
    displayedChapter.current = index;
    const images = Array.from(element.querySelectorAll('img'));
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.setProperty('--slack-page-height', `${element.clientHeight}px`);
        const style = getComputedStyle(prose);
        const gap = parseFloat(style.columnGap) || 0;
        const columns = Number(style.columnCount) || 2;
        const step = prose.clientWidth + gap;
        const columnWidth = (prose.clientWidth - gap * (columns - 1)) / columns;
        const columnCount = Math.max(columns, Math.ceil((prose.scrollWidth + gap - 1) / (columnWidth + gap)));
        const count = Math.max(1, Math.ceil(columnCount / columns));
        const page = Math.min(count - 1, Math.round(ratioRef.current * (count - 1)));
        const next = { page, count, step };
        spreadRef.current = next;
        setSpread(next);
        setScrollRatio(ratioRef.current);
        restored.current = true;
        restoring.current = false;
      });
    };
    for (const image of images) {
      image.addEventListener('load', measure);
      image.addEventListener('error', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      for (const image of images) {
        image.removeEventListener('load', measure);
        image.removeEventListener('error', measure);
      }
    };
  }, [assetUrls, assets, html, index, chapter, prefs, loadingChapter, chapterError]);

  useEffect(() => {
    setChapterError('');
    const current = chapters[index];
    if (!onNeedChapter || !current || current.text || current.html || !current.url) return;
    if (loadingRef.current === index) return;
    loadingRef.current = index;
    setLoadingChapter(index);
    void onNeedChapter(index)
      .catch((cause: unknown) => {
        setChapterError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (loadingRef.current === index) loadingRef.current = null;
        setLoadingChapter((value) => (value === index ? null : value));
      });
  }, [index, chapters, onNeedChapter, retryToken]);

  const refreshToc = useCallback(async () => {
    if (!onRefreshToc || refreshTocBusy) return;
    setRefreshTocBusy(true);
    setChapterError('');
    try {
      const count = await onRefreshToc();
      setTocMessage(`目录已更新，共 ${count} 章`);
      window.setTimeout(() => setTocMessage(''), 4000);
    } catch (cause) {
      setChapterError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshTocBusy(false);
    }
  }, [onRefreshToc, refreshTocBusy]);

  const setProgress = useCallback((chapter: number, scroll: number) => {
    progressRef.current({ chapter, page: 0, scroll });
  }, []);

  const finishTurn = useCallback(() => {
    window.clearTimeout(turnTimer.current);
    turning.current = false;
    setPageTurn(null);
  }, []);

  useEffect(() => {
    finishTurn();
    return () => window.clearTimeout(turnTimer.current);
  }, [index, prefs, html, finishTurn]);

  const go = useCallback(
    (delta: number, ratio = 0) => {
      const current = indexRef.current;
      const next = Math.min(Math.max(current + delta, 0), chapters.length - 1);
      if (next !== current) {
        requestedRatio.current = ratio;
        ratioRef.current = ratio;
        setIndex(next);
        setProgress(next, ratio);
      }
      setTocOpen(false);
    },
    [chapters.length, setProgress],
  );

  const turnPage = useCallback((delta: number) => {
    if (restoring.current || turning.current || tocOpen || loadingChapter !== null || chapterError) return;
    const current = spreadRef.current;
    const page = Math.min(Math.max(current.page + delta, 0), current.count - 1);
    if (page === current.page) {
      go(delta > 0 ? 1 : -1, delta > 0 ? 0 : 1);
      return;
    }
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      turning.current = true;
      setPageTurn({ from: current.page, to: page, direction: delta > 0 ? 1 : -1 });
      turnTimer.current = window.setTimeout(finishTurn, 650);
    }
    const ratio = current.count > 1 ? page / (current.count - 1) : 0;
    ratioRef.current = ratio;
    const next = { ...current, page };
    spreadRef.current = next;
    setSpread(next);
    setScrollRatio(ratio);
    setProgress(indexRef.current, ratio);
  }, [setProgress, go, finishTurn, tocOpen, loadingChapter, chapterError]);

  useEffect(() => {
    if (!displayOpen) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && aaPanel.current?.contains(event.target)) return;
      setDisplayOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [displayOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (event.key === 'Escape') {
        // 排版弹层开着时，Esc 先收弹层，而不是退出摸鱼界面。
        if (displayOpen) {
          event.preventDefault();
          setDisplayOpen(false);
        }
        return;
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault();
        turnPage(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        turnPage(-1);
      } else if (event.key === 't' || event.key === 'T') {
        setTocOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [turnPage, displayOpen]);

  const paragraphs = useMemo(
    () => (chapter?.text ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean),
    [chapter],
  );

  const overall = Math.min(1, (index + scrollRatio) / Math.max(chapters.length, 1));
  // EPUB 章节自带标题时不再重复渲染我们自己的 h2，只保留书名小字。
  const htmlHasHeading = /^\s*<h[1-6][\s>]/i.test(html);

  const renderPage = (page: number) => (
    <article
      className="slack-prose"
      style={{ fontSize: `${prefs.fontSize}px`, lineHeight: prefs.lineHeight, transform: `translateX(-${page * spread.step}px)` }}
    >
      <header className={`slack-prose__head${htmlHasHeading ? ' slack-prose__head--compact' : ''}`}>
        <small>{item.title}{item.serial ? ' · 连载' : ''}</small>
        {htmlHasHeading ? null : <h2>{chapter?.title ?? '正文'}</h2>}
      </header>
      {loadingChapter === index ? (
        <p className="slack-loading" role="status">正在加载本章…</p>
      ) : chapterError ? (
        <div className="slack-chapter-error" role="alert">
          <p>{chapterError}</p>
          <button
            type="button"
            className="slack-primary"
            onClick={() => {
              setChapterError('');
              setRetryToken((value) => value + 1);
            }}
          >
            重试
          </button>
        </div>
      ) : html ? (
        <div className="slack-prose__html" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="slack-prose__text">
          {paragraphs.map((paragraph, order) => (
            <p key={`${index}-${order}`}>{paragraph}</p>
          ))}
          {!paragraphs.length ? <p className="slack-muted">这一章没有内容。</p> : null}
        </div>
      )}
      <footer className="slack-prose__foot">
        {index < chapters.length - 1 ? (
          <button type="button" className="slack-primary" onClick={() => go(1)}>继续阅读下一章 →</button>
        ) : item.serial ? (
          <span>— 已是最新一章 —</span>
        ) : (
          <span>— 全书完 —</span>
        )}
      </footer>
    </article>
  );

  return (
    <div className={`slack-novel slack-novel--${prefs.mode}`}>
      <div className="slack-reader-toolbar">
        <button
          type="button"
          className={tocOpen ? 'active' : ''}
          onClick={() => setTocOpen((value) => !value)}
          aria-expanded={tocOpen}
        >
          ☰ 目录
        </button>
        {onRefreshToc ? (
          <button type="button" disabled={refreshTocBusy} onClick={() => void refreshToc()}>
            {refreshTocBusy ? '更新中…' : '更新目录'}
          </button>
        ) : null}
        {tocMessage ? <span className="slack-reader-toolbar__notice">{tocMessage}</span> : null}
        <div className="slack-reader-toolbar__nav">
          <button type="button" disabled={index <= 0} onClick={() => go(-1)}>← 上一章</button>
          <span>{index + 1} / {chapters.length}</span>
          <button type="button" disabled={index >= chapters.length - 1} onClick={() => go(1)}>下一章 →</button>
        </div>
        <div className="slack-aa" ref={aaPanel}>
          <button
            type="button"
            className={displayOpen ? 'active' : ''}
            aria-expanded={displayOpen}
            aria-haspopup="dialog"
            title="排版与主题"
            onClick={() => setDisplayOpen((value) => !value)}
          >
            Aa
          </button>
          {displayOpen ? (
            <div className="slack-aa__panel" role="dialog" aria-label="排版设置">
              <div className="slack-aa__row">
                <span className="slack-aa__label">字号</span>
                <div className="slack-font-control" role="group" aria-label="正文字号">
                  <button
                    type="button"
                    title="减小字号"
                    aria-label="减小字号"
                    disabled={prefs.fontSize <= 15}
                    onClick={() => setPrefs((current) => ({ ...current, fontSize: Math.max(15, current.fontSize - 1) }))}
                  >
                    A−
                  </button>
                  <input
                    type="range"
                    min="15"
                    max="34"
                    step="1"
                    value={prefs.fontSize}
                    aria-label="正文字号"
                    aria-valuetext={`${prefs.fontSize} 像素`}
                    onChange={(event) => setPrefs((current) => ({ ...current, fontSize: Number(event.target.value) }))}
                  />
                  <output>{prefs.fontSize}px</output>
                  <button
                    type="button"
                    title="增大字号"
                    aria-label="增大字号"
                    disabled={prefs.fontSize >= 34}
                    onClick={() => setPrefs((current) => ({ ...current, fontSize: Math.min(34, current.fontSize + 1) }))}
                  >
                    A＋
                  </button>
                </div>
              </div>
              <div className="slack-aa__row">
                <span className="slack-aa__label">行距</span>
                <div className="slack-seg" role="group" aria-label="行距">
                  {LINE_HEIGHTS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={prefs.lineHeight === value ? 'active' : ''}
                      onClick={() => setPrefs((current) => ({ ...current, lineHeight: value }))}
                    >
                      {value.toFixed(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="slack-aa__row">
                <span className="slack-aa__label">版心</span>
                <div className="slack-seg" role="group" aria-label="版心宽度">
                  {WIDTHS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={prefs.width === value ? 'active' : ''}
                      onClick={() => setPrefs((current) => ({ ...current, width: value }))}
                    >
                      {WIDTH_LABEL[value]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="slack-aa__row">
                <span className="slack-aa__label">主题</span>
                <div className="slack-seg" role="group" aria-label="阅读主题">
                  {MODES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={prefs.mode === value ? 'active' : ''}
                      onClick={() => setPrefs((current) => ({ ...current, mode: value }))}
                    >
                      {MODE_LABEL[value]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="slack-novel__body">
        {tocOpen ? (
          <>
            <div className="slack-toc__scrim" onClick={() => setTocOpen(false)} />
            <aside className="slack-toc" aria-label="目录">
              <header>
                <strong>目录</strong>
                <button type="button" onClick={() => setTocOpen(false)} aria-label="收起目录">×</button>
              </header>
              <div className="slack-toc__list">
                {chapters.map((entry, order) => (
                  <button
                    key={`${order}-${entry.title}`}
                    type="button"
                    className={order === index ? 'active' : ''}
                    onClick={() => {
                      ratioRef.current = 0;
                      setIndex(order);
                      setTocOpen(false);
                      setProgress(order, 0);
                    }}
                  >
                    <span>{String(order + 1).padStart(2, '0')}</span>
                    {entry.title}
                  </button>
                ))}
              </div>
            </aside>
          </>
        ) : null}

        <div className="slack-reader-scroll slack-reader-scroll--paged" onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          turnPage(event.clientX < bounds.left + bounds.width / 2 ? -1 : 1);
        }}>
          <button
            type="button"
            className="slack-novel__edge slack-novel__edge--previous"
            aria-label="点击左侧，上一页"
            title="上一页"
            disabled={spread.page <= 0 && index <= 0}
            onClick={() => turnPage(-1)}
          ><span aria-hidden="true">‹</span></button>
          <button
            type="button"
            className="slack-novel__edge slack-novel__edge--next"
            aria-label="点击右侧，下一页"
            title="下一页"
            disabled={spread.page >= spread.count - 1 && index >= chapters.length - 1}
            onClick={() => turnPage(1)}
          ><span aria-hidden="true">›</span></button>
          <div
            className="slack-novel__pages"
            ref={scrollRef}
            style={{ maxWidth: `${prefs.width * 2}px` }}
            onClick={(event) => {
              if ((event.target as Element).closest('a, button, input, select, textarea, summary, [role="button"]')) return;
              if (window.getSelection()?.toString()) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const position = (event.clientX - bounds.left) / bounds.width;
              if (position <= 0.2) turnPage(-1);
              else if (position >= 0.8) turnPage(1);
            }}
            onWheel={(event) => {
              const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
              if (event.ctrlKey || Math.abs(delta) < 12 || Date.now() - wheelTime.current < 600) return;
              wheelTime.current = Date.now();
              turnPage(delta > 0 ? 1 : -1);
            }}
            onTouchStart={(event) => {
              const touch = event.touches[0];
              touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
            }}
            onTouchEnd={(event) => {
              const start = touchStart.current;
              const touch = event.changedTouches[0];
              touchStart.current = null;
              if (!start || !touch) return;
              const dx = touch.clientX - start.x;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(touch.clientY - start.y)) turnPage(dx < 0 ? 1 : -1);
            }}
          >
            {renderPage(spread.page)}
            {pageTurn ? (
              <div
                className={`slack-book-turn slack-book-turn--${pageTurn.direction > 0 ? 'next' : 'previous'}`}
                aria-hidden="true"
                ref={(node) => { node?.setAttribute('inert', ''); }}
              >
                <div className="slack-book-turn__stationary">{renderPage(pageTurn.from)}</div>
                <div className="slack-book-turn__leaf" onAnimationEnd={(event) => {
                  if (event.target === event.currentTarget) finishTurn();
                }}>
                  <div className="slack-book-turn__face slack-book-turn__face--front">
                    <div className="slack-book-turn__spread">{renderPage(pageTurn.from)}</div>
                  </div>
                  <div className="slack-book-turn__face slack-book-turn__face--back">
                    <div className="slack-book-turn__spread">{renderPage(pageTurn.to)}</div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <footer className="slack-novel__footer" aria-label="阅读翻页与进度">
        <div className="slack-novel__footer-progress" aria-hidden="true">
          <span style={{ width: `${Math.round(overall * 100)}%` }} />
        </div>
        <span className="slack-novel__footer-chapter" title={chapter?.title ?? ''}>{chapter?.title ?? ''}</span>
        <div className="slack-novel__footer-nav">
          <button type="button" disabled={spread.page <= 0 && index <= 0} onClick={() => turnPage(-1)} aria-label="上一页">← 上一页</button>
          <span aria-live="polite">{spread.page + 1} / {spread.count}</span>
          <button type="button" disabled={spread.page >= spread.count - 1 && index >= chapters.length - 1} onClick={() => turnPage(1)} aria-label="下一页">下一页 →</button>
        </div>
        <span className="slack-novel__footer-percent">{Math.round(overall * 100)}%</span>
      </footer>
    </div>
  );
}
