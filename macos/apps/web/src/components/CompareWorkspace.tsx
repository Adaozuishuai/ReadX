import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { ReadingField } from '../hooks/useReadings';

/**
 * 跨文献对照：把 2–4 篇论文的「实验配置」精读抽取并排成一张表。
 *
 * 为什么用它而不是新造一套抽取 schema：
 *   库里已经有七个分组（研究对象与数据 / 研究设计与条件 / 实施流程 / 分析方法 /
 *   对照或基线 / 评价标准 / 结果）的抽取，每个字段都带页码与逐字依据，并且由
 *   internal/validate 校验过「论文明说未提及」与「证据必须能在原文里找到」。
 *   再发明一套只会得到两份会互相漂移的数据。
 *
 * 三种状态必须分开显示，这是这张表最容易骗人的地方：
 *   未抽取  —— 这篇还没生成实验配置，表格里不能写成「未提及」；
 *   未提及  —— 抽取结果里明确写了「论文未说明」这类断言；
 *   有内容  —— 给出字段与页码，可点回原文核对。
 */

const GROUPS = [
  { id: 'dataset', label: '研究对象与数据' },
  { id: 'acquisition', label: '研究设计与条件' },
  { id: 'training', label: '实施流程' },
  { id: 'loss', label: '分析方法' },
  { id: 'baselines', label: '对照或基线' },
  { id: 'metrics', label: '评价标准' },
  { id: 'results', label: '结果' },
] as const;

const MAX_PAPERS = 4;

/** 抽取结果里的「明说没有」断言：与后端 UnknownValues 同一批词。 */
const UNKNOWN_VALUES = new Set([
  '当前文本无法核实', '论文未说明', '论文中未说明', '论文中未找到', '未报告', '论文未报告',
  '论文未提及', '未提及', '原文未说明', '文中未提及', '论文中没有说明',
]);

type CardPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; groups: Record<string, ReadingField[]>; updatedAt?: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

function parseExperimentCard(value: string): Record<string, ReadingField[]> | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const out: Record<string, ReadingField[]> = {};
    for (const group of GROUPS) {
      const raw = parsed[group.id];
      if (!Array.isArray(raw)) {
        out[group.id] = [];
        continue;
      }
      out[group.id] = raw.flatMap((item) => {
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
    }
    return out;
  } catch {
    return null;
  }
}

interface Props {
  documents: { id: string; key: string; title: string; year?: number | null }[];
  onBack?: () => void;
  /** 打开某篇的某一页（点单元格里的页码回原文核对）。 */
  onOpenAtPage: (key: string, page: number, query: string) => void;
  onOpenDocument: (id: string) => void;
}

