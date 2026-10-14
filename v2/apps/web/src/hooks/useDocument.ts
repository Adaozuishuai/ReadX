import { useCallback, useEffect, useState } from 'react';
import type { DocumentDetail, WireStatus } from '@cbct/shared';
import { api } from '../api/client';

export type DocumentPhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; detail: DocumentDetail }
  | { kind: 'error'; message: string };

/** 当前选中论文的详情（含逐页索引与已存精读产物）。 */
export function useDocument(key: string | null): {
  phase: DocumentPhase;
  refresh: () => void;
  setStatus: (status: WireStatus) => Promise<void>;
} {
  const [phase, setPhase] = useState<DocumentPhase>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!key) {
      setPhase({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: 'loading' });
    void (async () => {
      try {
        const detail = await api.document(key, controller.signal);
        if (controller.signal.aborted) return;
        setPhase({ kind: 'ready', detail });
      } catch (error) {
        if (controller.signal.aborted) return;
        setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => controller.abort();
  }, [key, attempt]);

  const refresh = useCallback(() => setAttempt((value) => value + 1), []);

  const setStatus = useCallback(
    async (status: WireStatus) => {
      if (!key) return;
      await api.setStatus(key, status);
      setAttempt((value) => value + 1);
    },
    [key],
  );

  return { phase, refresh, setStatus };
}

export type PagePhase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; text: string; chars: number }
  | { kind: 'missing'; message: string }
  | { kind: 'error'; message: string };

/** 单页正文。404 与真正的错误要分开：前者是「这一页还没抽取」，界面应给出下一步动作。 */
export function usePageText(key: string | null, page: number | null): PagePhase {
  const [phase, setPhase] = useState<PagePhase>({ kind: 'idle' });

  useEffect(() => {
    if (!key || page == null) {
      setPhase({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    setPhase({ kind: 'loading' });
    void (async () => {
      try {
        const result = await api.page(key, page, controller.signal);
        if (controller.signal.aborted) return;
        setPhase({ kind: 'ready', text: result.text, chars: result.chars });
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setPhase(
          error instanceof Object && 'status' in error && (error as { status?: number }).status === 404
            ? { kind: 'missing', message }
            : { kind: 'error', message },
        );
      }
    })();
    return () => controller.abort();
  }, [key, page]);

  return phase;
}
