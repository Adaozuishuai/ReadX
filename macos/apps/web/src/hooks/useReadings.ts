import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerateProgress, GenerateResponse, ReadingEntry, ReadingVisualReference, ReadingGenerationInput } from '../api/client';
import { api } from '../api/client';

export type ReadingKind = 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';

export interface ReadingState {
  entries: Partial<Record<ReadingKind, ReadingEntry>>;
  loading: boolean;
  error: string | null;
  visualAnalysis?: ReadingEntry;
}

/** Load durable readings and apply completed subsection updates during generation. */
export function useReadings(key: string | null) {
  const [state, setState] = useState<ReadingState>({ entries: {}, loading: false, error: null });
  const [generating, setGenerating] = useState<Partial<Record<ReadingKind | 'visuals', boolean>>>({});
  const [progress, setProgress] = useState<Partial<Record<ReadingKind | 'visuals', GenerateProgress>>>({});
  const [jobErrors, setJobErrors] = useState<Partial<Record<ReadingKind | 'visuals', string>>>({});
  const [notices, setNotices] = useState<Partial<Record<ReadingKind | 'visuals', GenerateResponse>>>({});
  const epoch = useRef(0);
  const request = useRef(new Map<ReadingKind | 'visuals', AbortController>());
  const loadSequence = useRef(0);

  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const generation = epoch.current;
    if (!key) {
      setState({ entries: {}, loading: false, error: null });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.readings(key);
      if (generation !== epoch.current || sequence !== loadSequence.current) return;
      const entries: ReadingState['entries'] = {};
      for (const kind of ['motivation', 'method', 'experiment', 'results', 'reproduction'] as ReadingKind[]) {
        const legacyKey = kind === 'experiment' ? 'experimentJSON' : kind === 'results' ? 'resultsJSON' : kind;
        const raw = response.entries[kind] ?? response.entries[legacyKey];
        if (typeof raw === 'string' && raw.trim()) {
          entries[kind] = { value: raw, demoted: [], validationError: '旧版记录，尚未按当前规则重新核验', updatedAt: '' };
        }
        if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).value === 'string') {
          const item = raw as Partial<ReadingEntry> & { value: string };
          entries[kind] = { ...item, demoted: Array.isArray(item.demoted) ? item.demoted.filter((v) => typeof v === 'string') : [], validationError: typeof item.validationError === 'string' ? item.validationError : null, updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '' };
        }
      }
      const visualRaw = response.entries.visualAnalysis as ReadingEntry | undefined;
      const visualAnalysis = visualRaw && typeof visualRaw === 'object' && Array.isArray(visualRaw.visuals) ? visualRaw : undefined;
      setState((current) => {
        // A parallel reload must not replace a newer streamed partial result for
        // another section that is still running.
        for (const kind of request.current.keys()) {
          if (current.entries[kind as ReadingKind]) entries[kind as ReadingKind] = current.entries[kind as ReadingKind];
        }
        return { entries, loading: false, error: null, visualAnalysis };
      });
    } catch (error) {
      if (generation === epoch.current && sequence === loadSequence.current) setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }, [key]);

  useEffect(() => {
    ++epoch.current;
    for (const controller of request.current.values()) controller.abort();
    request.current.clear();
    setState({ entries: {}, loading: true, error: null });
    setGenerating({}); setProgress({}); setJobErrors({}); setNotices({});
    void reload();
    return () => { ++epoch.current; for (const controller of request.current.values()) controller.abort(); request.current.clear(); };
  }, [reload]);

  const generate = useCallback(
    async (kind: ReadingKind | 'visuals', visuals: ReadingVisualReference[] | ReadingGenerationInput | ((signal: AbortSignal, progress: (value: GenerateProgress) => void) => Promise<ReadingVisualReference[] | ReadingGenerationInput>) = []) => {
      if (!key || request.current.has(kind)) return false;
      const generation = epoch.current;
      const controller = new AbortController();
      request.current.set(kind, controller);
      setGenerating((current) => ({ ...current, [kind]: true }));
      setProgress((current) => ({ ...current, [kind]: { percent: 2, message: '正在准备精读任务…' } }));
      setJobErrors((current) => ({ ...current, [kind]: undefined }));
      setState((current) => ({ ...current, error: null }));
      setNotices((current) => ({ ...current, [kind]: undefined }));
      try {
        const report = (value: GenerateProgress) => { if (epoch.current === generation && request.current.get(kind) === controller) setProgress((current) => ({ ...current, [kind]: value })); };
        const input = typeof visuals === 'function' ? await visuals(controller.signal, report) : visuals;
        const references = Array.isArray(input) ? input : input.visuals;
        const paper = Array.isArray(input) ? undefined : { workflow: input.workflow, fingerprint: input.fingerprint, pageCount: input.pageCount, unavailableVisuals: input.unavailableVisuals };
        controller.signal.throwIfAborted();
        const result = await api.generate(key, kind, references, report, controller.signal, (savedKind, entry) => {
          if (epoch.current === generation && savedKind === kind && kind !== 'visuals') setState((current) => ({ ...current, entries: { ...current.entries, [kind]: entry } }));
        }, paper);
        if (epoch.current !== generation || request.current.get(kind) !== controller) return false;
        setNotices((current) => ({ ...current, [kind]: result }));
        await reload();
        return result.saved;
      } catch (error) {
        // The image stage may have completed before prose generation failed.
        if (epoch.current === generation && !controller.signal.aborted) await reload();
        if (epoch.current === generation && request.current.get(kind) === controller) setJobErrors((current) => ({ ...current, [kind]: controller.signal.aborted ? '已取消本节生成；已保存的内容仍可查看。' : error instanceof Error ? error.message : String(error) }));
        return false;
      } finally {
        if (epoch.current === generation && request.current.get(kind) === controller) {
          request.current.delete(kind);
          setGenerating((current) => ({ ...current, [kind]: false }));
          setProgress((current) => ({ ...current, [kind]: undefined }));
        }
      }
    },
    [key, reload],
  );

  return { ...state, generating, progress, jobErrors, notices, generate, cancel: (kind?: ReadingKind | 'visuals') => { if (kind) request.current.get(kind)?.abort(); else for (const controller of request.current.values()) controller.abort(); }, reload };
}

/** 把条目 JSON 解析成「分组 → 字段」结构供界面渲染；解析失败时原样给出错误。 */
export function parseExperimentEntries(value: string): { group: string; fields: ReadingField[] }[] | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const labels: Record<string, string> = {
      dataset: '数据集', acquisition: '采集与几何', training: '训练', loss: '损失',
      baselines: '对比基线', metrics: '评价指标', results: '结果',
    };
    const groups: { group: string; fields: ReadingField[] }[] = [];
    for (const [key, label] of Object.entries(labels)) {
      const raw = parsed[key];
      if (!Array.isArray(raw)) continue;
      const fields = raw.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        const k = typeof record.k === 'string' ? record.k : '';
        const v = typeof record.v === 'string' ? record.v : '';
        if (!k && !v) return [];
        const field: ReadingField = { k, v };
        if (typeof record.page === 'number') field.page = record.page;
        if (typeof record.excerpt === 'string') field.excerpt = record.excerpt;
        return [field];
      });
      groups.push({ group: label, fields });
    }
    return groups.length ? groups : null;
  } catch {
    return null;
  }
}

export interface ReadingField {
  k: string;
  v: string;
  page?: number;
  excerpt?: string;
}
