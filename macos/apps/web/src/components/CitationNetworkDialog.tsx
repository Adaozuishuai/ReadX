import { useEffect, useRef, useState } from 'react';
import { api, type CitationNetworkResponse } from '../api/client';
import { AppDialog } from './AppDialog';

/**
 * 库内引用关系。
 *
 * 关系来自 OpenAlex 元数据，不是解析 PDF 参考文献 —— 所以：
 *   - 没有 DOI 的论文查不了（显示原因，不报错）；
 *   - OpenAlex 未收录/未回填的条目会缺失；
 *   - 结果缓存 7 天，「重新获取」才打网络。
 * 这三点都按后端给的 disclosure 原样展示，不在这里另编一套说法。
 */
interface Props {
  documentKey: string;
  /** 打开库内的另一篇论文（同一篇则不跳）。 */
  onOpenDocument?: (key: string) => void;
  onClose: () => void;
}

export function CitationNetworkDialog({ documentKey, onOpenDocument, onClose }: Props) {
  const [data, setData] = useState<CitationNetworkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 「重新获取」把 refreshRequested 置真并换一次 token：token 只是用来重跑下面这个 effect。
  const refreshRequested = useRef(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = refreshRequested.current;
    setLoading(true);
    setError('');
    api
      .citationNetwork(documentKey, refresh, controller.signal)
      .then((value) => {
        setData(value);
        refreshRequested.current = false;
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        refreshRequested.current = false;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [documentKey, refreshToken]);

  const references = (data?.inLibrary ?? []).filter((edge) => edge.relation === 'reference');
  const citations = (data?.inLibrary ?? []).filter((edge) => edge.relation === 'citation');

  return (
    <AppDialog open onClose={onClose} className="citation-network-dialog">
      <header>
        <div>
          <h2>引用关系</h2>
          <small>{data?.title || documentKey}</small>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </header>

      <div className="citation-network-body">
        {loading ? <p role="status">查询引用关系…</p> : null}
        {error ? <p className="text-bad" role="alert">{error}</p> : null}

        {data && !loading ? (
          <>
            {data.available ? (
              <>
                <p className="citation-network-summary">
                  参考文献 <strong>{data.counts.references}</strong> 条
                  （已解析 {data.counts.resolvedReferences}）
                  {' · '}被引 <strong>{data.counts.citations}</strong> 次
                  {data.fromCache && data.fetchedAt
                    ? ` · 缓存于 ${new Date(data.fetchedAt).toLocaleString()}`
                    : ''}
                </p>

                <div className="citation-network-block">
                  <p className="citation-section-label">
                    库内引用：本文引用了 {references.length} 篇
                  </p>
                  {references.length ? (
                    <ul className="citation-network-list">
                      {references.map((edge) => (
                        <li key={`ref-${edge.key}`}>
                          <button
                            type="button"
                            onClick={() => onOpenDocument?.(edge.key)}
                            title="打开这篇论文"
                          >
                            <span className="citation-network-title">{edge.title || edge.key}</span>
                            <span className="citation-network-meta">
                              {edge.year ? `${edge.year} · ` : ''}本文引用了它
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="citation-none">库内没有它的参考文献（可能是还没导入）。</p>
                  )}
                </div>

                <div className="citation-network-block">
                  <p className="citation-section-label">
                    库内被引：本库有 {citations.length} 篇引用了本文
                  </p>
                  {citations.length ? (
                    <ul className="citation-network-list">
                      {citations.map((edge) => (
                        <li key={`cite-${edge.key}`}>
                          <button
                            type="button"
                            onClick={() => onOpenDocument?.(edge.key)}
                            title="打开这篇论文"
                          >
                            <span className="citation-network-title">{edge.title || edge.key}</span>
                            <span className="citation-network-meta">
                              {edge.year ? `${edge.year} · ` : ''}它引用了本文
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="citation-none">库内还没有论文引用它。</p>
                  )}
                </div>

                {data.external.length ? (
                  <div className="citation-network-block">
                    <p className="citation-section-label">库外相关（最近的几条）</p>
                    <ul className="citation-network-external">
                      {data.external.map((item) => (
                        <li key={`${item.title}-${item.doi}`}>
                          <span>{item.title}</span>
                          <span className="tabular-nums">
                            {item.year ? `${item.year} · ` : ''}{item.doi || '无 DOI'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : null}

            <ul className="citation-disclosure">
              {data.disclosure.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <footer>
        <button
          type="button"
          disabled={loading}
          title="忽略缓存，重新向 OpenAlex 查询"
          onClick={() => {
            refreshRequested.current = true;
            setRefreshToken((value) => value + 1);
          }}
        >
          重新获取
        </button>
        <button type="button" onClick={onClose}>关闭</button>
      </footer>
    </AppDialog>
  );
}