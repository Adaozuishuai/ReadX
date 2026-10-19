import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AIPreferences } from '../hooks/useAIPreferences';
import { WorkspaceIcon } from './WorkspaceIcon';

const EFFORT_LABELS: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };
export function effortLabel(value: string) { return EFFORT_LABELS[value] ?? value; }

const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function ComposerModelPicker({ preferences: p }: { preferences: AIPreferences }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'effort' | 'models'>('effort');
  const [preview, setPreview] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const effortSaving = useRef(false);
  const queuedEffort = useRef<{ model: string; value: string } | null>(null);
  const savingPreview = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const s = p.settings;
  const blocked = p.loading || p.saving || !s;
  const rangeBlocked = p.loading || !s || (p.saving && !effortSaving.current);
  const isCodex = s?.provider === 'codex';
  const effort = s?.reasoningEffort || p.model?.defaultReasoningEffort || '';
  const levels = [...new Set(p.model?.supportedReasoningEfforts?.map((item) => item.reasoningEffort) ?? [])].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  const visibleEffort = preview === null ? effort : preview || p.model?.defaultReasoningEffort || '';
  const levelIndex = levels.indexOf(visibleEffort);
  const fraction = levels.length > 1 ? Math.max(0, levelIndex) / (levels.length - 1) : 0.5;
  const modelName = p.model?.displayName || s?.model || (isCodex ? 'Codex default' : s?.provider) || 'Choose model';
  const close = () => { setOpen(false); pending.current = null; setPreview(savingPreview.current); };
  const commitEffort = () => {
    const value = pending.current;
    if (value === null || rangeBlocked) return;
    pending.current = null;
    if (!effortSaving.current && value === s?.reasoningEffort) { setPreview(null); return; }
    queuedEffort.current = { model: s?.model ?? '', value };
    savingPreview.current = value;
    if (effortSaving.current) return;
    effortSaving.current = true;
    // Keep the slider live while serializing writes. During quick successive
    // drags only the newest queued level needs to follow the active save.
    void (async () => {
      try {
        while (queuedEffort.current) {
          const next = queuedEffort.current;
          queuedEffort.current = null;
          await p.select(next.model, next.value);
        }
      } finally {
        effortSaving.current = false;
        savingPreview.current = null;
        if (pending.current === null) setPreview(null);
      }
    })();
  };
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) { setOpen(false); pending.current = null; setPreview(savingPreview.current); } };
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); pending.current = null; setPreview(savingPreview.current); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const first = view === 'models' ? panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ?? panel.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]') : panel.current?.querySelector<HTMLInputElement>('input[type="range"]');
    first?.focus({ preventScroll: true });
  }, [open, view]);
  const selectModel = async (model: string) => {
    if (blocked) return;
    pending.current = null; setPreview(null);
    if (await p.select(model, '')) setView('effort');
  };
  const moveModelFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]:not(:disabled)'));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length;
    buttons[next]?.focus();
  };
  const row = (value: string, label: string, selected: boolean, description?: string) => <button key={value || 'default'} type="button" role="menuitemradio" aria-checked={selected} disabled={blocked} className="composer-model-option" onClick={() => { if (selected) setView('effort'); else void selectModel(value); }}>
    <span><span>{label}</span>{description && <small>{description}</small>}</span>{selected && <WorkspaceIcon name="check" size={18} />}
  </button>;
  return <div className="composer-model-picker" ref={root} aria-busy={blocked}>
    <button type="button" ref={trigger} className="composer-model-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { if (open) close(); else { setView('effort'); setOpen(true); } }} title="Model and reasoning effort">
      <span className="composer-model-name">{modelName}</span>{visibleEffort && <span className="composer-effort">{EFFORT_LABELS[visibleEffort] || visibleEffort}</span>}<WorkspaceIcon name="chevron" size={14} />
    </button>
    {open && <div ref={panel} className={'composer-model-menu ' + (view === 'models' ? 'models' : 'reasoning')} role="dialog" aria-label={view === 'models' ? 'Choose model' : 'Reasoning effort'} id={id}>
      {view === 'models' ? <>
        <div className="composer-menu-heading"><span>Choose model</span><button type="button" className="composer-menu-back" onClick={() => setView('effort')} aria-label="Back to reasoning effort"><WorkspaceIcon name="chevron" size={16} /></button></div>
        <div role="menu" aria-label="Model" className="composer-model-list" onKeyDown={moveModelFocus}>
          {row('', 'Default', !s?.model, 'Recommended model')}
          {s?.model && !p.catalog.some((m) => m.model === s.model || m.id === s.model) && row(s.model, s.model, true)}
          {p.catalog.map((m) => row(m.model, m.displayName || m.model, s?.model === m.model || s?.model === m.id))}
        </div>
        {(!p.catalog.length || p.error) && <button type="button" className="composer-reload-models" disabled={blocked} onClick={() => void p.reload(true)}>{p.loading ? 'Loading…' : 'Refresh models'}</button>}
      </> : <>
        <div className="composer-reasoning-heading">
          <span className="composer-reasoning-symbol"><WorkspaceIcon name="lightning" size={19} /></span>
          <div><strong aria-live="polite">{EFFORT_LABELS[visibleEffort] || visibleEffort || 'Default'}</strong><button type="button" className="composer-current-model" onClick={() => setView('models')} disabled={!isCodex}><span>{modelName}</span><WorkspaceIcon name="chevronRight" size={13} /></button></div>
          <button type="button" className="composer-reset-effort" disabled={rangeBlocked || !isCodex || (!s?.reasoningEffort && preview === null && !effortSaving.current)} aria-label="Reset to model default" title="Reset to default" onClick={() => { pending.current = ''; setPreview(''); commitEffort(); }}><WorkspaceIcon name="reset" size={18} /></button>
        </div>
        {!!levels.length && <div className="composer-effort-slider" style={{ '--effort-fill': 'calc(' + fraction * 100 + '% + ' + (16 - 32 * fraction) + 'px)' } as CSSProperties}>
          <div className="composer-effort-track"><div className="composer-effort-fill" />{levels.map((level, i) => { const f = levels.length > 1 ? i / (levels.length - 1) : 0.5; return <span key={level} className={'composer-effort-dot' + (i <= levelIndex ? ' filled' : '')} style={{ left: 'calc(' + f * 100 + '% + ' + (16 - 32 * f) + 'px)' }} />; })}</div>
          <input type="range" aria-label="Reasoning effort" aria-valuetext={EFFORT_LABELS[visibleEffort] || visibleEffort} min={0} max={Math.max(0, levels.length - 1)} step={1} value={Math.max(0, levelIndex)} disabled={rangeBlocked || levels.length < 2} onChange={(event) => { const level = levels[Number(event.target.value)]; if (level) { pending.current = level; setPreview(level); } }} onPointerUp={commitEffort} onTouchEnd={commitEffort} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitEffort(); }} onBlur={commitEffort} onPointerCancel={() => { pending.current = null; setPreview(savingPreview.current); }} />
        </div>}
        {!levels.length && <button type="button" className="composer-reload-models" disabled={blocked || !isCodex} onClick={() => void p.reload(true)}>{p.loading ? 'Loading…' : 'Load models'}</button>}
      </>}
      <span className="sr-only" role="status">{p.saving ? 'Saving…' : ''}</span>
      {p.error && <p className="composer-menu-error" role="alert">{p.error}</p>}
    </div>}
    {!open && p.error && <span className="composer-model-error" title={p.error} aria-label={p.error} role="status">!</span>}
  </div>;
}

