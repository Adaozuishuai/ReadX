import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SlackAsset, SlackChapter, SlackItem, SlackProgress } from './types';

type ProseMode = 'paper' | 'plain' | 'night';

interface NovelPrefs {
  fontSize: number;
  lineHeight: number;
  width: number;
  mode: ProseMode;
}

const PREFS_KEY = 'readx-slack-novel-prefs';
const LINE_HEIGHTS = [1.7, 1.9, 2.1, 2.4];
const WIDTHS = [640, 760, 900];
const MODES: ProseMode[] = ['paper', 'plain', 'night'];
const MODE_LABEL: Record<ProseMode, string> = { paper: '纸张', plain: '跟随主题', night: '夜间' };
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

function cycle<T>(list: T[], current: T): T {
  const index = list.indexOf(current);
  return list[(index + 1) % list.length] as T;
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
  const [scrollRatio, setScrollRatio] = useState(item.progress.scroll);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(onProgress);
  const indexRef = useRef(index);
  const initialChapter = useRef(index);
  const initialScroll = useRef(item.progress.scroll);
  const restored = useRef(false);
  const displayedChapter = useRef<number | null>(null);
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
  const timer = useRef<number | undefined>(undefined);

  progressRef.current = onProgress;
  indexRef.current = index;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 隐私模式下写不了 localStorage：本次会话仍然生效。 */
    }
  }, [prefs]);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const asset of assets) map[asset.id] = URL.createObjectURL(asset.blob);
    setAssetUrls(map);
    return () => {
      for (const url of Object.values(map)) URL.revokeObjectURL(url);
    };
  }, [assets]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (restored.current && displayedChapter.current === index) return;
    // 首次渲染时正文里的图片 URL 仍为空；先等 blob URL 写回，再等图片布局稳定。
    if (assets.some((asset) => !assetUrls[asset.id])) return;
    window.clearTimeout(timer.current);
    restoring.current = true;
    const ratio = !restored.current && index === initialChapter.current ? initialScroll.current : 0;
    element.scrollTop = 0;
    const images = Array.from(element.querySelectorAll('img'));
    let frame = 0;
    const restore = () => {
      if (images.some((image) => !image.complete)) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = max * ratio;
        setScrollRatio(ratio);
        restored.current = true;
        displayedChapter.current = index;
        restoring.current = false;
      });
    };
    for (const image of images) {
      image.addEventListener('load', restore);
      image.addEventListener('error', restore);
    }
    restore();
    return () => {
      window.cancelAnimationFrame(frame);
      for (const image of images) {
        image.removeEventListener('load', restore);
        image.removeEventListener('error', restore);
      }
    };
  }, [assetUrls, assets, html, index]);

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

  const go = useCallback(
    (delta: number) => {
      setIndex((current) => {
        const next = Math.min(Math.max(current + delta, 0), chapters.length - 1);
        if (next !== current) setProgress(next, 0);
        return next;
      });
      setTocOpen(false);
    },
    [chapters.length, setProgress],
  );

  const handleScroll = useCallback(() => {
    if (restoring.current) return;
    const element = scrollRef.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, element.scrollTop / max)) : 0;
    setScrollRatio(ratio);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setProgress(indexRef.current, ratio), 260);
  }, [setProgress]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      } else if (event.key === 't' || event.key === 'T') {
        setTocOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go]);

  const paragraphs = useMemo(
    () => (chapter?.text ?? '').split(/\n+/).map((line) => line.trim()).filter(Boolean),
    [chapter],
  );

  const overall = Math.min(1, (index + scrollRatio) / Math.max(chapters.length, 1));
  // EPUB 章节自带标题时不再重复渲染我们自己的 h2，只保留书名小字。
  const htmlHasHeading = /^\s*<h[1-6][\s>]/i.test(html);

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
        <div className="slack-reader-toolbar__display">
          <button
            type="button"
            title="减小字号"
            onClick={() => setPrefs((current) => ({ ...current, fontSize: Math.max(15, current.fontSize - 1) }))}
          >
            A−
          </button>
          <button
            type="button"
            title="增大字号"
            onClick={() => setPrefs((current) => ({ ...current, fontSize: Math.min(34, current.fontSize + 1) }))}
          >
            A＋
          </button>
          <button
            type="button"
            title="切换行距"
            onClick={() => setPrefs((current) => ({ ...current, lineHeight: cycle(LINE_HEIGHTS, current.lineHeight) }))}
          >
            行距 {prefs.lineHeight.toFixed(1)}
          </button>
          <button
            type="button"
            title="切换版心宽度"
            onClick={() => setPrefs((current) => ({ ...current, width: cycle(WIDTHS, current.width) }))}
          >
            宽度 {WIDTH_LABEL[prefs.width]}
          </button>
          <button
            type="button"
            title="切换阅读底色"
            onClick={() => setPrefs((current) => ({ ...current, mode: cycle(MODES, current.mode) }))}
          >
            {MODE_LABEL[prefs.mode]}
          </button>
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

        <div className="slack-reader-scroll" ref={scrollRef} onScroll={handleScroll}>
          <article
            className="slack-prose"
            style={{ fontSize: `${prefs.fontSize}px`, lineHeight: prefs.lineHeight, maxWidth: `${prefs.width}px` }}
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
        </div>
      </div>

      <div className="slack-reader-status">
        <span>{chapter?.title ?? ''}</span>
        <div className="slack-reader-status__bar" aria-hidden="true">
          <span style={{ width: `${Math.round(overall * 100)}%` }} />
        </div>
        <span>{Math.round(overall * 100)}%</span>
      </div>
    </div>
  );
}