export function CompareWorkspace({ documents, onBack, onOpenAtPage, onOpenDocument }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [cards, setCards] = useState<Record<string, CardPhase>>({});
  const [filter, setFilter] = useState('');
  const [generating, setGenerating] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');

  const loadCard = useCallback(async (key: string) => {
    setCards((current) => ({ ...current, [key]: { kind: 'loading' } }));
    try {
      const response = await api.readings(key);
      const entry = (response.entries as Record<string, { value?: string; updatedAt?: string } | undefined>).experiment;
      const groups = entry?.value ? parseExperimentCard(entry.value) : null;
      setCards((current) => ({
        ...current,
        [key]: groups
          ? { kind: 'ready', groups, updatedAt: entry?.updatedAt }
          : { kind: 'empty' },
      }));
    } catch (cause) {
      setCards((current) => ({
        ...current,
        [key]: { kind: 'error', message: cause instanceof Error ? cause.message : String(cause) },
      }));
    }
  }, []);

  // 选中的论文才去取精读记录；已取过的复用，翻来翻去不重复请求。
  useEffect(() => {
    for (const key of selected) {
      if (!cards[key]) void loadCard(key);
    }
  }, [selected, cards, loadCard]);

  const toggle = (key: string) => {
    setNotice('');
    setSelected((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      if (current.length >= MAX_PAPERS) {
        setNotice(`最多同时对照 ${MAX_PAPERS} 篇：先取消一篇再选。`);
        return current;
      }
      return [...current, key];
    });
  };

  /** 缺抽取的论文就地生成「实验配置」；用的是阅读器里同一套生成与校验流程。 */
  const generate = async (key: string) => {
    setGenerating((current) => ({ ...current, [key]: '正在生成…' }));
    try {
      await api.generate(key, 'experiment', [], (progress) => {
        setGenerating((current) => ({
          ...current,
          [key]: progress.message || `生成中 ${Math.round(progress.percent)}%`,
        }));
      });
      await loadCard(key);
      setNotice('已生成实验配置。');
    } catch (cause) {
      setNotice(`生成失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setGenerating((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  };

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return documents.filter(
      (doc) => !needle || doc.title.toLocaleLowerCase().includes(needle) || doc.key.includes(needle),
    );
  }, [documents, filter]);

  const columns = selected
    .map((key) => documents.find((doc) => doc.key === key))
    .filter((doc): doc is NonNullable<typeof doc> => Boolean(doc));

  return (
    <div className="compare-section">
      <header className="heat-toolbar">
        <div className="heat-heading">
          {onBack ? (
            <button type="button" className="heat-back" onClick={onBack} aria-label="返回书库">←</button>
          ) : null}
          <div>
            <p className="section-eyebrow">CROSS-PAPER COMPARISON</p>
            <h1>跨文献对照</h1>
            <p className="library-description">选 2–4 篇，把实验配置并排摊开；每格都能点回原文核对。</p>
          </div>
        </div>
      </header>

      <div className="compare-body">
        <aside className="compare-picker">
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索标题或论文键"
            aria-label="搜索要对照的论文"
          />
          <p className="compare-picker-hint">已选 {selected.length} / {MAX_PAPERS} 篇</p>
          <ul>
            {visible.map((doc) => {
              const checked = selected.includes(doc.key);
              return (
                <li key={doc.key}>
                  <label className={checked ? 'selected' : ''}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(doc.key)} />
                    <span title={doc.title}>{doc.title || doc.key}</span>
                    {doc.year ? <em className="tabular-nums">{doc.year}</em> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </aside>

        <div className="compare-main">
          {notice ? <p className="compare-notice" role="status">{notice}</p> : null}

          {columns.length < 2 ? (
            <p className="compare-empty">
              在左侧选 2–4 篇论文开始对照。表格里的每一格都来自该篇「精读 · 实验配置」的抽取结果。
            </p>
          ) : (
            <div className="compare-scroll">
              <table className="compare-table">
                <thead>
                  <tr>
                    <th scope="col">维度</th>
                    {columns.map((doc) => {
                      const phase = cards[doc.key];
                      return (
                        <th scope="col" key={doc.key}>
                          <button
                            type="button"
                            className="compare-column-title"
                            onClick={() => onOpenDocument(doc.id)}
                            title="打开这篇论文"
                          >
                            {doc.title || doc.key}
                          </button>
                          {phase?.kind === 'ready' ? (
                            <span className="compare-chip ready">已抽取</span>
                          ) : phase?.kind === 'empty' ? (
                            <span className="compare-chip missing">未抽取</span>
                          ) : phase?.kind === 'error' ? (
                            <span className="compare-chip error">读取失败</span>
                          ) : (
                            <span className="compare-chip">读取中…</span>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((group) => (
                    <tr key={group.id}>
                      <th scope="row">{group.label}</th>
                      {columns.map((doc) => {
                        const phase = cards[doc.key];
                        return (
                          <td key={`${doc.key}-${group.id}`}>
                            {phase?.kind === 'ready' ? (
                              <GroupCell
                                fields={phase.groups[group.id] ?? []}
                                onCite={(page) => onOpenAtPage(doc.key, page, '')}
                              />
                            ) : phase?.kind === 'empty' ? (
                              <div className="compare-cell-actions">
                                <span className="compare-none">未抽取</span>
                                <button
                                  type="button"
                                  disabled={Boolean(generating[doc.key])}
                                  onClick={() => void generate(doc.key)}
                                >
                                  {generating[doc.key] ?? '生成实验配置'}
                                </button>
                              </div>
                            ) : phase?.kind === 'error' ? (
                              <span className="compare-none text-bad">{phase.message}</span>
                            ) : (
                              <span className="compare-none">读取中…</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {columns.length >= 2 ? (
            <ul className="compare-disclosure">
              <li>数据来自各篇「精读 · 实验配置」的抽取结果：字段带页码与逐字依据，由服务端校验证据能在原文里找到。</li>
              <li>「未抽取」表示这篇还没生成实验配置，不等于论文没写；「未提及」是抽取结果里明确写下的断言。</li>
              <li>只覆盖实验配置相关的七个维度；方法公式、结果分析与代码复现是另外的精读章节，未并入此表。</li>
              <li>抽取本身可能漏字段：发现缺项请回该篇的「精读 · 实验配置」重新生成。</li>
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GroupCell({ fields, onCite }: { fields: ReadingField[]; onCite: (page: number) => void }) {
  const declaredUnknown = fields.filter((field) => !field.page && UNKNOWN_VALUES.has(field.v.trim()));
  const known = fields.filter((field) => !declaredUnknown.includes(field));
  if (!fields.length) {
    return <span className="compare-none">这一组没有字段</span>;
  }
  return (
    <div className="compare-cell">
      {known.map((field, index) => (
        <div className="compare-field" key={`${field.k}-${index}`}>
          {field.k ? <span className="compare-field-key">{field.k}</span> : null}
          <span className="compare-field-value">{field.v}</span>
          {field.page ? (
            <button type="button" className="compare-page" onClick={() => onCite(field.page as number)} title="跳到原文这一页">
              P{field.page}
            </button>
          ) : null}
        </div>
      ))}
      {declaredUnknown.length ? (
        <p className="compare-declared">
          {declaredUnknown.map((field) => field.v.trim()).join(' / ')}
        </p>
      ) : null}
    </div>
  );
}