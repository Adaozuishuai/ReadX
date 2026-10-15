/**
 * 阅读页右侧助读面板（对话 / 精读 / 批注）。
 * 从旧三栏工作区的 SideColumn 原样迁移——交互与文案保持一致，
 * 只是把「对照」面板换成了阅读页工具栏上的双栏模式切换。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReadingKind } from '../hooks/useReadings';
import { parseExperimentEntries, useReadings } from '../hooks/useReadings';
import type { AIStatus } from '../api/client';
import { api } from '../api/client';
import { useChat } from '../hooks/useChat';
import type { useAnnotations } from '../hooks/useAnnotations';
import type { DocumentSummary } from '@cbct/shared';
import { ResearchNotesBlock, DetailedResultsBlock, ReproductionNotesBlock } from './DeepReadingBlocks';
import { ReproductionSection } from './ReproductionSection';
import type { ParagraphQuestion } from './ParagraphActions';

export type AssistantTab = 'chat' | 'reading' | 'notes';

const ASSISTANT_TABS: { id: AssistantTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'reading', label: '精读' },
  { id: 'notes', label: '批注' },
];

/** 助读面板：tab 条 + 面板本体。AI 状态由这里自取（与旧 SideColumn 相同）。 */
export function AssistantSidebar({
  apiKey,
  onCite,
  annotations,
  onFocusAnnotation,
  tab,
  onTabChange,
  format = 'pdf',
  paragraphQuestion,
  document,
}: {
  apiKey: string | null;
  onCite: (page: number) => void;
  annotations: ReturnType<typeof useAnnotations>;
  onFocusAnnotation: (id: string, page: number | null) => void;
  tab: AssistantTab;
  onTabChange: (tab: AssistantTab) => void;
  format?: 'pdf' | 'epub';
  document?: DocumentSummary | null;
  paragraphQuestion?: ParagraphQuestion | null;
}) {
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [quote, setQuote] = useState('');
  useEffect(() => {
    const accept = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; text: string }>)
        .detail;
      if (detail.key === apiKey) setQuote(detail.text);
    };
    window.addEventListener('cbct-quote', accept);
    return () => window.removeEventListener('cbct-quote', accept);
  }, [apiKey]);

  useEffect(() => {
    const controller = new AbortController();
    const reload = () =>
      api
        .aiStatus(controller.signal)
        .then(setStatus)
        .catch(() =>
          setStatus({ configured: false, error: '读取 AI 配置状态失败' }),
        );
    void reload();
    window.addEventListener('cbct-ai-settings', reload);
    return () => {
      controller.abort();
      window.removeEventListener('cbct-ai-settings', reload);
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div
        className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2"
        style={{ height: 48 }}
      >
        {ASSISTANT_TABS.filter(
          (item) => format !== 'epub' || item.id !== 'reading',
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onTabChange(item.id)}
            aria-current={item.id === tab ? 'true' : undefined}
            className={[
              'rounded-pill px-2.5 py-1 text-[11px] transition',
              item.id === tab
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
        <span className="ml-auto pr-1 text-[10px] text-ink-faint">
          {status?.configured ? status.model || status.provider : '未配置'}
        </span>
      </div>

      {status && !status.configured ? (
        <p className="border-b border-line bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
          {status.error ?? '未配置 API Key'}
          ——对话与精读生成暂不可用，其余功能不受影响。
        </p>
      ) : null}

      <div
        className={tab === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        <ChatPane
          apiKey={apiKey}
          onCite={onCite}
          disabled={!status?.configured}
          quote={quote}
          paragraphQuestion={paragraphQuestion}
        />
      </div>
      {format !== 'epub' && <div className={tab === 'reading' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ReadingPane
          document={document}
          apiKey={apiKey}
          onCite={onCite}
          disabled={!status?.configured}
        />
      </div>}
      {tab === 'notes' ? (
        <NotesPane
          apiKey={apiKey}
          state={annotations}
          onFocus={onFocusAnnotation}
          onCite={onCite}
        />
      ) : null}
    </div>
  );
}

function ChatPane({
  apiKey,
  onCite,
  disabled,
  quote,
  paragraphQuestion,
}: {
  apiKey: string | null;
  onCite: (page: number) => void;
  disabled: boolean;
  quote: string;
  paragraphQuestion?: ParagraphQuestion | null;
}) {
  const { turns, busy, send, stop } = useChat(apiKey);
  const [draft, setDraft] = useState('');
  const [paragraph, setParagraph] = useState<ParagraphQuestion | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!paragraphQuestion) return;
    setParagraph(paragraphQuestion);
    input.current?.focus();
  }, [paragraphQuestion]);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (quote) { setDraft(quote); setParagraph(null); }
  }, [quote]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);

  const submit = () => {
    if (busy || !apiKey || disabled) return;
    let question = draft.trim();
    if (paragraph) {
      question = `请围绕以下原文段落回答，区分原文依据与解释推断。\n出处：${paragraph.kind === 'pdf' ? 'Page' : 'Chapter'} ${paragraph.position}\n原文段落：\n${paragraph.text}\n\n问题：${question || '这一段在讲什么？请解释关键概念及其与上下文的关系。'}`;
    }
    if (!question) return;
    setDraft('');
    void send(question);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {turns.length === 0 ? (
          <p className="pt-6 text-center text-[13px] leading-relaxed text-ink-soft">
            {apiKey
              ? '就这篇文档提问。回答里的出处可点击跳到原文。'
              : '先选一篇文档。'}
          </p>
        ) : null}
        {turns.map((turn, index) => (
          <div
            key={index}
            className={turn.role === 'user' ? 'flex justify-end' : 'flex'}
          >
            <div
              className={[
                'max-w-[88%] rounded-card px-3 py-2 text-[13px] leading-relaxed',
                turn.role === 'user'
                  ? 'bg-accent-soft text-ink'
                  : 'card-surface',
              ].join(' ')}
            >
              {turn.scope && turn.scope.included < turn.scope.total ? (
                <p className="mb-1 text-[11px] text-ink-faint">
                  材料为相关 {turn.scope.included}/{turn.scope.total}{' '}
                  {turn.scope.unit ?? '页'}
                </p>
              ) : null}
              <p className="whitespace-pre-wrap">
                <CitedText text={turn.text} onCite={onCite} />
              </p>
              {turn.error ? (
                <p className="mt-1.5 text-[12px] leading-relaxed text-bad">
                  {turn.error}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {paragraph && <div className="chat-paragraph-context" aria-label="提问段落">
        <div><strong>{paragraph.kind === 'pdf' ? 'Page' : 'Chapter'} {paragraph.position} · 已选段落</strong>
          <button onClick={() => setParagraph(null)} aria-label="清除提问段落">×</button></div>
        <p>{paragraph.text}</p>
      </div>}
      <div className="flex items-end gap-2 border-t border-line p-3">
        <textarea
          ref={input}
          aria-label="AI 提问"
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
          placeholder={
            !apiKey ? '先选一篇论文' : disabled ? 'API 未配置' : paragraph ? '输入关于此段的问题，或直接发送以解释此段…' : '提问这篇论文…'
          }
          className="flex-1 resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-lg border border-line px-3 py-2 text-[13px] text-ink-soft"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!apiKey || disabled || (!draft.trim() && !paragraph)}
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
function CitedText({
  text,
  onCite,
}: {
  text: string;
  onCite: (page: number) => void;
}) {
  const parts: React.ReactNode[] = [];
  const pattern = /\b(Page|Chapter)\s+(\d+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const page = Number(match[2]);
    parts.push(
      <button
        key={`${page}-${match.index}`}
        type="button"
        onClick={() => onCite(page)}
        className="mx-0.5 rounded-pill bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent hover:text-surface"
      >
        {match[1]} {page}
      </button>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const READING_STEPS: { kind: ReadingKind; label: string }[] = [
  { kind: 'motivation', label: '实验动机' }, { kind: 'method', label: '方法公式' },
  { kind: 'experiment', label: '实验配置' }, { kind: 'results', label: '结果分析' },
  { kind: 'reproduction', label: '代码复现' },
];
function ReadingPane({ apiKey, onCite, disabled, document }: {
  apiKey: string | null; onCite: (page: number) => void; disabled: boolean; document?: DocumentSummary | null;
}) {
  const { entries, loading, error, generating, generate } = useReadings(apiKey);
  const [active, setActive] = useState<ReadingKind>('motivation');
  const [revision, setRevision] = useState(0);
  const [saveError, setSaveError] = useState('');
  const entry = entries[active];
  const label = READING_STEPS.find((step) => step.kind === active)!.label;
  const saveChecklist = async () => {
    if (!apiKey || !entry) return;
    try { await api.analyzeReproduction(apiKey, entry.value); setRevision((value) => value + 1); setSaveError(''); }
    catch (cause) { setSaveError(String(cause)); }
  };
  return <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="五重奏精读">
    <div className="reading-steps" role="tablist" aria-label="精读步骤">{READING_STEPS.map((step, index) => <button key={step.kind} role="tab" aria-selected={active === step.kind} onClick={() => setActive(step.kind)}>{index + 1}. {step.label}</button>)}</div>
    <div className="reading-generate"><strong>{label}</strong><button disabled={!apiKey || disabled || generating !== null} onClick={() => void generate(active)}>{generating === active ? '生成中…' : `${entry ? '重新生成' : '生成'}${label}`}</button></div>
    {loading && <p>读取精读产物…</p>}
    {error && <p role="alert" className="text-bad">{error}</p>}
    {!loading && !entry && <p className="text-[13px] text-ink-soft">尚无{label}记录。生成后自动保存，可点击页码回到原文核对。</p>}
    {entry && (active === 'motivation' || active === 'method') && <ResearchNotesBlock entry={entry} onCite={onCite} />}
    {entry && active === 'experiment' && <ExperimentBlock entry={entry} onCite={onCite} />}
    {entry && active === 'results' && <DetailedResultsBlock entry={entry} onCite={onCite} />}
    {active === 'reproduction' && <>
      {entry && <><ReproductionNotesBlock entry={entry} onCite={onCite} /><button className="reading-save-checklist" disabled={!!entry.validationError} onClick={() => void saveChecklist()}>保存为复现核对清单</button></>}
      {saveError && <p role="alert" className="text-bad">{saveError}</p>}
      {document && <ReproductionSection document={document} documents={[document]} onPick={() => undefined} refreshToken={revision} />}
    </>}
  </div>;
}

function ExperimentBlock({
  entry,
  onCite,
}: {
  entry: import('../api/client').ReadingEntry;
  onCite: (page: number) => void;
}) {
  const groups = parseExperimentEntries(entry.value);
  if (!groups) {
    return (
      <section>
        <h3 className="mb-1 text-[13px] font-semibold">实验配置</h3>
        <pre className="overflow-x-auto rounded-lg bg-surface-sunk p-2 text-[11px]">
          {entry.value.slice(0, 400)}
        </pre>
      </section>
    );
  }
  return (
    <section>
      <h3 className="mb-1 text-[13px] font-semibold">实验配置</h3>
      <div className="space-y-2">
        {groups
          .filter((group) => group.fields.length)
          .map((group) => (
            <div
              key={group.group}
              className="rounded-lg border border-line px-2.5 py-2"
            >
              <p className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {group.group}
              </p>
              <dl className="mt-1 space-y-1">
                {group.fields.map((field, index) => (
                  <div
                    key={`${field.k}-${index}`}
                    className="flex gap-2 text-[12px] leading-snug"
                  >
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

const KIND_LABEL: Record<string, string> = {
  highlight: '高亮',
  underline: '下划线',
  question: '问题',
};

const COLOR_LABEL: Record<string, string> = {
  amber: '琥珀',
  rose: '玫红',
  sky: '天蓝',
  green: '青绿',
  violet: '紫罗兰',
};

const COLOR_DOT: Record<string, string> = {
  amber: '#d99a2b',
  rose: '#e0756b',
  sky: '#5b9fe8',
  green: '#5aa877',
  violet: '#9b7fd4',
};

const COLOR_CHOICES = ['amber', 'rose', 'sky', 'green', 'violet'] as const;

const NOTE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'highlight', label: '高亮' },
  { id: 'underline', label: '下划线' },
  { id: 'question', label: '问题' },
] as const;

type NoteFilterId = (typeof NOTE_FILTERS)[number]['id'];

/**
 * 批注面板：列表 + 筛选 + 就地编辑/改色/删除 + 导出 Markdown。
 *
 * 批注是用户自己的笔记，任何一步失败都要如实显示（不能静默吞掉）——
 * 所以每条卡片的写操作都带 pending 状态，失败把错误挂在卡片上。
 */
function NotesPane({
  apiKey,
  state,
  onFocus,
  onCite,
}: {
  apiKey: string | null;
  state: ReturnType<typeof useAnnotations>;
  onFocus: (id: string, page: number | null) => void;
  onCite: (page: number) => void;
}) {
  const [filter, setFilter] = useState<NoteFilterId>('all');
  const [color, setColor] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setQuery(''), [apiKey]);

  const items = state.items;
  const colors = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) if (item.color) seen.add(item.color);
    return seen.size > 1 ? [...seen] : [];
  }, [items]);
  const activeColor = colors.includes(color) ? color : '';

  const counts = useMemo(() => {
    const out: Record<string, number> = {
      all: items.length,
      highlight: 0,
      underline: 0,
      question: 0,
    };
    for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
    return out;
  }, [items]);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          (filter === 'all' || item.kind === filter) &&
          (!activeColor || item.color === activeColor) &&
          (!needle ||
            `${item.quote} ${item.note} ${item.tags.join(' ')}`
              .toLocaleLowerCase()
              .includes(needle)),
      ),
    [items, filter, activeColor, needle],
  );

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setRowError(null);
    try {
      await action();
    } catch (cause) {
      setRowError({
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  };

  const saveNote = (id: string) =>
    run(id, async () => {
      await state.update(id, { note: draft });
      setEditing(null);
    });

  const exportMarkdown = async () => {
    if (!apiKey) return;
    setNotice(null);
    try {
      const filename = await api.exportAnnotations(apiKey);
      setNotice(`已导出 ${filename}`);
    } catch (cause) {
      setNotice(
        `导出失败：${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  };

  if (!apiKey) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p className="max-w-[26ch] text-center text-[13px] leading-relaxed text-ink-soft">
          先在左侧选一篇论文。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索批注内容"
          placeholder="搜索批注内容"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void exportMarkdown()}
          disabled={!items.length}
          title={items.length ? '导出为 Markdown' : '还没有批注可导出'}
          className="shrink-0 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft shadow-sm transition hover:border-accent hover:text-accent disabled:opacity-40"
        >
          导出
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {NOTE_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            aria-pressed={filter === item.id}
            className={[
              'rounded-pill px-2 py-0.5 text-[11px] transition',
              filter === item.id
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
            {item.id !== 'all' && counts[item.id] ? (
              <span className="ml-1 text-ink-faint">{counts[item.id]}</span>
            ) : null}
          </button>
        ))}
        {colors.length ? (
          <>
            <span className="mx-1 h-3.5 w-px bg-line" />
            {colors.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setColor(activeColor === value ? '' : value)}
                aria-label={`只看${COLOR_LABEL[value] ?? value}`}
                title={COLOR_LABEL[value] ?? value}
                className={`flex h-5 w-5 items-center justify-center rounded-pill border transition ${
                  activeColor === value ? 'border-accent' : 'border-transparent'
                }`}
              >
                <span
                  className="ann-color-dot"
                  style={{ background: COLOR_DOT[value] ?? value }}
                />
              </button>
            ))}
          </>
        ) : null}
      </div>

      {notice ? (
        <p className="border-b border-line bg-surface-sunk px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
          {notice}
        </p>
      ) : null}
      {state.error ? (
        <p className="border-b border-line bg-bad/10 px-3 py-2 text-[12px] leading-relaxed text-bad">
          {state.error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {state.loading ? (
          <p className="text-[13px] text-ink-soft">读取批注…</p>
        ) : null}
        {!state.loading && !items.length ? (
          <div className="pt-6 text-center">
            <p className="text-[13px] leading-relaxed text-ink-soft">
              还没有批注
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-faint">
              在中栏选中原文，即可加高亮、下划线或提问批注。
            </p>
          </div>
        ) : null}
        {!state.loading && items.length > 0 && !visible.length ? (
          <p className="pt-6 text-center text-[13px] text-ink-soft">
            {needle ? '没有匹配的批注' : '没有这类批注'}
          </p>
        ) : null}

        {visible.map((item) => {
          const isEditing = editing === item.id;
          const isBusy = busy === item.id;
          return (
            <article
              key={item.id}
              className="rounded-lg border border-line bg-surface px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`rounded-pill px-1.5 py-0.5 text-[10px] font-medium ann-${item.kind}-${item.color}`}
                >
                  {KIND_LABEL[item.kind] ?? item.kind}
                </span>
                {item.page != null ? (
                  <button
                    type="button"
                    onClick={() => onCite(item.page as number)}
                    className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] tabular-nums text-ink-soft hover:bg-accent-soft hover:text-accent"
                  >
                    P{item.page}
                  </button>
                ) : (
                  <span className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-faint">
                    {item.locator?.kind === 'epub' ? '章节批注' : '未归页'}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {COLOR_CHOICES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      disabled={isBusy || value === item.color}
                      onClick={() =>
                        void run(item.id, () =>
                          state.update(item.id, { color: value }),
                        )
                      }
                      aria-label={`改为${COLOR_LABEL[value]}色`}
                      title={COLOR_LABEL[value]}
                      className={`ann-color-choice${value === item.color ? ' ann-color-current' : ''}`}
                    >
                      <span
                        className="ann-color-dot"
                        style={{ background: COLOR_DOT[value] }}
                      />
                    </button>
                  ))}
                </span>
              </div>

              <button
                type="button"
                onClick={() => onFocus(item.id, item.page)}
                className="mt-1.5 block w-full text-left text-[12px] leading-snug text-ink-soft hover:text-ink"
                title="跳到正文对应位置"
              >
                <span
                  className={`ann-${item.kind}-${item.color} inline rounded-[3px] px-0.5`}
                >
                  {item.quote.length > 120
                    ? `${item.quote.slice(0, 120)}…`
                    : item.quote}
                </span>
              </button>

              {item.tags.length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {item.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-faint"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {isEditing ? (
                <div className="mt-1.5">
                  <textarea
                    autoFocus
                    rows={3}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    aria-label="批注内容"
                    className="w-full resize-none rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] focus:border-accent focus:outline-none"
                  />
                  <div className="mt-1 flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="rounded-md px-2 py-1 text-[11px] text-ink-faint"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void saveNote(item.id)}
                      className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-surface disabled:opacity-40"
                    >
                      {isBusy ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-1.5 flex items-start gap-1.5">
                  <p className="min-w-0 flex-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink">
                    {item.note || (
                      <span className="text-ink-faint">（无批注正文）</span>
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(item.note);
                      setEditing(item.id);
                    }}
                    className="shrink-0 text-[11px] text-ink-faint hover:text-accent"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() =>
                      void run(item.id, () => state.remove(item.id))
                    }
                    className="shrink-0 text-[11px] text-ink-faint hover:text-bad disabled:opacity-40"
                  >
                    删除
                  </button>
                </div>
              )}

              {rowError?.id === item.id ? (
                <p className="mt-1 text-[11px] leading-relaxed text-bad">
                  {rowError.message}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
