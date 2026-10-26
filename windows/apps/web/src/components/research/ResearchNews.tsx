import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type ResearchFeedItem } from '../../api/client';
import type { WorkbenchData } from '../../lib/researchWorkbench';
import { DailyRecommendations } from '../DailyRecommendations';
import { WorkspaceIcon } from '../WorkspaceIcon';

type Source = 'arxiv' | 'journals' | 'weekly' | 'saved' | 'recommendations';
const sources = {
  arxiv: { label: 'arXiv', description: '计算机视觉 · cs.CV', icon: 'file' },
  journals: { label: 'Nature', description: '期刊 RSS 更新', icon: 'rss' },
  weekly: { label: '科技爱好者周刊', description: '阮一峰的网络日志', icon: 'code' },
  saved: { label: '稍后阅读', description: '收藏值得继续阅读的内容', icon: 'star' },
  recommendations: { label: '论文发现', description: '按研究领域与关键词检索', icon: 'sparkles' },
} as const;

function publishedDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
}

export function ResearchNews({ data, setData, documents, onReload }: {
  data: WorkbenchData; setData: Dispatch<SetStateAction<WorkbenchData>>; documents: DocumentSummary[]; onReload: () => void;
}) {
  const [source, setSource] = useState<Source>('arxiv');
  const [items, setItems] = useState<ResearchFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [revision, setRevision] = useState(0);
  const [fetchedAt, setFetchedAt] = useState('');
  const [translating, setTranslating] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);

  useEffect(() => {
    setError('');
    if (source === 'saved' || source === 'recommendations') { setLoading(false); return; }
    const controller = new AbortController();
    setItems([]); setLoading(true); setFetchedAt('');
    void api.researchFeed(source, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setItems(result.items); setFetchedAt(result.fetchedAt);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source, revision]);

  const translate = async (item: ResearchFeedItem) => {
    if (translating.includes(item.id)) return;
    setTranslating(current => [...current, item.id]); setError('');
    try {
      const result = await api.translateResearchTitle(item.title);
      setData(current => ({ ...current, translations: { ...current.translations, [item.id]: result.translation } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setTranslating(current => current.filter(id => id !== item.id)); }
  };
  const toggleSaved = (item: ResearchFeedItem) => setData(current => ({ ...current, savedArticles: current.savedArticles.some(article => article.id === item.id) ? current.savedArticles.filter(article => article.id !== item.id) : [item, ...current.savedArticles] }));
  const markRead = (id: string) => setData(current => current.readArticleIds.includes(id) ? current : { ...current, readArticleIds: [...current.readArticleIds, id] });
  const list = (source === 'saved' ? data.savedArticles : items).filter(item => !query.trim() || `${item.title} ${data.translations[item.id] ?? ''} ${item.summary} ${item.source}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  return <div className="rw-news-layout">
    <div className="rw-news-main">
      {source === 'recommendations' ? <section className="rw-card rw-recommendations"><DailyRecommendations documents={documents} onReload={onReload} /></section> : <>
        <div className="rw-news-toolbar"><label className="rw-search"><WorkspaceIcon name="search" size={17} /><input aria-label="搜索当前资讯" placeholder="搜索标题、摘要或关键词…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button className="rw-icon-button" aria-label="清空资讯搜索" onClick={() => setQuery('')}><WorkspaceIcon name="close" size={14} /></button>}</label>{source !== 'saved' && <button className="rw-button" disabled={loading} onClick={() => setRevision(value => value + 1)}><WorkspaceIcon name="reset" size={15} />{loading ? '更新中' : '刷新'}</button>}</div>
        <div className="rw-feed-heading"><div><h2>{sources[source].label}{source !== 'saved' && <span>最新更新</span>}</h2><span>{loading ? '正在获取内容…' : `${list.length} 条${query ? '匹配' : '内容'}`}</span></div>{fetchedAt && source !== 'saved' && <small>更新于 {new Date(fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small>}</div>
        {error && <div className="rw-error" role="alert"><WorkspaceIcon name="rss" size={17} /><span>{error}</span>{source !== 'saved' && <button onClick={() => setRevision(value => value + 1)}>重试</button>}</div>}
        <div className="rw-feed-list" aria-busy={loading}>
          {loading ? <div className="rw-feed-skeleton" role="status" aria-label="正在加载资讯">{[0, 1, 2].map(index => <div key={index}><i /><i /><i /></div>)}</div> : list.map((item, index) => {
            const saved = data.savedArticles.some(article => article.id === item.id);
            const read = data.readArticleIds.includes(item.id);
            return <article className={`rw-feed-item${index === 0 ? ' rw-feed-featured' : ''}${read ? ' is-read' : ''}`} key={item.id}>
              <div className="rw-feed-meta"><span><i />{item.source}</span><time>{publishedDate(item.published)}</time>{read && <small><WorkspaceIcon name="check" size={11} />已读</small>}<button className={`rw-icon-button${saved ? ' is-saved' : ''}`} aria-pressed={saved} aria-label={`${saved ? '取消收藏' : '稍后阅读'}：${item.title}`} title={saved ? '取消收藏' : '稍后阅读'} onClick={() => toggleSaved(item)}><WorkspaceIcon name="star" size={17} /></button></div>
              <h3><a href={item.url} target="_blank" rel="noreferrer" onClick={() => markRead(item.id)}>{data.translations[item.id] || item.title}</a></h3>
              {data.translations[item.id] && <p className="rw-feed-original">{item.title}</p>}
              {item.summary && <p className={`rw-feed-summary${expanded.includes(item.id) ? ' expanded' : ''}`}>{item.summary}</p>}
              <div className="rw-feed-actions"><a href={item.url} target="_blank" rel="noreferrer" onClick={() => markRead(item.id)}>阅读原文<WorkspaceIcon name="external" size={13} /></a><button disabled={Boolean(data.translations[item.id]) || translating.includes(item.id)} onClick={() => void translate(item)}><WorkspaceIcon name="sparkles" size={13} />{translating.includes(item.id) ? '翻译中…' : data.translations[item.id] ? '已译为中文' : '翻译标题'}</button>{item.summary.length > 240 && <button onClick={() => setExpanded(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}>{expanded.includes(item.id) ? '收起摘要' : '展开摘要'}</button>}</div>
            </article>;
          })}
        </div>
        {!loading && !list.length && !error && <div className="rw-card rw-empty rw-feed-empty"><span><WorkspaceIcon name={source === 'saved' ? 'star' : 'search'} size={29} /></span><h3>{query ? '没有找到匹配的内容' : source === 'saved' ? '把想继续读的内容留在这里' : '这个来源暂时没有更新'}</h3><p>{query ? '换个关键词，或清空搜索查看全部内容。' : source === 'saved' ? '点击资讯右上角的星标，即可加入稍后阅读。' : '稍后刷新，或选择其他资讯来源。'}</p>{query && <button className="rw-text-button" onClick={() => setQuery('')}>清空搜索<WorkspaceIcon name="arrow" size={14} /></button>}</div>}
      </>}
    </div>
    <aside className="rw-news-sidebar">
      <section className="rw-card rw-source-card"><span className="rw-kicker">YOUR RESEARCH RADAR</span><h2>订阅与发现</h2><p>在更新之间，找到与你的研究相关的线索。</p><div className="rw-source-label">订阅来源</div>{(['arxiv', 'journals', 'weekly'] as const).map(id => <button key={id} className={source === id ? 'selected' : ''} aria-pressed={source === id} onClick={() => setSource(id)}><span className={`rw-source-icon ${id}`}><WorkspaceIcon name={sources[id].icon} size={17} /></span><span><strong>{sources[id].label}</strong><small>{sources[id].description}</small></span><WorkspaceIcon name="chevronRight" size={14} /></button>)}<div className="rw-source-label">阅读空间</div>{(['saved', 'recommendations'] as const).map(id => <button key={id} className={source === id ? 'selected' : ''} aria-pressed={source === id} onClick={() => setSource(id)}><span className="rw-source-icon"><WorkspaceIcon name={sources[id].icon} size={17} /></span><span><strong>{sources[id].label}</strong><small>{id === 'saved' ? `${data.savedArticles.length} 条已收藏` : sources[id].description}</small></span><WorkspaceIcon name="chevronRight" size={14} /></button>)}</section>
      <div className="rw-news-note"><WorkspaceIcon name="sparkles" size={18} /><div><strong>按需翻译标题</strong><p>需要时再翻译。仅所选标题会发送至 Google 翻译，译文将保存在本机。</p></div></div>
    </aside>
  </div>;
}
