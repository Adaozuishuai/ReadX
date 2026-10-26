import { useCallback, useEffect, useRef, useState } from 'react';
import { request, streamLatexRealtime } from '../api/client';
import { LivePreview } from '../lib/rtex/live';
import type { RealtimeRuntime } from '../lib/rtex/wire';
import type { OpenFile } from './useLatexProject';

export function useLatexRealtime(projectId: string, mainFile: string, engine: string, enabled: boolean, files: OpenFile[]) {
  const [live, setLive] = useState<LivePreview | null>(null);
  const [revision, setRevision] = useState(0);
  const [runtime, setRuntime] = useState<RealtimeRuntime | null>(null);
  const [installing, setInstalling] = useState(false);
  const [generation, setGeneration] = useState(0);
  const filesRef = useRef(files);
  filesRef.current = files;
  const pumpRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const layoutRef = useRef<() => void>(() => {});
  const requestLayout = useCallback(() => layoutRef.current(), []);

  useEffect(() => {
    if (!enabled || engine !== 'lualatex') { setLive(null); return; }
    const controller = new AbortController();
    const preview = new LivePreview();
    preview.changed = () => { if (!controller.signal.aborted) setRevision(value => value + 1); };
    setLive(preview);
    setRuntime(null);
    let sessionId = '', sending = false;
    const sent = new Map<string, string>();
    const endpoint = `/v1/latex/projects/${encodeURIComponent(projectId)}/realtime/edit`;
    const fail = (cause: unknown) => {
      if (controller.signal.aborted) return;
      preview.error = cause instanceof Error ? cause.message : String(cause);
      preview.pending = false;
      preview.changed();
    };
    const pump = async () => {
      if (!sessionId || sending || controller.signal.aborted) return;
      sending = true;
      try {
        for (;;) {
          const next = filesRef.current.find(file => /\.tex$/i.test(file.path) && sent.get(file.path) !== file.content);
          if (!next || controller.signal.aborted) break;
          const { path, content } = next;
          await request(endpoint, { method: 'POST', body: { sessionId, path, text: content }, signal: controller.signal });
          sent.set(path, content);
        }
      } catch (cause) { sessionId = ''; fail(cause); }
      finally { sending = false; }
    };
    pumpRef.current = () => void pump();
    layoutRef.current = () => {
      if (!sessionId) return;
      preview.pending = true; preview.status = '正在刷新整页…'; preview.changed();
      void request(endpoint, { method: 'POST', body: { sessionId, cmd: 'request_layout' }, signal: controller.signal }).catch(fail);
    };
    void (async () => {
      try {
        const status = await request<RealtimeRuntime>('/v1/latex/realtime/runtime', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setRuntime(status);
        if (!status.ready) { preview.pending = false; preview.status = status.reason || '实时排版暂不可用'; preview.changed(); return; }
        await streamLatexRealtime(projectId, event => {
          if ('event' in event && event.event === 'ReadXReady') { sessionId = event.sessionId; void pump(); }
          preview.receive(event);
        }, controller.signal);
      } catch (cause) { fail(cause); }
    })();
    return () => {
      controller.abort();
      pumpRef.current = () => {};
      layoutRef.current = () => {};
      preview.dispose();
    };
  }, [projectId, mainFile, engine, enabled, generation]);

  useEffect(() => {
    const timer = window.setTimeout(() => pumpRef.current(), 60);
    return () => window.clearTimeout(timer);
  }, [files]);

  const install = useCallback(async () => {
    setInstalling(true);
    try {
      await request<RealtimeRuntime>('/v1/latex/realtime/runtime', { method: 'POST' });
      refresh();
    } catch (cause) {
      if (live) { live.error = cause instanceof Error ? cause.message : String(cause); live.changed(); }
    } finally { setInstalling(false); }
  }, [live, refresh]);

  return { live, revision, runtime, installing, install, refresh, requestLayout };
}