export function AIModelControls({ preferences: p, compact = false, variant = 'standard' }: { preferences: AIPreferences; compact?: boolean; variant?: 'standard' | 'composer' }) {
  if (variant === 'composer') return <ComposerModelPicker preferences={p} />;
  const s = p.settings;
  if (s && s.provider !== 'codex') return <div className="ai-model-controls"><span>{s.model || s.provider}</span></div>;
  const blocked = p.loading || p.saving || !s;
  return <div className={`ai-model-controls${compact ? ' compact' : ''}`} aria-busy={blocked}>
    <label><span>Model</span><select aria-label="Model" value={s?.model ?? ''} disabled={blocked || !p.catalog.length}
      onChange={(event) => void p.select(event.target.value, '')}>
      <option value="">Codex default{s?.model ? '' : p.model ? ` · ${p.model.displayName}` : ''}</option>
      {s?.model && !p.catalog.some((m) => m.model === s.model) && <option value={s.model}>{s.model} · Unavailable in catalog</option>}
      {p.catalog.map((m) => <option key={m.id} value={m.model}>{m.displayName || m.model}</option>)}
    </select></label>
    <label><span>Reasoning effort</span><select aria-label="Reasoning effort" value={s?.reasoningEffort ?? ''} disabled={blocked || !p.model}
      onChange={(event) => void p.select(s?.model ?? '', event.target.value)}>
      <option value="">Default{p.model ? ` · ${effortLabel(p.model.defaultReasoningEffort)}` : ''}</option>
      {s?.reasoningEffort && !p.model?.supportedReasoningEfforts?.some((e) => e.reasoningEffort === s.reasoningEffort) && <option value={s.reasoningEffort}>{s.reasoningEffort} · Unavailable in catalog</option>}
      {p.model?.supportedReasoningEfforts?.map((e) => <option key={e.reasoningEffort} value={e.reasoningEffort}>{effortLabel(e.reasoningEffort)}</option>)}
    </select></label>
    {!compact && <small>{p.saving ? 'Saving…' : p.loading ? 'Loading models…' : ''} <button type="button" disabled={blocked} onClick={() => void p.reload(true)}>Refresh</button></small>}
    {p.error && <small role="alert" className="text-bad">{p.error} <button disabled={blocked} onClick={() => void p.reload(true)}>Retry</button></small>}
  </div>;
}
