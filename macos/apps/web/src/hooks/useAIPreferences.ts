import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AISettings, type CodexModel } from '../api/client';

export function useAIPreferences() {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [catalog, setCatalog] = useState<CodexModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const version = useRef(0);
  const lock = useRef(false);
  const catalogProvider = useRef('');
  const catalogRef = useRef<CodexModel[]>([]);
  const settingsRef = useRef<AISettings | null>(null);
  const source = useRef(crypto.randomUUID());
  const reload = useCallback(async (refresh = false) => {
    const sequence = ++version.current;
    setLoading(true);
    setError('');
    try {
      const value = await api.settings();
      if (!alive.current || sequence !== version.current) return;
      setSettings(value);
      settingsRef.current = value;
      if (value.provider !== 'codex' || catalogProvider.current !== value.provider) { setCatalog([]); catalogRef.current = []; }
      catalogProvider.current = value.provider;
      if (value.provider === 'codex') {
        const result = await api.listModels({ provider: 'codex', baseURL: '', refresh });
        if (alive.current && sequence === version.current) { catalogRef.current = result.catalog ?? []; setCatalog(catalogRef.current); }
      }
    } catch (cause) {
      if (alive.current && sequence === version.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current && sequence === version.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void reload();
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: AISettings; source?: string }>).detail;
      if (detail?.source === source.current) return;
      const value = detail?.settings;
      // Saved settings already contain the authoritative response. A reasoning
      // change does not change the model catalog or need a loading cycle.
      if (value && value.provider === settingsRef.current?.provider && value.baseURL === settingsRef.current.baseURL && (value.provider !== 'codex' || catalogRef.current.length > 0)) {
        ++version.current;
        settingsRef.current = value; setSettings(value); setError(''); setLoading(false);
      } else { void reload(); }
    };
    window.addEventListener('cbct-ai-settings', changed);
    return () => { alive.current = false; ++version.current; window.removeEventListener('cbct-ai-settings', changed); };
  }, [reload]);
  const select = async (model: string, reasoningEffort: string) => {
    if (lock.current || !settingsRef.current || !alive.current) return false;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      // Re-read shared preferences so a dialog opened elsewhere cannot be overwritten with a stale provider.
      const current = await api.settings();
      if (current.provider !== 'codex') throw new Error('服务商已变更，请刷新后选择模型。');
      const value = await api.saveSettings({ provider: current.provider, baseURL: current.baseURL, model, reasoningEffort });
      if (alive.current) { settingsRef.current = value; setSettings(value); }
      window.dispatchEvent(new CustomEvent('cbct-ai-settings', { detail: { settings: value, source: source.current } }));
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      lock.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const model = catalog.find((item) => settings?.model ? item.model === settings.model || item.id === settings.model : item.isDefault);
  return { settings, catalog, model, loading, saving, error, reload, select };
}
export type AIPreferences = ReturnType<typeof useAIPreferences>;
