import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary, DocumentsResponse, MetaResponse } from '@cbct/shared';
import { ApiError, api } from '../api/client';

export type WorkspacePhase =
  | { kind: 'loading' }
  | { kind: 'ready'; meta: MetaResponse; documents: DocumentsResponse }
  | { kind: 'error'; message: string; hint: string };

export interface Filters {
  status: string;
  q: string;
}

/** 把「后端没起来」「token 没注入」「Host 被拒」这三类失败区分开，否则用户只会看到一句 HTTP 错误。 */
function hintFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '本地 token 未注入：请用 npm run dev（由 Electron 壳或 Vite proxy 带上凭据）。';
    if (error.status === 403) return 'server 拒绝了该 Host：只接受 127.0.0.1 / localhost / [::1]。';
    if (error.status === 0) return 'Go server 未启动或已退出：npm run build:go 后再 npm run dev。';
    if (error.status === 422) return '旧数据文件有问题，server 已拒绝导入；按错误信息修文件后重试即可。';
  }
  return '确认后端健康：node scripts/go.mjs test ./...，或直接访问 /healthz。';
}

export function useWorkspace(): {
  phase: WorkspacePhase;
  /**
   * 不受书库搜索/状态筛选影响的文献全集：图谱、日历、复现的跨页跳转必须按 key
   * 在这一份里找人，否则搜索时点「原文依据」会打开上一篇论文。
   */
  allDocuments: DocumentSummary[];
  filters: Filters;
  setFilters: (next: Partial<Filters>) => void;
  reload: () => void;
} {
  const [phase, setPhase] = useState<WorkspacePhase>({ kind: 'loading' });
  const [allDocuments, setAllDocuments] = useState<DocumentSummary[]>([]);
  const [filters, setFiltersState] = useState<Filters>({ status: '', q: '' });
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const setFilters = useCallback((next: Partial<Filters>) => {
    setFiltersState((current) => ({ ...current, ...next }));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setPhase({ kind: 'loading' });

    void (async () => {
      try {
        const [meta, documents] = await Promise.all([
          api.meta(controller.signal),
          api.documents(controller.signal, filters),
        ]);
        if (controller.signal.aborted) return;
        setPhase({ kind: 'ready', meta, documents });
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          hint: hintFor(error),
        });
      }
    })();

    return () => controller.abort();
  }, [attempt, filters]);

  // 搜索输入的去抖在组件层用 useDebouncedValue 处理，这里只按「已提交的 filters」发请求。

  // 搜索/筛选只影响书库列表；导航另取一份全集，且只在 reload 时刷新，不随每次输入重发。
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await api.documents(controller.signal);
        if (controller.signal.aborted) return;
        setAllDocuments(result.documents);
      } catch {
        // 这里失败不覆盖主请求的错误提示：书库本身会把连接问题显示出来。
        // 调用方在 allDocuments 为空时会退回过滤后的列表，导航仍然可用（只是受搜索影响）。
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return {
    phase,
    allDocuments,
    filters,
    setFilters,
    reload,
  };
}

/** 搜索输入去抖：把即时值与「真正发出去的查询」分开。 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
