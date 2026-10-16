import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type DailyRecommendation } from '../api/client';

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

export function DailyRecommendations({ documents, onReload }: { documents: DocumentSummary[]; onReload: () => void }) {
  const [papers, setPapers] = useState<DailyRecommendation[]>(() => readCache()?.papers ?? []);
  const [fetchedAt, setFetchedAt] = useState(() => readCache()?.fetchedAt ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState('');
  const [progress, setProgress] = useState('');
  const loaded = useRef(false);

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

  const importPaper = async (paper: DailyRecommendation) => {
    if (!paper.pdfUrl || importing) return;
    setImporting(paper.id);
    setProgress(`正在下载：${paper.title}`);
    try {
      const result = await api.importURL(paper.pdfUrl, paper.title, { doi: paper.doi, authors: paper.authors, venue: paper.venue, year: paper.year }, undefined, (received, total) => {
        setProgress(total > 0 ? `正在下载：${Math.round(received / total * 100)}%` : `正在下载：${Math.round(received / 1024 / 1024)} MB`);
      });
      setProgress(result.existing ? '论文已在书库中' : '已导入书库');
      onReload();
    } catch (cause) {
      setProgress(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting('');
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">每日论文推荐</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">优先展示 MICCAI、CVPR、ICCV、ECCV、NeurIPS、ICLR、AAAI、TMI 与 Medical Image Analysis</p>
        </div>
        {fetchedAt ? <span className="text-[10px] text-ink-faint">更新于 {fetchedAt.slice(0, 16).replace('T', ' ')}</span> : null}
        <button type="button" onClick={() => void load(true)} disabled={loading} className="ml-auto rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-soft hover:text-ink disabled:opacity-50">{loading ? '正在检索…' : '刷新推荐'}</button>
      </div>
      {loading && !papers.length ? <p role="status" className="mt-3 text-xs text-ink-soft">正在检索顶刊顶会论文…</p> : null}
      {error ? <p role="status" className="mt-3 text-xs text-bad">{error}</p> : null}
      {!loading && !error && visible.length === 0 ? <p className="mt-3 text-xs text-ink-soft">今天暂无未入库的匹配论文。可以刷新重新检索。</p> : null}
      {progress ? <p role="status" className="mt-2 text-xs text-accent">{progress}</p> : null}
      <div className="mt-2 grid gap-2 xl:grid-cols-2">
        {visible.map((paper) => (
          <article key={paper.id} className="rounded-lg border border-line bg-surface-sunk/40 px-3 py-2">
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
              {paper.pdfUrl ? <button type="button" onClick={() => void importPaper(paper)} disabled={Boolean(importing)} className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-surface disabled:opacity-50">{importing === paper.id ? '导入中…' : '导入 PDF'}</button> : null}
              {paper.url ? <a href={paper.url} target="_blank" rel="noreferrer" className="rounded-md border border-line px-2.5 py-1 text-[11px] text-ink-soft hover:text-ink">论文来源 ↗</a> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
