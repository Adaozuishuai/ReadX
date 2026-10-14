import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import type { ReadingKind } from '../hooks/useReadings';
import { parseExperimentEntries, useReadings } from '../hooks/useReadings';
import type { AIStatus } from '../api/client';
import { api } from '../api/client';
import { useChat } from '../hooks/useChat';

const TABS = [
  { id: 'chat', label: '对话' },
  { id: 'reading', label: '精读' },
  { id: 'notes', label: '批注', stage: 'S4' },
  { id: 'bilingual', label: '对照', stage: 'S5' },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface Props {
  selected: DocumentSummary | null;
  onCite: (page: number) => void;
}

export function SideColumn({ selected, onCite }: Props) {
  const [tab, setTab] = useState<TabId>('chat');
  const [status, setStatus] = useState<AIStatus | null>(null);
  const key = selected?.key ?? null;

  useEffect(() => {
    const controller = new AbortController();
    api
      .aiStatus(controller.signal)
      .then(setStatus)
      .catch(() => setStatus({ configured: false, error: '读取 AI 配置状态失败' }));
    return () => controller.abort();
  }, []);

  return (
    <aside className="card-surface flex h-full min-h-0 w-full flex-col overflow-hidden rounded-card">
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-current={item.id === tab ? 'true' : undefined}
            title={'stage' in item ? `完整功能在 ${item.stage} 落地` : undefined}
            className={[
              'rounded-pill px-2.5 py-1 text-[12px] transition',
              item.id === tab ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto pr-1 text-[11px] text-ink-faint">
          {status?.configured ? status.model : '未配置'}
        </span>
      </div>

      {status && !status.configured ? (
        <p className="border-b border-line bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
          {status.error ?? '未配置 API Key'}——对话与精读生成暂不可用，其余功能不受影响。
        </p>
      ) : null}

      {tab === 'chat' ? <ChatPane apiKey={key} onCite={onCite} disabled={!status?.configured} /> : null}
      {tab === 'reading' ? <ReadingPane apiKey={key} onCite={onCite} disabled={!status?.configured} /> : null}
      {tab === 'notes' || tab === 'bilingual' ? (
        <PlaceholderPane label={tab === 'notes' ? '批注' : '对照翻译'} stage={tab === 'notes' ? 'S4' : 'S5'} />
      ) : null}
    </aside>
  );
}

function ChatPane({ apiKey, onCite, disabled }: { apiKey: string | null; onCite: (page: number) => void; disabled: boolean }) {
  const { turns, busy, send, stop } = useChat(apiKey);
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);

  const submit = () => {
    const question = draft.trim();
    if (!question) return;
    setDraft('');
    void send(question);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {turns.length === 0 ? (
          <p className="pt-6 text-center text-[13px] leading-relaxed text-ink-soft">
            {apiKey ? '就这篇论文提问。回答里的 (Page N) 可点击跳到原文。' : '先在左侧选一篇论文。'}
          </p>
        ) : null}
        {turns.map((turn, index) => (
          <div key={index} className={turn.role === 'user' ? 'flex justify-end' : 'flex'}>
            <div
              className={[
                'max-w-[88%] rounded-card px-3 py-2 text-[13px] leading-relaxed',
                turn.role === 'user' ? 'bg-accent-soft text-ink' : 'card-surface',
              ].join(' ')}
            >
              {turn.scope && turn.scope.included < turn.scope.total ? (
                <p className="mb-1 text-[11px] text-ink-faint">
                  材料为相关 {turn.scope.included}/{turn.scope.total} 页
                </p>
              ) : null}
              <p className="whitespace-pre-wrap">
                <CitedText text={turn.text} onCite={onCite} />
              </p>
              {turn.error ? <p className="mt-1.5 text-[12px] leading-relaxed text-bad">{turn.error}</p> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2 border-t border-line p-3">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          disabled={!apiKey || disabled}
          placeholder={!apiKey ? '先选一篇论文' : disabled ? 'API 未配置' : '提问这篇论文…'}
          className="flex-1 resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        {busy ? (
          <button type="button" onClick={stop} className="rounded-lg border border-line px-3 py-2 text-[13px] text-ink-soft">
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!apiKey || disabled || !draft.trim()}
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-surface shadow-sm transition hover:brightness-105 disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

/** 把 (Page N) 变成可点击的跳转入口；这是「出处跳原文」的最小实现。 */
function CitedText({ text, onCite }: { text: string; onCite: (page: number) => void }) {
  const parts: React.ReactNode[] = [];
  const pattern = /Page\s+(\d+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const page = Number(match[1]);
    parts.push(
      <button
        key={`${page}-${match.index}`}
        type="button"
        onClick={() => onCite(page)}
        className="mx-0.5 rounded-pill bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent hover:text-surface"
      >
        Page {page}
      </button>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function ReadingPane({ apiKey, onCite, disabled }: { apiKey: string | null; onCite: (page: number) => void; disabled: boolean }) {
  const { entries, loading, error, generating, notice, generate, clearNotice } = useReadings(apiKey);

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        {(['experiment', 'results'] as ReadingKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => void generate(kind)}
            disabled={!apiKey || disabled || generating !== null}
            className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft shadow-sm transition hover:border-accent hover:text-accent disabled:opacity-40"
          >
            {generating === kind ? '生成中…' : kind === 'experiment' ? '生成实验配置' : '生成结果分析'}
          </button>
        ))}
      </div>

      {notice ? (
        <div className="rounded-lg bg-surface-sunk px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
          <p>
            已保存（{notice.attempts} 轮）
            {notice.pruned ? ' · 本地修剪后通过' : notice.validationError ? ' · 未核验' : ' · 逐字核验通过'}
          </p>
          {notice.demoted.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {notice.demoted.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          <button type="button" onClick={clearNotice} className="mt-1 text-[11px] text-ink-faint underline">
            收起
          </button>
        </div>
      ) : null}

      {loading ? <p className="text-[13px] text-ink-soft">读取精读产物…</p> : null}
      {error ? <p className="text-[13px] leading-relaxed text-bad">{error}</p> : null}
      {!loading && !entries.experiment && !entries.results ? (
        <p className="text-[13px] leading-relaxed text-ink-soft">
          还没有解析产物。点上面的按钮生成：模型输出会先过证据校验，不过则自动修正重试、再降级、再本地修剪，
          实在过不了会标成「未核验」保存而不是悄悄丢弃。
        </p>
      ) : null}

      {entries.experiment ? <ExperimentBlock entry={entries.experiment} onCite={onCite} /> : null}
      {entries.results ? <ResultsBlock entry={entries.results} /> : null}
    </div>
  );
}

function UnverifiedBanner({ entry }: { entry: { validationError: string | null; demoted: string[] } }) {
  if (entry.validationError) {
    return (
      <p className="mb-2 rounded-lg bg-bad/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-bad">
        未核验：{entry.validationError}
      </p>
    );
  }
  if (entry.demoted.length) {
    return (
      <p className="mb-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-warn">
        部分条目已降级：{entry.demoted.join('；')}
      </p>
    );
  }
  return null;
}

function ExperimentBlock({ entry, onCite }: { entry: import('../api/client').ReadingEntry; onCite: (page: number) => void }) {
  const groups = parseExperimentEntries(entry.value);
  if (!groups) {
    return (
      <section>
        <h3 className="mb-1 text-[13px] font-semibold">实验配置</h3>
        <UnverifiedBanner entry={entry} />
        <pre className="overflow-x-auto rounded-lg bg-surface-sunk p-2 text-[11px]">{entry.value.slice(0, 400)}</pre>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-semibold">实验配置</h3>
      <UnverifiedBanner entry={entry} />
      <div className="space-y-2">
        {groups
          .filter((group) => group.fields.length)
          .map((group) => (
            <div key={group.group} className="rounded-lg border border-line px-2.5 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">{group.group}</p>
              <dl className="mt-1 space-y-1">
                {group.fields.map((field, index) => (
                  <div key={`${field.k}-${index}`} className="flex gap-2 text-[12px] leading-snug">
                    <dt className="w-24 shrink-0 text-ink-soft">{field.k}</dt>
                    <dd className="min-w-0 flex-1">
                      {field.v}
                      {field.page != null ? (
                        <button
                          type="button"
                          onClick={() => onCite(field.page as number)}
                          className="ml-1.5 rounded-pill bg-accent-soft px-1.5 text-[10px] text-accent hover:bg-accent hover:text-surface"
                        >
                          P{field.page}
                        </button>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
      </div>
    </section>
  );
}

function ResultsBlock({ entry }: { entry: import('../api/client').ReadingEntry }) {
  let parsed: { tables?: unknown[]; missing?: string[] } | null = null;
  try {
    parsed = JSON.parse(entry.value);
  } catch {
    parsed = null;
  }
  const tables = Array.isArray(parsed?.tables) ? parsed.tables.length : 0;
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-semibold">结果分析</h3>
      <UnverifiedBanner entry={entry} />
      <p className="rounded-lg border border-line px-2.5 py-2 text-[12px] text-ink-soft">
        {parsed ? `已存 ${tables} 张结果表${parsed.missing?.length ? `，${parsed.missing.length} 项标注缺失` : ''}。表格视图在精读面板后续阶段展开。` : '结果分析 JSON 无法解析，请重新生成。'}
      </p>
    </section>
  );
}

function PlaceholderPane({ label, stage }: { label: string; stage: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p className="max-w-[26ch] text-center text-[13px] leading-relaxed text-ink-soft">
        {label}面板在 {stage} 落地。
      </p>
    </div>
  );
}
