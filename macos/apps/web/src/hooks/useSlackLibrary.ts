import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { contentHash } from '../components/slack/bookImport';
import {
  deleteItemDeep,
  getChapters,
  getItem,
  listItems,
  newId,
  putLibraryEntry,
  replaceItemAndChapters,
  touchItem,
  updateChapter,
  updateProgress,
} from '../components/slack/db';
import { loadWebBook, loadWebChapterText } from '../components/slack/sources/web-engine';
import { getWebSource } from '../components/slack/sources/web-store';
import type { WebBookSource, WebSearchResult } from '../components/slack/sources/web-types';
import {
  comicTitleFromFiles,
  isComicArchive,
  isEpubFile,
  isImageFile,
  isTextFile,
  parseComicArchive,
  parseComicImages,
  parseEpubFile,
  parseTextFile,
} from '../components/slack/import';
import type {
  ImportJob,
  DownloadedBookMetadata,
  ParsedAsset,
  ParsedComic,
  ParsedNovel,
  SlackChapter,
  SlackItem,
  SlackProgress,
} from '../components/slack/types';

function coverTone(title: string): number {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 6;
}

async function saveNovel(parsed: ParsedNovel, source?: string, metadata?: DownloadedBookMetadata): Promise<SlackItem> {
  const now = Date.now();
  const item: SlackItem = {
    id: newId(),
    kind: 'novel',
    title: parsed.title,
    author: parsed.author,
    createdAt: now,
    openedAt: now,
    progress: { chapter: 0, page: 0, scroll: 0 },
    chapterCount: parsed.chapters.length,
    pageCount: 0,
    coverAssetId: parsed.coverAssetId,
    coverTone: coverTone(parsed.title),
    sizeBytes: parsed.sizeBytes,
    source: source?.trim() || undefined,
    providerId: metadata?.providerId,
    providerBookId: metadata?.providerBookId,
    sourceUrl: metadata?.sourceUrl,
    sourceLicense: metadata?.sourceLicense,
    contentSha256: metadata?.contentSha256,
    importedAt: metadata?.importedAt,
  };
  return await putLibraryEntry(
    item,
    parsed.chapters.map((chapter, order) => ({
      order,
      title: chapter.title,
      text: chapter.text,
      html: chapter.html,
    })),
    parsed.assets,
  );
}

async function saveComic(parsed: ParsedComic, source?: string, author = ''): Promise<SlackItem> {
  const now = Date.now();
  const item: SlackItem = {
    id: newId(),
    kind: 'comic',
    title: parsed.title,
    author: author.trim(),
    createdAt: now,
    openedAt: now,
    progress: { chapter: 0, page: 0, scroll: 0 },
    chapterCount: 0,
    pageCount: parsed.assets.length,
    coverAssetId: parsed.assets[0]?.id ?? '',
    coverTone: coverTone(parsed.title),
    sizeBytes: parsed.sizeBytes,
    source: source?.trim() || undefined,
  };
  return await putLibraryEntry(item, [], parsed.assets);
}

/**
 * 摸鱼文库的读取与导入。所有内容只写 IndexedDB，不经过服务端。
 * 上传时按「图片批次 / 压缩包 / 单本文本」拆成任务串行处理，避免一次性把
 * 几百张图同时读进内存。
 */
