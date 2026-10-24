import { useEffect, useMemo, useState } from 'react';
import { api, type CitationFormat, type CitationPreview } from '../api/client';
import { AppDialog } from './AppDialog';

/**
 * 导出书目（BibTeX / RIS）。
 *
 * 条目类型是按会场名推断的，所以这个对话框先拉一份预览：把「哪几篇会被写成 @misc、
 * 依据是什么、哪些字段是空的」摆在下载按钮之前——否则用户要打开 .bib 才发现类型不对。
 */
interface Props {
  /** 指定论文；与 category 二选一，都不给表示整库。 */
  keys?: string[];
  /** 按书架导出。 */
  category?: string;
  /** 范围说明，直接显示给用户（如「全部文献」「书架：CBCT 重建」）。 */
  scopeLabel: string;
  onClose: () => void;
}

const KIND_LABEL: Record<string, string> = {
  article: '期刊论文',
  inproceedings: '会议论文',
  misc: '其他（@misc）',
};

export function CitationExportDialog({ keys, category, scopeLabel, onClose }: Props) {
  const [format, setFormat] = useState<CitationFormat>('bibtex');
  const [preview, setPreview] = useState<CitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState(false);

  const keySignature = keys?.join(',') ?? '';

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setNotice('');
    // 条目类型与格式无关，预览固定用 bibtex 问一次。
    api
      .citationPreview(
        { format: 'bibtex', keys: keys?.length ? keys : undefined, category },
        controller.signal,
      )
      .then((value) => setPreview(value))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [keySignature, category]);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of preview?.items ?? []) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [preview]);

  const visibleItems = useMemo(() => {
    const items = preview?.items ?? [];
    return expanded ? items : items.slice(0, 6);
  }, [preview, expanded]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api.exportCitations({
        format,
        keys: keys?.length ? keys : undefined,
        category,
      });
      setNotice(
        `已导出 ${result.exported} 篇到 ${result.filename}` +
          (result.skipped ? `，${result.skipped} 篇不在库中已跳过` : ''),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppDialog open onClose={onClose} className="citation-dialog">
      <header>
        <div>
          <h2>导出书目</h2>
          <small>范围：{scopeLabel} · 条目类型按会场名推断，依据见下方说明</small>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </header>

      <div className="citation-body">
        {loading ? <p role="status">读取题录…</p> : null}
        {error ? <p className="text-bad" role="alert">{error}</p> : null}

        {preview ? (
          <>
            <p className="citation-count">
              共 <strong>{preview.count}</strong> 篇
              {preview.skipped > 0 ? `，${preview.skipped} 篇指定的论文不在库中（已跳过）` : ''}
            </p>

            {preview.warnings.length ? (
              <ul className="citation-warnings">
                {preview.warnings.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}

            {kindCounts.length ? (
              <div className="citation-bases">
                <p className="citation-section-label">条目类型</p>
                <ul>
                  {kindCounts.map(([kind, count]) => (
                    <li key={kind}>
                      <strong>{count}</strong> 篇 · {KIND_LABEL[kind] ?? kind}
                    </li>
                  ))}
                </ul>
                <ul className="citation-basis">
                  {preview.bases.map((item) => (
                    <li key={item.basis}>
                      {item.count} 篇：{item.basis}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.items.length ? (
              <div className="citation-items">
                <p className="citation-section-label">条目预览</p>
                <ul>
                  {visibleItems.map((item) => (
                    <li key={item.key}>
                      <code>@{item.kind}{`{${item.citeKey}}`}</code>
                      <span title={item.title}>{item.title || item.key}</span>
                    </li>
                  ))}
                </ul>
                {preview.items.length > 6 ? (
                  <button type="button" onClick={() => setExpanded((value) => !value)}>
                    {expanded ? '收起' : `展开全部 ${preview.items.length} 条`}
                  </button>
                ) : null}
              </div>
            ) : null}

            <p className="citation-note">
              作者姓名按库中题录原样写出，未做「姓, 名」改写；中文题名不写入条目，以免下游工具误读。
            </p>
          </>
        ) : null}

        {notice ? <p className="citation-notice" role="status">{notice}</p> : null}
      </div>

      <footer>
        <div className="citation-format" role="group" aria-label="导出格式">
          {(['bibtex', 'ris'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={format === item}
              className={format === item ? 'active' : ''}
              onClick={() => setFormat(item)}
            >
              {item === 'bibtex' ? 'BibTeX (.bib)' : 'RIS (.ris)'}
            </button>
          ))}
        </div>
        <button type="button" onClick={onClose}>取消</button>
        <button
          type="button"
          className="primary"
          disabled={busy || loading || !preview?.count}
          onClick={() => void run()}
        >
          {busy ? '导出中…' : '导出'}
        </button>
      </footer>
    </AppDialog>
  );
}