import type { DocumentSummary } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import type { WorkspacePhase } from '../hooks/useWorkspace';

interface Props {
  phase: WorkspacePhase;
  selected: DocumentSummary | null;
}

/** 中栏：正文容器。S0 只提供骨架与状态，pdf.js 渲染在 S1 接入同一块区域。 */
export function BodyColumn({ phase, selected }: Props) {
  const meta = phase.kind === 'ready' ? phase.meta : null;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="card-surface flex items-center gap-3 rounded-card px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold leading-tight">
            {selected ? selected.title || '（无标题）' : '未选择论文'}
          </h2>
          <p className="mt-0.5 truncate text-[12px] text-ink-faint">
            {selected
              ? `${selected.authors.join('、') || '作者未知'}${selected.year ? ` · ${selected.year}` : ''}${
                  selected.venue ? ` · ${selected.venue}` : ''
                }`
              : meta
                ? `数据根 ${meta.dataRoot}`
                : '等待后端连接'}
          </p>
        </div>
        {selected ? (
          <span className="ml-auto shrink-0 rounded-pill bg-surface-sunk px-2.5 py-1 text-[11px] font-medium text-ink-soft">
            {statusLabel(selected.status)}
          </span>
        ) : null}
      </div>

      <div className="card-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-card">
        <Toolbar hasDocument={Boolean(selected)} />
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          {selected ? <PendingBody /> : <NoSelection />}
        </div>
      </div>
    </section>
  );
}

function Toolbar({ hasDocument }: { hasDocument: boolean }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <Segmented
        options={[
          { id: 'text', label: '文本层' },
          { id: 'pdf', label: 'PDF 原文' },
        ]}
        value="text"
        onChange={() => undefined}
        disabled={!hasDocument}
      />
      <span className="mx-1 h-4 w-px bg-line" />
      <GhostButton disabled={!hasDocument}>上一页</GhostButton>
      <span className="rounded-md bg-surface-sunk px-2 py-1 text-[12px] text-ink-faint">— / —</span>
      <GhostButton disabled={!hasDocument}>下一页</GhostButton>
      <span className="ml-auto flex items-center gap-1">
        <GhostButton disabled={!hasDocument}>缩小</GhostButton>
        <GhostButton disabled={!hasDocument}>放大</GhostButton>
        <GhostButton disabled={!hasDocument}>适应宽度</GhostButton>
      </span>
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
  disabled,
}: {
  options: readonly { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className={`flex items-center gap-1 rounded-pill bg-surface-sunk p-1 ${disabled ? 'opacity-50' : ''}`}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.id)}
          className={[
            'rounded-pill px-2.5 py-1 text-[12px] transition',
            option.id === value ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft',
          ].join(' ')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function GhostButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink-soft transition hover:border-line-strong hover:text-ink disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function PendingBody() {
  return (
    <div className="max-w-md text-center">
      <p className="text-[15px] font-medium">正文尚未接入</p>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
        S1 会在这一块挂载 pdf.js：文本层按页抽取、两端对齐重排、点击摘录跳转到原文页；
        抽取结果按页上传 server 缓存，与旧版 <code className="rounded bg-surface-sunk px-1">library/text</code> 同格式互通。
      </p>
      <p className="stage-note mt-3">当前为 S0 骨架，仅验证前后端连通与三栏布局。</p>
    </div>
  );
}

function NoSelection() {
  return (
    <div className="max-w-md text-center">
      <p className="text-[15px] font-medium">从左侧选一篇论文开始</p>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">
        三栏工作区：左栏论文库、中栏原文、右栏对话与精读产物。摘录证据校验、四层解析兜底会在后端逐步接管。
      </p>
    </div>
  );
}
