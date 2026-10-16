import { useCallback, useEffect, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import type { ReproductionChecklist, ReproductionItem, RepoCheck } from '../api/client';
import { api } from '../api/client';

const GROUPS: { id: keyof ReproductionAnalysis; label: string }[] = [
  { id: 'resources', label: '资源 · 数据 / 代码 / 权重' },
  { id: 'environment', label: '环境 · 依赖 / 特殊算子' },
  { id: 'cost', label: '训练成本 · 时间 / 显存' },
  { id: 'missing', label: '关键缺失 · 几何 / 预处理 / 参数' },
  { id: 'risks', label: '风险 · 实现 / 评测协议' },
];

type ReproductionAnalysis = {
  resources: ReproductionItem[];
  environment: ReproductionItem[];
  cost: ReproductionItem[];
  missing: ReproductionItem[];
  risks: ReproductionItem[];
};

const TASK_STATUSES = [
  { id: 'todo', label: '待核对' },
  { id: 'verified', label: '已核对' },
  { id: 'blocked', label: '受阻' },
];

const TASK_TONE: Record<string, string> = {
  todo: 'bg-surface-sunk text-ink-soft',
  verified: 'bg-good/10 text-good',
  blocked: 'bg-warn/10 text-warn',
};

/** 核对项 id 与 v1 一致：`字段标题|页码或 unknown`——同一分析里字段+页码唯一。 */
function itemID(item: ReproductionItem): string {
  return `${item.finding.k}|${item.finding.page ?? 'unknown'}`;
}

/**
 * 复现任务板。逐条对应旧版 ReproductionPanel：
 *   1. 粘贴 AI 产出的复现分析 JSON → 服务端校验（每组 1–4 项、字段不空白、引用页码真实存在、finding 有证据）
 *      → 按内容指纹归档；新分析不继承旧核对结果；
 *   2. 每个核对项可切 待核对/已核对/受阻 并写备注；
 *   3. R-11 仓库依赖核对：粘贴代码快照（路径 + 逐行文本）跑规则扫描，得到依赖/数据/权重核对项——
 *      纯规则，不执行仓库代码、不发网络请求。
 *
 * 未知项（page=null）仍必须给出核对行动，且「未知」不冒充「已确认」——界面上单独标徽章。
 */
export function ReproductionSection({
  document,
  documents,
  onPick,
  onBack,
  refreshToken = 0,
}: {
  document: DocumentSummary | null;
  documents: DocumentSummary[];
  onPick: (key: string) => void;
  onBack?: () => void;
  refreshToken?: number;
}) {
  const key = document?.key ?? null;
  const [checklist, setChecklist] = useState<ReproductionChecklist | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState('');
  const [repoChecks, setRepoChecks] = useState<RepoCheck[]>([]);

  const load = useCallback(async () => {
    if (!key) {
      setChecklist(null);
      return;
    }
    try {
      const response = await api.reproduction(key);
      setChecklist(response.checklist);
      const revisions = Object.keys(response.checklist.revisions);
      setRevision(revisions.length ? (revisions[revisions.length - 1] ?? null) : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [key]);

  useEffect(() => {
    setRepoChecks([]);
    setSnapshot('');
    setMessage(null);
    void load();
  }, [load]);
  useEffect(() => { if (refreshToken > 0) void load(); }, [refreshToken, load]);

  const analyze = async () => {
    if (!key || !raw.trim()) {
      setMessage('请先粘贴复现分析 JSON');
      return;
    }
    setBusy(true);
    setMessage('校验中…');
    try {
      const result = await api.analyzeReproduction(key, raw.trim());
      setMessage(`已保存 · 分析版本 ${result.revision.slice(0, 12)} · 共 ${result.groups.reduce((sum, group) => sum + group.count, 0)} 项，其中 ${result.unknownCount} 项未知`);
      setRaw('');
      await load();
    } catch (cause) {
      setMessage(`未保存：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const setTask = async (itemId: string, patch: { status?: string; note?: string }) => {
    if (!key || !revision) return;
    try {
      const { task } = await api.setReproductionTask(key, { revision, itemId, ...patch });
      setChecklist((current) => {
        if (!current) return current;
        const tasks = { ...(current.revisions[revision] ?? {}), [itemId]: task };
        return {
          ...current,
          revisions: { ...current.revisions, [revision]: tasks },
        };
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const scanRepo = async () => {
    setMessage(null);
    try {
      const files = parseSnapshot(snapshot);
      if (!files.length) {
        setMessage('代码快照格式不正确：每行 `路径` 起一段，其后缩进行为该文件内容。');
        return;
      }
      const result = await api.repoChecks(files);
      setRepoChecks(result.checks);
      setMessage(`仓库核对：识别出 ${result.checks.length} 项（仅提示，需人工确认）。`);
    } catch (cause) {
      setMessage(`扫描失败：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  if (!document) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="card-surface max-w-md rounded-card px-6 py-7 text-center">
          <p className="text-[15px] font-semibold">先选一篇论文</p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">复现准备是按论文进行的：从下面的列表选一篇，或回论文库点「复现」。</p>
          <div className="mt-4 flex max-h-60 flex-col gap-1 overflow-y-auto text-left">
            {documents.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => onPick(doc.key)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-left text-[12px] transition hover:border-accent hover:text-accent"
              >
                {doc.title || doc.key}
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }

  const analysis = revision && checklist?.analyses[revision] ? checklist.analyses[revision] : null;
  const tasks = revision ? (checklist?.revisions[revision] ?? {}) : {};
  const allItems = analysis ? GROUPS.flatMap((group) => (analysis[group.id] ?? [])) : [];
  const unknownCount = allItems.filter((item) => item.finding.page == null).length;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
        <section className="card-surface rounded-card px-4 py-3">
          <div className="flex items-center gap-2">
            {onBack ? (
              <button type="button" onClick={onBack} className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-soft hover:text-ink">
                ← 书库
              </button>
            ) : null}
            <h2 className="text-[15px] font-semibold">复现准备</h2>
            <span className="truncate text-[12px] text-ink-faint">
              {document.title}
              {revision ? ` · 分析版本 ${revision.slice(0, 12)}` : ''}
            </span>
          </div>
          {error ? <p className="mt-2 text-[12px] leading-relaxed text-bad">{error}</p> : null}
          <label className="mt-2 block">
            <span className="mb-1 block text-[12px] text-ink-soft">粘贴复现分析 JSON（由 AI 产出）</span>
            <textarea
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              rows={4}
              placeholder='{"resources":[...],"environment":[...],"cost":[...],"missing":[...],"risks":[...]}'
              className="w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-[11px] focus:border-accent focus:outline-none"
            />
          </label>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void analyze()}
              disabled={busy}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-surface shadow-sm transition hover:brightness-105 disabled:opacity-40"
            >
              {busy ? '校验中…' : '校验并保存'}
            </button>
            {message ? <span className="text-[12px] leading-relaxed text-ink-soft">{message}</span> : null}
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
            校验要求：每组 1–4 项、标题不重复、字段/分析/核对行动都不为空；「论文原文」字段必须有页码与逐字摘录；
            分析与行动里引用的 Page N 必须真实存在。未知项（page: null）仍必须给出核对行动。
          </p>
        </section>

        {analysis ? (
          <section className="card-surface rounded-card px-4 py-3">
            <p className="text-[12px] text-ink-soft">
              共 {allItems.length} 项，其中 {unknownCount} 项为未知（需人工核对）。未知不计入「已确认」。
            </p>
            <div className="mt-2 space-y-3">
              {GROUPS.map((group) => {
                const items = analysis[group.id] ?? [];
                if (!items.length) return null;
                return (
                  <div key={group.id}>
                    <h3 className="mb-1.5 text-[12px] font-semibold text-ink-soft">{group.label}</h3>
                    <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                      {items.map((item) => {
                        const id = itemID(item);
                        const task = tasks[id] ?? { status: 'todo', note: '', updatedAt: '' };
                        const unknown = item.finding.page == null;
                        return (
                          <article key={id} className="rounded-lg border border-line bg-surface px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-medium">{item.finding.k}</span>
                              {unknown ? (
                                <span className="rounded-pill bg-warn/10 px-1.5 py-0.5 text-[10px] text-warn">未知</span>
                              ) : null}
                              <span className="ml-auto flex items-center gap-0.5">
                                {TASK_STATUSES.map((status) => (
                                  <button
                                    key={status.id}
                                    type="button"
                                    onClick={() => void setTask(id, { status: status.id })}
                                    className={[
                                      'rounded-pill px-1.5 py-0.5 text-[10px] transition',
                                      task.status === status.id
                                        ? `${TASK_TONE[status.id]} font-medium`
                                        : 'text-ink-faint hover:text-ink',
                                    ].join(' ')}
                                  >
                                    {status.label}
                                  </button>
                                ))}
                              </span>
                            </div>
                            <p className="mt-1 text-[12px] leading-relaxed text-ink">{item.assessment}</p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">核对行动：{item.action}</p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                              {item.finding.page != null
                                ? `原文：Page ${item.finding.page} · ${item.finding.excerpt ?? ''}`
                                : '原文：论文未说明（保持未知，不补造）'}
                            </p>
                            <input
                              defaultValue={task.note}
                              placeholder="核对备注"
                              onBlur={(event) => void setTask(id, { note: event.target.value })}
                              className="mt-1 w-full rounded-md border border-line bg-surface-sunk px-2 py-1 text-[11px] focus:border-accent focus:outline-none"
                            />
                          </article>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="card-surface rounded-card px-4 py-6 text-center">
            <p className="text-[13px] leading-relaxed text-ink-soft">还没有复现分析。粘贴 AI 产出的 JSON 后点「校验并保存」。</p>
          </section>
        )}

        <section className="card-surface rounded-card px-4 py-3">
          <h3 className="text-[13px] font-semibold">仓库依赖核对（R-11）</h3>
          <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
            粘贴代码快照：每行一个文件路径，其后缩进行为该文件内容（也可只贴依赖文件）。
            扫描只做规则匹配——不执行仓库代码、不发网络请求，结果仅作核对提示。
          </p>
          <textarea
            value={snapshot}
            onChange={(event) => setSnapshot(event.target.value)}
            rows={4}
            placeholder={'requirements.txt\n  torch==2.0\nsrc/train.py\n  # download data from https://drive.google.com/...'}
            className="mt-1.5 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-2 font-mono text-[11px] focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void scanRepo()}
            className="mt-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink-soft shadow-sm transition hover:border-accent hover:text-accent"
          >
            扫描仓库核对项
          </button>
          {repoChecks.length ? (
            <ul className="mt-2 space-y-1.5">
              {repoChecks.map((check) => (
                <li key={check.id} className="rounded-lg border border-line px-2.5 py-1.5 text-[11px] leading-relaxed">
                  <span className="mr-1.5 rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft">{check.kind}</span>
                  <span className="font-mono text-ink-soft">{check.path}{check.line != null ? `:${check.line}` : ''}</span>
                  <span className="ml-1.5 text-ink-faint">{check.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </main>
  );
}

/**
 * 解析代码快照文本：不缩进的非空行是文件路径，紧接的缩进行是它的内容。
 * 这让用户能直接把 `tree`/`cat` 的输出粘进来，而不必手写 JSON。
 */
function parseSnapshot(text: string): { path: string; lines: string[] }[] {
  const files: { path: string; lines: string[] }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const rawLine of text.split('\n')) {
    if (!rawLine.trim()) continue;
    const indented = /^\s/.test(rawLine);
    if (!indented) {
      current = { path: rawLine.trim(), lines: [] };
      files.push(current);
    } else if (current) {
      current.lines.push(rawLine.replace(/^\s+/, ''));
    }
  }
  return files;
}