export function useSlackLibrary() {
  const [items, setItems] = useState<SlackItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const next = await listItems();
    if (alive.current) setItems(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        if (alive.current) setReady(true);
      });
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setError('');
      const tasks: { id: string; name: string; run: () => Promise<void> }[] = [];
      const imageFiles = files.filter(isImageFile);
      const others = files.filter((file) => !isImageFile(file));

      if (imageFiles.length) {
        const id = newId();
        tasks.push({
          id,
          name: imageFiles.length === 1 ? imageFiles[0]?.name ?? '图片' : `漫画 · ${imageFiles.length} 页`,
          run: async () => {
            updateJob(id, { status: 'working', message: '解析图片…' });
            const parsed = await parseComicImages(imageFiles, comicTitleFromFiles(imageFiles));
            updateJob(id, { message: '写入本地文库…' });
            await saveComic(parsed);
          },
        });
      }

      for (const file of others) {
        const id = newId();
        if (isComicArchive(file)) {
          tasks.push({
            id,
            name: file.name,
            run: async () => {
              updateJob(id, { status: 'working', message: '解压漫画…' });
              const parsed = await parseComicArchive(file);
              updateJob(id, { message: '写入本地文库…' });
              await saveComic(parsed);
            },
          });
        } else if (isEpubFile(file)) {
          tasks.push({
            id,
            name: file.name,
            run: async () => {
              updateJob(id, { status: 'working', message: '解析 EPUB…' });
              const parsed = await parseEpubFile(file);
              updateJob(id, { message: '写入本地文库…' });
              await saveNovel(parsed, undefined, { title: parsed.title, author: parsed.author, contentSha256: await contentHash(file) });
            },
          });
        } else if (isTextFile(file)) {
          tasks.push({
            id,
            name: file.name,
            run: async () => {
              updateJob(id, { status: 'working', message: '解析文本…' });
              const parsed = await parseTextFile(file);
              updateJob(id, { message: '写入本地文库…' });
              await saveNovel(parsed, undefined, { title: parsed.title, author: parsed.author, contentSha256: await contentHash(file) });
            },
          });
        } else {
          tasks.push({
            id,
            name: file.name,
            run: async () => {
              throw new Error('不支持该格式（支持 TXT / MD / EPUB / 图片 / ZIP / CBZ）');
            },
          });
        }
      }

      setJobs((current) => [
        ...current,
        ...tasks.map((task) => ({
          id: task.id,
          name: task.name,
          status: 'pending' as const,
          message: '排队中…',
        })),
      ]);

      for (const task of tasks) {
        try {
          await task.run();
          updateJob(task.id, { status: 'done', message: '已加入文库' });
        } catch (cause) {
          updateJob(task.id, {
            status: 'error',
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      await refresh();
      window.setTimeout(() => {
        setJobs((current) => current.filter((job) => job.status !== 'done'));
      }, 3200);
    },
    [refresh, updateJob],
  );

  const importDownloadedBook = useCallback(
    async (file: File, metadata: DownloadedBookMetadata): Promise<SlackItem> => {
      const id = newId();
      setError('');
      setJobs((current) => [
        ...current,
        { id, name: metadata.title || file.name, status: 'working', message: '解析下载文件…' },
      ]);
      try {
        const hash = await contentHash(file);
        if (metadata.contentSha256 && metadata.contentSha256 !== hash) throw new Error('导入文件内容校验失败');
        metadata = { ...metadata, contentSha256: hash, importedAt: Date.now() };
        const existing = (await listItems()).find(item => item.contentSha256 === hash);
        if (existing) {
          updateJob(id, { status: 'done', message: '相同文件已在书架，已保留原有阅读进度' });
          await refresh();
          window.setTimeout(() => setJobs(current => current.filter(job => job.id !== id)), 3200);
          return existing;
        }
        let saved: SlackItem;
        if (isEpubFile(file)) {
          const parsed = await parseEpubFile(file);
          parsed.title = metadata.title.trim() || parsed.title;
          parsed.author = metadata.author.trim() || parsed.author;
          updateJob(id, { message: '写入本地文库…' });
          saved = await saveNovel(parsed, metadata.source, metadata);
        } else if (isTextFile(file)) {
          const parsed = await parseTextFile(file);
          parsed.title = metadata.title.trim() || parsed.title;
          parsed.author = metadata.author.trim() || parsed.author;
          updateJob(id, { message: '写入本地文库…' });
          saved = await saveNovel(parsed, metadata.source, metadata);
        } else if (isComicArchive(file)) {
          const parsed = await parseComicArchive(file);
          parsed.title = metadata.title.trim() || parsed.title;
          updateJob(id, { message: '写入本地文库…' });
          saved = await saveComic(parsed, metadata.source, metadata.author);
        } else if (isImageFile(file)) {
          const title = metadata.title.trim() || comicTitleFromFiles([file]);
          const parsed = await parseComicImages([file], title);
          updateJob(id, { message: '写入本地文库…' });
          saved = await saveComic(parsed, metadata.source, metadata.author);
        } else {
          throw new Error('不支持该下载格式（支持 EPUB / TXT / CBZ / ZIP）');
        }
        updateJob(id, { status: 'done', message: '已加入本地书架' });
        await refresh();
        window.setTimeout(() => {
          setJobs((current) => current.filter((job) => job.id !== id));
        }, 3200);
        return saved;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        updateJob(id, { status: 'error', message });
        throw cause;
      }
    },
    [refresh, updateJob],
  );

  const importWebNovel = useCallback(
    async (source: WebBookSource, book: WebSearchResult): Promise<SlackItem> => {
      const detail = await loadWebBook(source, book.bookUrl, {
        title: book.title,
        author: book.author,
        intro: book.intro,
        cover: book.cover,
      });

      let assets: ParsedAsset[] = [];
      let coverAssetId = '';
      if (detail.cover) {
        try {
          const blob = await api.fetchWebSourceImage(detail.cover);
          const asset: ParsedAsset = {
            id: newId(),
            order: 0,
            name: 'cover',
            mime: blob.type || 'image/jpeg',
            blob,
          };
          assets = [asset];
          coverAssetId = asset.id;
        } catch {
          /* 封面失败不影响导入。 */
        }
      }

      const now = Date.now();
      const item: SlackItem = {
        id: newId(),
        kind: 'novel',
        title: detail.title,
        author: detail.author,
        createdAt: now,
        openedAt: now,
        progress: { chapter: 0, page: 0, scroll: 0 },
        chapterCount: detail.chapters.length,
        pageCount: 0,
        coverAssetId,
        coverTone: coverTone(detail.title),
        sizeBytes: 0,
        source: source.name,
        serial: true,
        sourceId: source.id,
        sourceUrl: book.bookUrl,
        sourceName: source.name,
        lastCheckedAt: now,
      };
      await putLibraryEntry(
        item,
        detail.chapters.map((chapter, order) => ({
          order,
          title: chapter.title,
          text: '',
          html: '',
          url: chapter.url,
        })),
        assets,
      );
      await refresh();
      return item;
    },
    [refresh],
  );

  const loadWebChapter = useCallback(
    async (itemId: string, chapter: SlackChapter): Promise<string> => {
      const item = await getItem(itemId);
      if (!item?.sourceId) throw new Error('这条连载没有关联书源');
      const source = getWebSource(item.sourceId);
      if (!source) throw new Error('书源已被删除，请在「找书 → 中文连载」里重新导入');
      if (!chapter.url) throw new Error('这一章没有页面地址');
      const text = await loadWebChapterText(source, chapter.url);
      await updateChapter(itemId, { ...chapter, text });
      return text;
    },
    [],
  );

  const refreshWebToc = useCallback(async (itemId: string): Promise<SlackChapter[]> => {
    const item = await getItem(itemId);
    if (!item?.sourceId || !item.sourceUrl) throw new Error('这条连载没有可刷新的书源地址');
    const source = getWebSource(item.sourceId);
    if (!source) throw new Error('书源已被删除，无法更新目录');
    const detail = await loadWebBook(source, item.sourceUrl, {
      title: item.title,
      author: item.author,
    });
    const existing = await getChapters(itemId);
    const byUrl = new Map<string, SlackChapter>();
    const byTitle = new Map<string, SlackChapter>();
    for (const chapter of existing) {
      if (chapter.url) byUrl.set(chapter.url, chapter);
      byTitle.set(chapter.title, chapter);
    }

    const merged: SlackChapter[] = [];
    const seenUrls = new Set<string>();
    const seenTitles = new Set<string>();
    for (const chapter of detail.chapters) {
      const titleMatch = byTitle.get(chapter.title);
      const old =
        byUrl.get(chapter.url) ?? (titleMatch && !titleMatch.url ? titleMatch : undefined);
      merged.push(
        old
          ? { ...old, order: merged.length, title: chapter.title, url: chapter.url }
          : { order: merged.length, title: chapter.title, text: '', html: '', url: chapter.url },
      );
      seenUrls.add(chapter.url);
      seenTitles.add(chapter.title);
    }
    // 源站删掉的旧章节如果本地已经缓存过，保留在末尾，避免阅读记录凭空消失。
    for (const old of existing) {
      if (old.url && seenUrls.has(old.url)) continue;
      if (seenTitles.has(old.title)) continue;
      if (!old.text && !old.html) continue;
      merged.push({ ...old, order: merged.length });
    }

    const updatedItem: SlackItem = {
      ...item,
      chapterCount: merged.length,
      lastCheckedAt: Date.now(),
    };
    await replaceItemAndChapters(updatedItem, merged);
    setItems((current) => current.map((entry) => (entry.id === itemId ? updatedItem : entry)));
    return merged;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteItemDeep(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const saveProgress = useCallback(async (id: string, progress: SlackProgress) => {
    await updateProgress(id, progress);
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, progress } : item)),
    );
  }, []);

  const open = useCallback(async (id: string) => {
    const item = await touchItem(id);
    if (item) setItems((current) => current.map((entry) => (entry.id === id ? item : entry)));
  }, []);

  const dismissJobs = useCallback(() => setJobs([]), []);

  return {
    items,
    ready,
    error,
    jobs,
    addFiles,
    importDownloadedBook,
    importWebNovel,
    loadWebChapter,
    refreshWebToc,
    remove,
    saveProgress,
    open,
    refresh,
    dismissJobs,
    setError,
  };
}
