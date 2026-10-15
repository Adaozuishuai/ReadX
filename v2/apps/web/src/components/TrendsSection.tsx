import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResearchIdea, TrendFinding } from '../api/client';
import { api } from '../api/client';
import type { WorkspacePhase } from '../hooks/useWorkspace';

const IDEA_STATUSES = [
  { id: 'Idea', label: '想法' },
  { id: 'Planned', label: '待实验' },
  { id: 'Running', label: '实验中' },
  { id: 'Rejected', label: '已否定' },
  { id: 'Adopted', label: '已采纳' },
] as const;

const STATUS_TONE: Record<string, string> = {
  Idea: 'bg-surface-sunk text-ink-soft',
  Planned: 'bg-accent-soft text-accent',
  Running: 'bg-warn/10 text-warn',
  Rejected: 'bg-bad/10 text-bad',
  Adopted: 'bg-good/10 text-good',
};

/**
 * S6 工作区：左「趋势」右「想法」。
 *
 * 趋势一律展示 claim 与 caveat 两行：caveat 说明「样本数够不够下判断」，
 * 与 claim 分开渲染是 PRD 的硬约束，不能只让用户看到结论。
 */
export function TrendsSection({ phase, onBack }: { phase: WorkspacePhase; onBack?: () => void }) {
  const [status, setStatus] = useState('');
  const [trends, setTrends] = useState<{ findings: TrendFinding[]; count: number; minimum: number } | null>(null);
  const [ideas, setIdeas] = useState<ResearchIdea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const [trendResult, ideaResult] = await Promise.all([api.trends(status), api.ideas()]);
      if (version !== loadVersion.current) return;
      setTrends({
        findings: trendResult.findings,
        count: trendResult.sample.count,
        minimum: trendResult.minimum,
      });
      setIdeas(ideaResult.ideas);
      setError(null);
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const createIdea = async () => {
    setBusy(true);
    try {
      const created = await api.createIdea({ question: '新想法：', status: 'Idea' });
      setIdeas((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const patchIdea = async (id: string, body: Partial<ResearchIdea>) => {
    try {
      const updated = await api.patchIdea(id, body);
      setIdeas((current) => current.map((idea) => (idea.id === id ? updated : idea)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const removeIdea = async (id: string) => {
    try {
      await api.deleteIdea(id);
      setIdeas((current) => current.filter((idea) => idea.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const total = phase.kind === 'ready' ? phase.meta.documentsTotal : 0;

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(320px,420px)] gap-3 p-3">
      <section className="card-surface flex min-h-0 flex-col overflow-hidden rounded-card">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          {onBack ? (
            <button type="button" onClick={onBack} className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-soft hover:text-ink">
              ← 书库
            </button>
          ) : null}
          <h2 className="text-[15px] font-semibold">趋势</h2>
          <span className="text-[12px] text-ink-faint">按系统标签聚合 · 只报告计数与证据，不输出伪趋势</span>
          <div className="ml-auto flex items-center gap-1">
            {[{ id: '', label: '全部' }, { id: 'done', label: '已精读' }, { id: 'reading', label: '在读' }].map((item) => (
              <button
                key={item.id || 'all'}
                type="button"
                onClick={() => setStatus(item.id)}
                className={[
                  'rounded-pill px-2 py-1 text-[12px] transition',
                  status === item.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:text-ink',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
          {error ? <p className="text-[13px] leading-relaxed text-bad">{error}</p> : null}
          {trends && trends.count < trends.minimum ? (
            <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
              当前样本数 {trends.count} &lt; {trends.minimum}：样本不足，不下趋势判断，只报告计数与证据集合。
            </p>
          ) : null}
          {trends && trends.findings.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-ink-soft">
              库里有 {total} 篇论文，但没有从标题/摘要/会场里派生出任何系统标签——趋势以标签聚合，标签为空就没有可展示的条目。
            </p>
          ) : null}
          {trends?.findings.map((finding) => (
            <article key={finding.Topic} className="rounded-lg border border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium">{finding.Topic}</span>
                <span className="rounded-pill bg-surface-sunk px-2 py-0.5 text-[11px] text-ink-soft">{finding.Count} 篇</span>
                {!finding.IsSupported ? (
                  <span className="rounded-pill bg-warn/10 px-2 py-0.5 text-[11px] text-warn">样本不足</span>
                ) : null}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink">{finding.Claim}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{finding.Caveat}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="card-surface flex min-h-0 flex-col overflow-hidden rounded-card">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">想法</h2>
          <span className="text-[12px] text-ink-faint">{ideas.length} 条</span>
          <button
            type="button"
            onClick={() => void createIdea()}
            disabled={busy}
            className="ml-auto rounded-lg bg-accent px-2.5 py-1.5 text-[12px] font-medium text-surface shadow-sm transition hover:brightness-105 disabled:opacity-40"
          >
            {busy ? '新建中…' : '新建想法'}
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {!ideas.length ? (
            <p className="pt-4 text-center text-[13px] leading-relaxed text-ink-soft">
              还没有想法。想法支持五状态流转（想法 / 待实验 / 实验中 / 已否定 / 已采纳），
              带「论文原文」来源的证据会强制逐字核验。
            </p>
          ) : null}
          {ideas.map((idea) => (
            <article key={idea.id} className="rounded-lg border border-line px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span className={`rounded-pill px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[idea.status] ?? 'bg-surface-sunk text-ink-soft'}`}>
                  {IDEA_STATUSES.find((item) => item.id === idea.status)?.label ?? idea.status}
                </span>
                <span className="ml-auto text-[11px] text-ink-faint">{idea.updatedAt.slice(0, 10)}</span>
              </div>
              <textarea
                value={idea.question}
                onChange={(event) => setIdeas((current) => current.map((item) => (item.id === idea.id ? { ...item, question: event.target.value } : item)))}
                onBlur={(event) => void patchIdea(idea.id, { question: event.target.value })}
                rows={2}
                placeholder="这个问题是什么？"
                className="mt-1.5 w-full resize-none rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] placeholder:text-ink-faint focus:border-accent focus:outline-none"
              />
              <div className="mt-1.5 flex items-center gap-1">
                {IDEA_STATUSES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void patchIdea(idea.id, { status: item.id })}
                    className={[
                      'rounded-pill px-1.5 py-0.5 text-[11px] transition',
                      idea.status === item.id ? 'bg-accent-soft font-medium text-accent' : 'text-ink-faint hover:text-ink',
                    ].join(' ')}
                  >
                    {item.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void removeIdea(idea.id)}
                  className="ml-auto text-[11px] text-ink-faint hover:text-bad"
                >
                  删除
                </button>
              </div>
              {idea.evidence.length ? (
                <ul className="mt-1.5 space-y-1">
                  {idea.evidence.map((item) => (
                    <li key={item.id} className="rounded-lg bg-surface-sunk px-2 py-1 text-[11px] leading-snug text-ink-soft">
                      <span className="mr-1 rounded-pill bg-surface px-1.5 py-0.5 text-[10px] text-ink-faint">{item.origin}</span>
                      {item.excerpt}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
