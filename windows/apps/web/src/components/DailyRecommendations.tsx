import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type DailyRecommendation } from '../api/client';
// 与导入对话框一样按需加载：pdf.js 的元数据解析不该进首屏包。
const readPDFMetadata: typeof import('../api/pdfMetadata').readPDFMetadata = async (...args) =>
  (await import('../api/pdfMetadata')).readPDFMetadata(...args);

const CACHE_KEY = 'cbct-v2-daily-recommendations';
type DailyCache = { day: string; fetchedAt: string; papers: DailyRecommendation[] };

function dayKey() {
  return new Date().toLocaleDateString('en-CA');
}

function normalizedTitle(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function readCache(): DailyCache | null {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as DailyCache | null;
    return value?.day === dayKey() && Array.isArray(value.papers) ? value : null;
  } catch {
    return null;
  }
}

export function DailyRecommendations({ documents, onReload, embedded = false }: { documents: DocumentSummary[]; onReload: () => void; embedded?: boolean }) {
  const [papers, setPapers] = useState<DailyRecommendation[]>(() => readCache()?.papers ?? []);
  const [fetchedAt, setFetchedAt] = useState(() => readCache()?.fetchedAt ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState('');
  const [progress, setProgress] = useState('');
  const loaded = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const load = async (force = false) => {
    if (loading) return;
    const cached = readCache();
    if (!force && cached) {
      setPapers(cached.papers);
      setFetchedAt(cached.fetchedAt);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await api.dailyRecommendations();
      setPapers(result.papers);
      setFetchedAt(result.fetchedAt);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ day: dayKey(), ...result } satisfies DailyCache)); } catch { /* Private browsing may disable storage. */ }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    if (!readCache()) void load();
  }, []);

  const visible = useMemo(() => {
    const titles = new Set(documents.map((doc) => normalizedTitle(doc.title)));
    const dois = new Set(documents.map((doc) => doc.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '')));
    return papers.filter((paper) => !titles.has(normalizedTitle(paper.title)) && (!paper.doi || !dois.has(paper.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '')))).slice(0, 5);
  }, [documents, papers]);

  /**
   * 推荐卡片的导入必须和「选择本地文件 / 从链接导入」走同一条管线：
   * 先把全文下载到渲染进程、用 pdf.js 抽出版式与段落，再上传给服务端做 AI 元数据识别与全文翻译。
   * 若图省事直接调 /v1/import/url 一步入库，阅读页只会读到空译文——那里按 cachedOnly 取缓存。
   */
  const importPaper = async (paper: DailyRecommendation) => {
    if (!paper.pdfUrl) return;
    // 同一个按钮兼任取消：一次导入要跑完识别＋全文翻译，必须能中途停下。
    if (importing === paper.id) {
      controller.current?.abort();
      return;
    }
    if (importing) return;
    const current = new AbortController();
    controller.current = current;
    setImporting(paper.id);
    setProgress(`正在下载：${paper.title}`);
    try {
      const downloaded = await api.downloadPublication(paper.pdfUrl, paper.title, current.signal, (received, total) => {
        setProgress(total > 0 ? `正在下载：${Math.round((received / total) * 100)}%` : `正在下载：${Math.round(received / 1048576)} MB`);
      });
      setProgress('正在解析段落与栏位…');
      const hint = await readPDFMetadata(downloaded.file, current.signal, (page, total) => setProgress(`正在解析段落与栏位：${page}/${total} 页`));
      // 卡片已知的题录作为识别种子传下去，避免模型把标题写歪；未知字段仍由模型判定。
      hint.title = paper.title;
      hint.doi = paper.doi;
      hint.author = paper.authors.join(', ');
      hint.source = downloaded.source;
      if (!hint.firstPage.trim()) throw new Error('下载文件没有可读取的 PDF 首页，可能是扫描件或登录页，暂无法识别与翻译。');
      const result = await api.upload([downloaded.file], current.signal, [hint], (event) => {
        if (event.progress?.message) setProgress(event.progress.message);
      });
      const failed = result.results.find((item) => item.error);
      if (failed?.error) throw new Error(failed.error);
      const imported = result.results[0];
      setProgress(
        imported?.existing
          ? '论文已在书库中，译文已就绪'
          : `已导入书库：中文题名与全文翻译已保存${imported?.warning ? `（${imported.warning}）` : ''}`,
      );
      onReload();
    } catch (cause) {
      setProgress(
        current.signal.aborted
          ? '已取消导入；已经完成的部分保留在书库'
          : cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      if (controller.current === current) controller.current = null;
      setImporting('');
    }
  };

  return (
    // 侧栏里由外层提供卡片外观与滚动，这里只要一列铺满高度；嵌在列表里时仍是原来的卡片。
    <section className={embedded ? 'recommendations embedded flex h-full min-h-0 flex-col' : 'recommendations mb-4 rounded-xl border border-line bg-surface p-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <div>
          {!embedded ? <h2 className="text-sm font-semibold text-ink">每日论文推荐</h2> : null}
          <p className="mt-0.5 text-[11px] text-ink-faint">优先展示 MICCAI、CVPR、ICCV、ECCV、NeurIPS、ICLR、AAAI、TMI 与 Medical Image Analysis</p>
        </div>
        {fetchedAt ? <span className="text-[10px] text-ink-faint">更新于 {fetchedAt.slice(0, 16).replace('T', ' ')}</span> : null}
        <button type="button" onClick={() => void load(true)} disabled={loading} className="ml-auto rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50">{loading ? '正在检索…' : '刷新推荐'}</button>
      </div>
      {loading && !papers.length ? <p role="status" className="mt-3 text-xs text-ink-soft">正在检索顶刊顶会论文…</p> : null}
      {error ? <p role="status" className="mt-3 text-xs text-bad">{error}</p> : null}
      {!loading && !error && visible.length === 0 ? <p className="mt-3 text-xs text-ink-soft">今天暂无未入库的匹配论文。可以刷新重新检索。</p> : null}
      {progress ? <p role="status" className="mt-2 text-xs text-accent">{progress}</p> : null}
      <div className={`mt-2 grid gap-2${embedded ? '' : ' xl:grid-cols-2'}`}>
        {visible.map((paper) => (
          <article key={paper.id} className="recommendation-card rounded-lg border border-line bg-surface-sunk/40 px-3 py-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-[13px] font-medium leading-snug text-ink">{paper.title}</h3>
                <p className="mt-1 text-[11px] text-ink-soft">{paper.authors.slice(0, 5).join(', ')}{paper.authors.length > 5 ? ' 等' : ''}</p>
                <p className="mt-0.5 text-[11px] text-ink-faint">{paper.venue}{paper.year ? ` · ${paper.year}` : ''}</p>
                {paper.abstract ? <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-ink-soft">{paper.abstract}</p> : null}
              </div>
              <span className="shrink-0 rounded-pill bg-accent-soft px-2 py-0.5 text-[10px] text-accent">{paper.venueTier === 0 ? '顶刊/顶会' : '领域会议'}</span>
            </div>
            <div className="mt-2 flex gap-2">
              {paper.pdfUrl ? (
                <button
                  type="button"
                  onClick={() => void importPaper(paper)}
                  disabled={Boolean(importing) && importing !== paper.id}
                  title="与本地导入同一条管线：下载后 AI 识别题录并翻译全文，再入库"
                  className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-surface disabled:opacity-50"
                >
                  {importing === paper.id ? '取消导入' : '导入 PDF'}
                </button>
              ) : null}
              {paper.url ? <a href={paper.url} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-soft hover:text-ink">论文来源 ↗</a> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
