import { useEffect, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { collapseInlineWhitespace, paragraphizePage, splitParagraphs, statusLabel } from '@cbct/shared';
import type { DocumentPhase } from '../hooks/useDocument';
import { usePageText } from '../hooks/useDocument';
import type { WorkspacePhase } from '../hooks/useWorkspace';

interface Props {
  phase: WorkspacePhase;
  detail: DocumentPhase;
  selected: DocumentSummary | null;
  /** 右栏点了 (Page N)：中栏跳到该页并闪一下，让「出处 → 原文」闭环可见。 */
  focus: { page: number; nonce: number } | null;
}

/** 中栏：正文容器。S1 先接旧版逐页缓存（文本层），pdf.js 视图在同一块区域继续挂。 */
export function BodyColumn({ phase, detail, selected, focus }: Props) {
  const meta = phase.kind === 'ready' ? phase.meta : null;
  const pages = detail.kind === 'ready' ? detail.detail.pages : [];
  const [page, setPage] = useState<number | null>(null);

  useEffect(() => {
    if (!pages.length) {
      setPage(null);
      return;
    }
    const first = pages[0];
    if (first) setPage(first.page);
  }, [pages]);

  const body = usePageText(selected?.key ?? null, page);
  const [flashing, setFlashing] = useState(false);

  // 右栏点 (Page N) / P N 芯片：跳页并闪 1.2s。nonce 让「重复点同一页」也能重新触发。
  useEffect(() => {
    if (!focus) return;
    const available = pages.some((item) => item.page === focus.page);
    setPage(available ? focus.page : (pages[0]?.page ?? null));
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 1200);
    return () => clearTimeout(timer);
  }, [focus?.nonce, focus?.page, pages]);

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
        <Toolbar
          pages={pages.map((item) => item.page)}
          page={page}
          onStep={(delta) => setPage((current) => step(pages.map((item) => item.page), current, delta))}
          disabled={!pages.length}
        />
        <div className={`min-h-0 flex-1 overflow-y-auto${flashing ? ' cite-flash' : ''}`}>
          <Body body={body} detail={detail} hasSelection={Boolean(selected)} onPage={(value) => setPage(value)} />
        </div>
      </div>
    </section>
  );
}

function step(pages: number[], current: number | null, delta: number): number | null {
  if (!pages.length || current == null) return current;
  const index = pages.indexOf(current);
  const next = pages[Math.min(Math.max(index + delta, 0), pages.length - 1)];
  return next ?? current;
}

function Toolbar({
  pages,
  page,
  onStep,
  disabled,
}: {
  pages: number[];
  page: number | null;
  onStep: (delta: number) => void;
  disabled: boolean;
}) {
  const index = page == null ? -1 : pages.indexOf(page);
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2">
      <span className="rounded-pill bg-surface-sunk px-2.5 py-1 text-[12px] font-medium text-ink-soft">文本层</span>
      <span className="mx-1 h-4 w-px bg-line" />
      <GhostButton disabled={disabled || index <= 0} onClick={() => onStep(-1)}>
        上一页
      </GhostButton>
      <span className="rounded-md bg-surface-sunk px-2 py-1 text-[12px] tabular-nums text-ink-soft">
        {page ?? '—'} / {pages.length || '—'}
      </span>
      <GhostButton disabled={disabled || index < 0 || index >= pages.length - 1} onClick={() => onStep(1)}>
        下一页
      </GhostButton>
      {pages.length ? (
        <span className="ml-auto text-[11px] text-ink-faint">共 {pages.length} 页有正文缓存</span>
      ) : null}
    </div>
  );
}

function GhostButton({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) {
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

function Body({
  body,
  detail,
  hasSelection,
  onPage,
}: {
  body: ReturnType<typeof usePageText>;
  detail: DocumentPhase;
  hasSelection: boolean;
  onPage: (page: number) => void;
}) {
  if (!hasSelection) return <Centered title="从左侧选一篇论文开始" note="三栏工作区：左栏论文库、中栏原文、右栏对话与精读产物。" />;
  if (detail.kind === 'loading') return <Centered title="载入论文信息…" />;
  if (detail.kind === 'error') return <Centered title="读取失败" note={detail.message} />;

  const fromOcr = detail.kind === 'ready' && detail.detail.fromOcr;
  const pages = detail.kind === 'ready' ? detail.detail.pages : [];

  if (!pages.length) {
    return (
      <Centered
        title="这篇还没有正文缓存"
        note="旧版里读过的论文会自动带过来；没读过的论文要在 S1 后半段用内置 pdf.js 抽取正文后才会出现文本层。"
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-[72ch] flex-col gap-4 px-6 py-6">
      {fromOcr ? (
        <p className="rounded-lg bg-warn/10 px-3 py-2 text-[12px] leading-relaxed text-warn">
          该论文的全文来自 OCR 识别，摘录校验可能失效，引用前请人工核对原文页。
        </p>
      ) : null}
      {body.kind === 'loading' ? <Centered title="读取正文…" /> : null}
      {body.kind === 'error' ? <Centered title="正文读取失败" note={body.message} /> : null}
      {body.kind === 'missing' ? <Centered title="这一页还没有正文" /> : null}
      {body.kind === 'ready' ? (
        <>
          {pages.length > 1 ? (
            <nav className="flex flex-wrap gap-1">
              {pages.map((item) => (
                <button
                  key={item.page}
                  type="button"
                  onClick={() => onPage(item.page)}
                  className="rounded-pill border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-soft transition hover:border-accent hover:text-accent"
                >
                  Page {item.page}
                </button>
              ))}
            </nav>
          ) : null}
          <article className="text-pane">
            {splitParagraphs(paragraphizePage(body.text)).map((block, index) =>
              block.kind === 'page' ? (
                <p key={`page-${index}`} className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                  Page {block.page}
                </p>
              ) : (
                <p key={`p-${index}`}>{collapseInlineWhitespace(block.text)}</p>
              ),
            )}
          </article>
        </>
      ) : null}
    </div>
  );
}

function Centered({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        <p className="text-[15px] font-medium">{title}</p>
        {note ? <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{note}</p> : null}
      </div>
    </div>
  );
}
