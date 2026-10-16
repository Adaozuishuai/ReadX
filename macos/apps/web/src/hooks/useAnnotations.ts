import { useCallback, useEffect, useRef, useState } from 'react';
import type { Annotation, NewAnnotation } from '../api/client';
import { api } from '../api/client';

/** 一篇论文的批注：列表 + 增删改。批注是用户自己的笔记，任何一步失败都要如实显示。 */
export function useAnnotations(key: string | null) {
  const [items, setItems] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!key) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const response = await api.annotations(key);
      if (version !== requestVersion.current) return;
      setItems(response.annotations);
      setError(null);
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    setItems([]);
    setError(null);
    void reload();
    return () => {
      requestVersion.current++;
    };
  }, [reload]);

  const create = useCallback(
    async (body: NewAnnotation) => {
      if (!key) return null;
      const created = await api.createAnnotation(key, body);
      if (currentKey.current !== key) return null;
      setItems((current) => [...current, created]);
      setError(null);
      return created;
    },
    [key],
  );

  const update = useCallback(
    async (
      id: string,
      patch: { note?: string; color?: string; kind?: string; tags?: string[] },
    ) => {
      await api.patchAnnotation(id, patch);
      setItems((current) =>
        current.map((item) =>
          item.id === id ? ({ ...item, ...patch } as Annotation) : item,
        ),
      );
      setError(null);
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    await api.deleteAnnotation(id);
    setItems((current) => current.filter((item) => item.id !== id));
    setError(null);
  }, []);

  return { items, loading, error, create, update, remove, reload };
}
