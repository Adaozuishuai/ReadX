import { useCallback, useEffect, useState } from 'react';
import type { GenerateResponse, ReadingEntry, ReadingVisualReference } from '../api/client';
import { api } from '../api/client';

export type ReadingKind = 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';

export interface ReadingState {
  entries: Partial<Record<ReadingKind, ReadingEntry>>;
  loading: boolean;
  error: string | null;
}

/** 精读产物：读取已存条目 + 触发结构化生成（服务端负责校验与四层兜底）。 */
export function useReadings(key: string | null) {
  const [state, setState] = useState<ReadingState>({ entries: {}, loading: false, error: null });
  const [generating, setGenerating] = useState<ReadingKind | null>(null);
  const [notice, setNotice] = useState<GenerateResponse | null>(null);

  const reload = useCallback(async () => {
    if (!key) {
      setState({ entries: {}, loading: false, error: null });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.readings(key);
      const entries: ReadingState['entries'] = {};
      for (const kind of ['motivation', 'method', 'experiment', 'results', 'reproduction'] as ReadingKind[]) {
        const legacyKey = kind === 'experiment' ? 'experimentJSON' : kind === 'results' ? 'resultsJSON' : kind;
        const raw = response.entries[kind] ?? response.entries[legacyKey];
        if (typeof raw === 'string' && raw.trim()) {
          entries[kind] = { value: raw, demoted: [], validationError: '旧版记录，尚未按当前规则重新核验', updatedAt: '' };
        }
        if (raw && typeof raw === 'object' && 'value' in (raw as Record<string, unknown>)) {
          entries[kind] = raw as ReadingEntry;
        }
      }
      setState({ entries, loading: false, error: null });
    } catch (error) {
      setState({ entries: {}, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [key]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const generate = useCallback(
    async (kind: ReadingKind, visuals: ReadingVisualReference[] = []) => {
      if (!key) return;
      setGenerating(kind);
      setNotice(null);
      try {
        const result = await api.generate(key, kind, visuals);
        setNotice(result);
        await reload();
      } catch (error) {
        setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
      } finally {
        setGenerating(null);
      }
    },
    [key, reload],
  );

  return { ...state, generating, notice, generate, clearNotice: () => setNotice(null), reload };
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
    return groups;
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
