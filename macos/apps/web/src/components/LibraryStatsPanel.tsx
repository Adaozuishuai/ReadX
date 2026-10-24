import { useEffect, useState } from 'react';
import { api, type StatsResponse, type TrendsResponse } from '../api/client';
import { WorkspaceIcon } from './WorkspaceIcon';

/** 书库与阅读统计面板。 */
export function LibraryStatsPanel() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [trends, setTrends] = useState<TrendsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    Promise.all([
      api.stats(controller.signal),
      // 主题是加分项：拿不到不影响统计本身，所以单独兜住错误。
      api.trends(controller.signal).catch(() => null),
    ])
      .then(([value, trendValue]) => {
        setStats(value);
        setTrends(trendValue);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  if (loading) return <p className="stats-basis" role="status">读取统计…</p>;
  if (error) return <p className="stats-basis text-bad" role="alert">{error}</p>;
  if (!stats) return null;

  const { library, reading, processing, distribution } = stats;
  const supported = (trends?.findings ?? []).filter((item) => item.IsSupported).slice(0, 8);
  const unsupported = (trends?.findings ?? []).filter((item) => !item.IsSupported);

  return (
    <section className="stats-panel" aria-label="书库与阅读统计">
      <div className="stats-head">
        <h2>书库统计</h2>
      </div>

      <div className="stats-tiles">
        <Tile icon="library" value={library.active} unit="篇" label="在库文献" />
        <Tile icon="file" value={library.reading} unit="篇" label="正在阅读" />
        <Tile icon="check" value={library.done} unit="篇" label="已精读" />
        <Tile icon="sparkles" value={reading.activeWeek} unit="篇" label="最近 7 天在读" />
        <Tile icon="calendar" value={reading.activeMonth} unit="篇" label="最近 30 天在读" />
        <Tile icon="panel" value={reading.annotations} unit="条" label={`批注（近 30 天 +${reading.annotationsMonth}）`} />
      </div>

      <div className="stats-columns">
        <div className="stats-block">
          <p className="stats-label">处理耗时</p>
          {processing.stages.length ? (
            <table className="stats-table">
              <thead>
                <tr>
                  <th>阶段</th>
                  <th>次数</th>
                  <th>中位</th>
                  <th>总计</th>
                  <th>每页</th>
                </tr>
              </thead>
              <tbody>
                {processing.stages.map((stage) => (
                  <tr key={stage.key}>
                    <td>{stage.label || stage.key}</td>
                    <td className="tabular-nums">{stage.runs}</td>
                    <td className="tabular-nums">{formatDuration(stage.medianMs)}</td>
                    <td className="tabular-nums">{formatDuration(stage.totalMs)}</td>
                    <td className="tabular-nums">{stage.perPageMs == null ? '—' : formatDuration(stage.perPageMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="stats-empty">还没有带时间戳的处理记录。</p>
          )}
        </div>

        <div className="stats-block">
          <p className="stats-label">产出与分布</p>
          <ul className="stats-list">
            <li><span>精读记录</span><strong>{reading.readingNotes} 篇</strong></li>
            <li><span>正文索引</span><strong>{reading.indexedDocuments} 篇 · {reading.indexedPages} 页</strong></li>
            <li><span>书架 / 收藏</span><strong>{library.shelves} 个 · {library.favorite} 篇</strong></li>
            <li><span>回收站</span><strong>{library.trashed} 篇</strong></li>
          </ul>
          {distribution.years.length ? (
            <div className="stats-bars">
              {distribution.years.slice(0, 6).map((item) => (
                <Bar key={item.name} name={item.name} count={item.count} max={distribution.years[0]?.count ?? 1} />
              ))}
            </div>
          ) : null}
          {distribution.shelves.length ? (
            <div className="stats-tags">
              {distribution.shelves.map((item) => (
                <span key={item.name}>{item.name} <b>{item.count}</b></span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {supported.length ? (
        <div className="stats-block">
          <p className="stats-label">主题（按题录关键词聚合）</p>
          <ul className="stats-topics">
            {supported.map((item) => (
              <li key={item.Topic}>
                <strong>{item.Claim}</strong>
                <span>{item.Caveat}</span>
              </li>
            ))}
          </ul>
          {unsupported.length ? (
            <p className="stats-note">
              另有 {unsupported.length} 个主题样本不足 {trends?.minimum ?? 5} 篇，只计入计数、未在此列出。
            </p>
          ) : null}
        </div>
      ) : null}

    </section>
  );
}

function Tile({
  icon,
  value,
  unit,
  label,
}: {
  icon: 'library' | 'file' | 'check' | 'sparkles' | 'calendar' | 'panel';
  value: number;
  unit: string;
  label: string;
}) {
  return (
    <div className="stats-tile">
      <WorkspaceIcon name={icon} size={16} />
      <strong className="tabular-nums">{value}<small>{unit}</small></strong>
      <span>{label}</span>
    </div>
  );
}

function Bar({ name, count, max }: { name: string; count: number; max: number }) {
  const ratio = max > 0 ? Math.max(0.04, count / max) : 0;
  return (
    <div className="stats-bar">
      <span className="stats-bar-name">{name}</span>
      <span className="stats-bar-track"><i style={{ width: `${ratio * 100}%` }} /></span>
      <span className="stats-bar-count tabular-nums">{count}</span>
    </div>
  );
}

/** 秒级以下不显示小数：处理耗时看的是量级。 */
function formatDuration(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} 分`;
  return `${(minutes / 60).toFixed(1)} 小时`;
}
