import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

export type TranslationPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; targets: string[]; cached: number; newly: number }
  | { kind: 'error'; message: string };

/**
 * 一页正文的段落译文。按段哈希在服务端缓存，重复阅读零额度成本。
 *
 * 导入时已翻译的页面自动从缓存恢复；旧文档仍可按页触发翻译。
 */
export function useTranslations(key: string | null) {
  const [phase, setPhase] = useState<TranslationPhase>({ kind: 'idle' });
  const [activePage, setActivePage] = useState<number | null>(null);
  const requestVersion = useRef(0);
  const controller = useRef<AbortController | null>(null);

  // 换论文就清空：否则会把上一篇的译文贴到新论文上。
  useEffect(() => {
    requestVersion.current += 1;
    setPhase({ kind: 'idle' });
    setActivePage(null);
    return () => controller.current?.abort();
  }, [key]);

  const translate = useCallback(
    async (page: number, segments: string[], cachedOnly = false) => {
      if (!key || !segments.length) return;
      controller.current?.abort();
      controller.current = new AbortController();
      const version = ++requestVersion.current;
      if (!cachedOnly) {
        setActivePage(page);
        setPhase({ kind: 'loading' });
      }
      try {
        const response = await api.translate(key, segments, controller.current.signal, cachedOnly);
        if (version !== requestVersion.current) return;
        if (cachedOnly && !response.complete) return;
        setActivePage(page);
        setPhase({
          kind: 'ready',
          targets: response.items.map((item) => item.target),
          cached: response.cached,
          newly: response.newly,
        });
      } catch (error) {
        if (version !== requestVersion.current) return;
        if (cachedOnly) return;
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    },
    [key],
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    requestVersion.current += 1;
    setPhase({ kind: 'idle' });
    setActivePage(null);
  }, []);

  return { phase, activePage, translate, reset };
}
