import { useCallback, useEffect, useState } from 'react';
import { getAssets, getChapters } from './db';
import { ComicReader } from './ComicReader';
import { NovelReader } from './NovelReader';
import type { SlackAsset, SlackChapter, SlackItem, SlackProgress } from './types';

export function SlackReader({
  item,
  onProgress,
  onLoadChapter,
  onRefreshToc,
}: {
  item: SlackItem;
  onProgress: (progress: SlackProgress) => void;
  /** 连载书源：抓取单章正文并写入本地缓存。 */
  onLoadChapter?: (chapter: SlackChapter) => Promise<string>;
  /** 连载书源：重新抓取目录并返回合并后的章节。 */
  onRefreshToc?: () => Promise<SlackChapter[]>;
}) {
  const [chapters, setChapters] = useState<SlackChapter[] | null>(null);
  const [assets, setAssets] = useState<SlackAsset[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (item.kind !== 'novel') return;
    let cancelled = false;
    setChapters(null);
    void Promise.all([getChapters(item.id), getAssets(item.id)])
      .then(([nextChapters, nextAssets]) => {
        if (cancelled) return;
        setChapters(nextChapters);
        setAssets(nextAssets);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [item.id, item.kind]);

  const needChapter = useCallback(
    async (index: number) => {
      const current = chapters?.[index];
      if (!current || !onLoadChapter) return;
      const text = await onLoadChapter(current);
      setChapters((list) =>
        list ? list.map((chapter, order) => (order === index ? { ...chapter, text } : chapter)) : list,
      );
    },
    [chapters, onLoadChapter],
  );

  const refreshToc = useCallback(async () => {
    if (!onRefreshToc) return 0;
    const next = await onRefreshToc();
    setChapters(next);
    return next.length;
  }, [onRefreshToc]);

  if (item.kind === 'comic') {
    return <ComicReader item={item} onProgress={onProgress} />;
  }

  if (error) {
    return <div className="slack-reader-loading"><p>打开失败：{error}</p></div>;
  }

  if (!chapters) {
    return (
      <div className="slack-reader-loading" role="status">
        <span className="slack-spinner" aria-hidden="true" />
        <p>正在打开《{item.title}》…</p>
      </div>
    );
  }

  if (!chapters.length) {
    return <div className="slack-reader-loading"><p>这本书没有可读章节。</p></div>;
  }

  return (
    <NovelReader
      item={item}
      chapters={chapters}
      assets={assets}
      onProgress={onProgress}
      onNeedChapter={item.serial && onLoadChapter ? needChapter : undefined}
      onRefreshToc={item.serial && onRefreshToc ? refreshToc : undefined}
    />
  );
}
