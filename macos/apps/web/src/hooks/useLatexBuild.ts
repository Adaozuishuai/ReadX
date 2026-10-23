import { useCallback, useEffect, useState } from 'react';
import type { LatexBuild, LatexToolchainReport } from '@cbct/shared';
import { api } from '../api/client';

const POLL_INTERVAL = 700;
/** 轮询上限：编译再慢也不该让界面一直转圈（后端有自己的超时，这里只是兜底）。 */
const POLL_LIMIT = 15 * 60 * 1000;

/**
 * 编译状态。
 *
 * 服务端是异步的（POST 返回 202 + 可轮询的记录），所以这里做三件事：
 * 拉工具链状态、轮询进行中的编译、保留最近一次结果供诊断面板使用。
 * 轮询在编译结束后立刻停止——不能留一个永远在跑的定时器。
 */
export function useLatexBuild(projectId: string | null) {
  const [toolchains, setToolchains] = useState<LatexToolchainReport | null>(null);
  const [build, setBuild] = useState<LatexBuild | null>(null);
  const [history, setHistory] = useState<LatexBuild[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);

  const loadToolchains = useCallback(async (refresh = false) => {
    try {
      setToolchains(await api.latexToolchains(refresh));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadHistory = useCallback(
    async (id: string) => {
      try {
        const result = await api.latexBuilds(id);
        setHistory(result.builds);
        // 没有正在进行的编译时，把最近一次结果作为当前结果展示。
        setBuild((current) => {
          if (current && (current.status === 'queued' || current.status === 'running')) return current;
          return result.builds[0] ?? null;
        });
      } catch {
        // 历史只是参考信息，失败不打断写作。
      }
    },
    [],
  );

  useEffect(() => {
    if (!projectId) {
      setBuild(null);
      setHistory([]);
      return;
    }
    void loadToolchains();
    void loadHistory(projectId);
  }, [loadHistory, loadToolchains, projectId]);

  // 无论来自新编译还是重新打开时的历史记录，运行中的任务都恢复轮询。
  const running = build?.status === 'queued' || build?.status === 'running';
  const polledBuildId = running ? build.id : null;
  useEffect(() => {
    if (!polledBuildId) return;
    let stopped = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const current = await api.latexBuild(polledBuildId);
        if (stopped) return;
        setBuild(current);
        if (current.status === 'queued' || current.status === 'running') {
          if (Date.now() - startedAt > POLL_LIMIT) {
            setError('编译状态轮询超时：请查看编译日志。');
            return;
          }
          timer = window.setTimeout(() => void tick(), POLL_INTERVAL);
        } else if (projectId) {
          void loadHistory(projectId);
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loadHistory, polledBuildId, projectId]);

  const start = useCallback(
    async (engine?: string) => {
      if (!projectId) return null;
      setStarting(true);
      setError('');
      try {
        const started = await api.latexStartBuild(projectId, engine ? { engine } : {});
        setBuild(started);
        return started;
      } catch (cause) {
        // 「没装 TeX」「已有编译在跑」都是 409：如实显示服务端的话。
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      } finally {
        setStarting(false);
      }
    },
    [projectId],
  );

  const cancel = useCallback(async () => {
    if (!build) return;
    try {
      await api.latexCancelBuild(build.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [build]);

  return {
    toolchains,
    build,
    history,
    error,
    running,
    starting,
    setError,
    start,
    cancel,
    reloadToolchains: () => loadToolchains(true),
    reloadHistory: () => (projectId ? loadHistory(projectId) : Promise.resolve()),
  };
}
