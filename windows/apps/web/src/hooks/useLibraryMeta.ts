import { useCallback, useEffect, useState } from 'react';
import type { Category, DocumentMeta } from '../api/client';
import { api } from '../api/client';

/** 论文库附加元数据（收藏 / 标签 / 彩色分类 / 回收站）的内存副本 + 乐观更新。 */
export function useLibraryMeta() {
  const [items, setItems] = useState<Record<string, DocumentMeta>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [meta, tagList, categoryList] = await Promise.all([
        api.documentsMeta(),
        api.tags(),
        api.categories(),
      ]);
      const byKey: Record<string, DocumentMeta> = {};
      for (const item of meta.meta) byKey[item.key] = item;
      setItems(byKey);
      setTags(tagList.tags);
      setCategories(categoryList.categories);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
    const onSyncComplete = () => { void reload(); };
    window.addEventListener('readx-sync-complete', onSyncComplete);
    return () => window.removeEventListener('readx-sync-complete', onSyncComplete);
  }, [reload]);

  const patch = useCallback(
    async (key: string, body: { favorite?: boolean; tags?: string[]; categories?: string[]; deleted?: boolean }) => {
      try {
        const updated = await api.patchDocumentMeta(key, body);
        setItems((current) => ({ ...current, [key]: updated }));
        setError(null);
        // 标签集合可能变化，刷新一次汇总列表。
        void api.tags().then((list) => setTags(list.tags)).catch(() => undefined);
        return updated;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [],
  );

  const upsertCategory = useCallback(async (name: string, color: string) => {
    try {
      const result = await api.upsertCategory({ name, color });
      setCategories(result.categories);
      setError(null);
      return result.categories;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, []);

  const deleteCategory = useCallback(
    async (name: string) => {
      try {
        const result = await api.deleteCategory(name);
        setCategories(result.categories);
        // 服务端会摘掉论文上的引用，本地同步刷新。
        await reload();
        return result.categories;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
    },
    [reload],
  );

  return { items, tags, categories, error, patch, upsertCategory, deleteCategory, reload };
}
