import { useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';

const TABS = [
  { id: 'chat', label: '对话', stage: 'S3', note: 'SSE 流式对话：读论文时随手问，回答带页码出处。' },
  { id: 'reading', label: '精读', stage: 'S2', note: '四步精读产物：定位、实验、结果、可迁移点，字段级证据校验。' },
  { id: 'notes', label: '批注', stage: 'S4', note: '选区高亮与问题批注，可导出 Markdown。' },
  { id: 'bilingual', label: '对照', stage: 'S5', note: '段落级双语对照，译文单独标注、不参与证据校验。' },
] as const;

type TabId = (typeof TABS)[number]['id'];

interface Props {
  selected: DocumentSummary | null;
}

/** 右栏：对话与精读面板的容器。S0 只搭标签与阶段说明，避免半成品交互误导使用者。 */
export function SideColumn({ selected }: Props) {
  const [tab, setTab] = useState<TabId>('chat');
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <aside className="card-surface flex h-full min-h-0 w-full flex-col overflow-hidden rounded-card">
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-current={item.id === tab ? 'true' : undefined}
            className={[
              'rounded-pill px-2.5 py-1 text-[12px] transition',
              item.id === tab ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:text-ink',
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="rounded-lg bg-surface-sunk px-3 py-2 text-[12px] leading-relaxed text-ink-soft">
          <span className="font-medium text-ink">{active.stage}</span>
          <span className="mx-1.5 text-line-strong">·</span>
          {active.note}
        </div>

        {selected ? (
          <div className="rounded-lg border border-line px-3 py-2">
            <p className="text-[12px] font-medium text-ink-soft">当前论文</p>
            <p className="mt-1 line-clamp-3 text-[13px] leading-snug">{selected.title || '（无标题）'}</p>
            {selected.pdfPath ? (
              <p className="mt-1.5 break-all text-[11px] text-ink-faint">{selected.pdfPath}</p>
            ) : (
              <p className="mt-1.5 text-[11px] text-ink-faint">未关联 PDF</p>
            )}
          </div>
        ) : (
          <p className="text-[13px] leading-relaxed text-ink-soft">未选择论文时右栏不可操作，避免对话上下文与论文错位。</p>
        )}

        <div className="mt-auto flex items-end gap-2">
          <textarea
            readOnly
            rows={2}
            placeholder={selected ? '提问区在 S3 开放' : '先选一篇论文'}
            className="flex-1 resize-none rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none"
          />
          <button
            type="button"
            disabled
            className="rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-surface shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </aside>
  );
}
