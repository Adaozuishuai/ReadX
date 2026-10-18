import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { statusLabel } from '@cbct/shared';
import type { Category, DocumentMeta } from '../api/client';
import { api } from '../api/client';
import type { Filters, WorkspacePhase } from '../hooks/useWorkspace';
import { useDebouncedValue } from '../hooks/useWorkspace';
import type { useLibraryMeta } from '../hooks/useLibraryMeta';
import { CATEGORY_COLORS, categoryDot, categoryLabel } from '../categories';
import { LibraryCard } from './LibraryCard';
import { LibraryTrashButton } from './LibraryTrashButton';
import { EmptyTrashDialog } from './EmptyTrashDialog';
import { DailyRecommendations } from './DailyRecommendations';
import { ResizeHandle } from './ResizeHandle';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';

type Layout = 'grid' | 'list' | 'table';
type SortKey = 'title' | 'year' | 'status';

/** 每日推荐的独立侧栏：开合与宽度都按用户上次的选择保存。 */
const DAILY_STORAGE = 'cbct-v2-library-daily';
const DAILY_DEFAULT_WIDTH = 316;
const DAILY_MIN_WIDTH = 260;
const DAILY_MAX_WIDTH = 720;

function readDailyPanel(): { open: boolean; width: number } {
  // 宽窗口默认展开（原来它常驻列表顶部），窄窗口默认收起，不挤占书库列表。
  const fallback = { open: typeof window !== 'undefined' && window.innerWidth >= 1280, width: DAILY_DEFAULT_WIDTH };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(DAILY_STORAGE) ?? 'null') as { open?: unknown; width?: unknown } | null;
    return {
      open: typeof value?.open === 'boolean' ? value.open : fallback.open,
      width: typeof value?.width === 'number' && Number.isFinite(value.width)
        ? Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, value.width))
        : fallback.width,
    };
  } catch {
    return fallback;
  }
}

const LAYOUT_STORAGE = 'cbct-v2-library-layout';

function readLayout(): Layout {
  if (typeof localStorage === 'undefined') return 'grid';
  const value = localStorage.getItem(LAYOUT_STORAGE);
  return value === 'list' || value === 'table' ? value : 'grid';
}

function normalizePaperTitle(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function extractArxivId(value: string | undefined): string | null {
  if (!value) return null;
  return value.match(/(?:arxiv(?:\.org\/(?:abs|pdf)\/|:)\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z][a-z.-]*\/\d{7}(?:v\d+)?)/i)?.[1] ?? null;
}

const STATUS_TONE: Record<string, string> = {
  reading: 'bg-accent-soft text-accent',
  done: 'bg-good/10 text-good',
  queue: 'bg-surface-sunk text-ink-soft',
  archive: 'bg-surface-sunk text-ink-faint',
};

/** 左侧导航的视图项（复刻参考实现：全部文档 / 收藏 / 回收站）。 */
type ViewId = 'all' | 'favorite' | 'trash' | 'shelves' | 'calendar' | 'graph';

interface Props {
  phase: WorkspacePhase;
  filters: Filters;
  setFilters: (next: Partial<Filters>) => void;
  selectedId: string | null;
  onOpenDocument: (id: string) => void;
  onOpenImport: () => void;
  onOpenSettings: () => void;
  meta: ReturnType<typeof useLibraryMeta>;
  view: ViewId;
  onViewChange: (view: ViewId) => void;
  onOpenReproduction: (key: string) => void;
  onTrashEmptied: () => void;
  onReload: () => void;
}

/**
 * 书库全屏页：左侧边栏（视图导航 + 分类 + 底部导入/设置）+ 主区（顶部条 + 封面网格/列表/表格）。
 * 版式对齐参考实现（`.app` / `.library-sidebar` / `.library-main` / `.book-grid`），
 * 颜色映射到本仓库既有 token，因此三主题仍然生效。
 */
export function LibraryScreen({
  phase,
  filters,
  setFilters,
  selectedId,
  onOpenDocument,
  onOpenImport,
  onOpenSettings,
  meta,
  view,
  onViewChange,
  onOpenReproduction,
  onTrashEmptied,
  onReload,
}: Props) {
  const [emptyTrashKeys, setEmptyTrashKeys] = useState<string[] | null>(null);
  const [input, setInput] = useState(filters.q);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [layout, setLayout] = useState<Layout>(readLayout);
  const [sort, setSort] = useState<{ key: SortKey; reverse: boolean }>({ key: 'title', reverse: false });
  const [managingCategories, setManagingCategories] = useState(false);
  const [duplicates, setDuplicates] = useState<{ primaryKey: string; keys: string[] }[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [dailyOpen, setDailyOpen] = useState(() => readDailyPanel().open);
  const [dailyWidth, setDailyWidth] = useState(() => readDailyPanel().width);
  useEffect(() => {
    try {
      localStorage.setItem(DAILY_STORAGE, JSON.stringify({ open: dailyOpen, width: dailyWidth }));
    } catch { /* Storage may be disabled. */ }
  }, [dailyOpen, dailyWidth]);
  const [fetchingArxiv, setFetchingArxiv] = useState(false);
  const [arxivProgress, setArxivProgress] = useState('');
  const [arxivSummary, setArxivSummary] = useState('');
  const arxivController = useRef<AbortController | null>(null);
  const debounced = useDebouncedValue(input, 300);

  useEffect(() => {
    if (debounced !== filters.q) setFilters({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_STORAGE, layout);
    } catch {
      /* 隐私模式写不了：本次会话仍生效。 */
    }
  }, [layout]);

  useEffect(() => {
    const controller = new AbortController();
    api
      .duplicates(controller.signal)
      .then((result) => setDuplicates(result.groups))
      .catch(() => undefined);
    return () => controller.abort();
  }, [phase.kind === 'ready' ? phase.meta.documentsTotal : 0]);

  const rawDocuments = phase.kind === 'ready' ? phase.documents.documents : [];
  const total = phase.kind === 'ready' ? phase.meta.documentsTotal : 0;
  const trashCount = rawDocuments.filter((doc) => meta.items[doc.key]?.deleted).length;
  const activeDocuments = rawDocuments.filter((doc) => !meta.items[doc.key]?.deleted);
  const favoriteCount = rawDocuments.filter((doc) => meta.items[doc.key]?.favorite && !meta.items[doc.key]?.deleted).length;
  const toggleTrash = (key: string) => meta.patch(key, { deleted: !meta.items[key]?.deleted });
  const missingPDFs = useMemo(() => rawDocuments.filter((doc) =>
    !meta.items[doc.key]?.deleted && doc.title.trim() && doc.format !== 'epub' && !(doc.hasPdf ?? Boolean(doc.pdfPath))),
  [rawDocuments, meta.items]);

  const fetchMissingArxivPDFs = async () => {
    if (fetchingArxiv || missingPDFs.length === 0) return;
    const controller = new AbortController();
    arxivController.current = controller;
    setFetchingArxiv(true);
    setArxivSummary('');
    const saved: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];
    for (let index = 0; index < missingPDFs.length; index++) {
      const doc = missingPDFs[index]!;
      if (controller.signal.aborted) break;
      setArxivProgress(`正在检索 ${index + 1}/${missingPDFs.length}：${doc.title}`);
      try {
        const candidates = (await api.searchImport(doc.title, controller.signal)).results;
        const titleKey = normalizePaperTitle(doc.title);
        const exactMatches = candidates.filter((candidate) => normalizePaperTitle(candidate.title) === titleKey)
          .map((candidate) => ({ candidate, arxiv: extractArxivId(candidate.arxiv || candidate.url) }))
          .filter((item): item is { candidate: typeof candidates[number]; arxiv: string } => Boolean(item.arxiv));
        const uniqueMatches = [...new Map(exactMatches.map((item) => [item.arxiv.replace(/v\d+$/i, ''), item])).values()];
        if (uniqueMatches.length !== 1) {
          skipped.push(doc.title);
          continue;
        }
        const match = uniqueMatches[0]!;
        setArxivProgress(`正在下载 ${index + 1}/${missingPDFs.length}：${doc.title}`);
        await api.attachArxivPDF(doc.key, match.arxiv, controller.signal, (progress) => {
          const size = progress.total ? `（${(progress.received / 1048576).toFixed(1)}/${(progress.total / 1048576).toFixed(1)} MB）` : '';
          setArxivProgress(`正在下载 ${index + 1}/${missingPDFs.length}：${doc.title}${size}`);
        });
        saved.push(doc.title);
      } catch (cause) {
        if (controller.signal.aborted) break;
        failed.push(`${doc.title}：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    arxivController.current = null;
    setFetchingArxiv(false);
    setArxivProgress('');
    const stopped = controller.signal.aborted;
    const parts = [`已获取 ${saved.length} 篇`];
    if (skipped.length) parts.push(`${skipped.length} 篇未找到标题完全匹配的 arXiv 版本`);
    if (failed.length) parts.push(`${failed.length} 篇下载失败`);
    if (stopped) parts.push('已停止');
    setArxivSummary(`${parts.join('；')}${skipped.length ? `。未匹配：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? '等' : ''}` : ''}${failed.length ? `。失败：${failed.slice(0, 2).join('；')}` : ''}`);
    if (saved.length) onReload();
  };

  const documents = useMemo(() => {
    const filtered = rawDocuments.filter((doc) => {
      const item = meta.items[doc.key];
      if (view === 'trash') return Boolean(item?.deleted);
      if (item?.deleted) return false;
      if (view === 'favorite' && !item?.favorite) return false;
      if (categoryFilter && !(item?.categories ?? []).includes(categoryFilter)) return false;
      if (tagFilter && !(item?.tags ?? []).includes(tagFilter)) return false;
      return true;
    });
    const direction = sort.reverse ? -1 : 1;
    return [...filtered].sort((a, b) => {
      let delta = 0;
      if (sort.key === 'title') delta = a.title.localeCompare(b.title, 'zh');
      else if (sort.key === 'year') delta = (a.year ?? 0) - (b.year ?? 0);
      else delta = a.status.localeCompare(b.status);
      return delta !== 0 ? delta * direction : a.title.localeCompare(b.title, 'zh');
    });
  }, [rawDocuments, meta.items, view, categoryFilter, tagFilter, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, reverse: !current.reverse } : { key, reverse: false }));

  // 书架计数按**论文**算：只数真的被归入某个书架的非回收站论文。
  // 原先用的是 activeDocuments.length（全部未删除论文），数字看起来像"书架个数"，
  // 也把没归类的论文算了进去。
  const shelfNames = useMemo(() => new Set(meta.categories.map((item) => item.name)), [meta.categories]);
  const shelvedDocuments = useMemo(
    () => activeDocuments.filter((doc) => (meta.items[doc.key]?.categories ?? []).some((name) => shelfNames.has(name))),
    [activeDocuments, meta.items, shelfNames],
  );
  const countInShelf = useCallback(
    (name: string) => activeDocuments.filter((doc) => (meta.items[doc.key]?.categories ?? []).includes(name)).length,
    [activeDocuments, meta.items],
  );

  const VIEWS: { id: ViewId; label: string; icon: WorkspaceIconName; count?: number }[] = [
    { id: 'all', label: '全部文档', icon: 'library', count: total - trashCount },
    { id: 'shelves', label: '书架', icon: 'shelves', count: shelvedDocuments.length },
    { id: 'favorite', label: '收藏', icon: 'star', count: favoriteCount },
    { id: 'trash', label: '回收站', icon: 'trash', count: trashCount },
    { id: 'graph', label: '知识图谱', icon: 'graph' },
    { id: 'calendar', label: '阅读日历', icon: 'calendar' },
  ];

  return (
    <div className={`app-shell${dailyOpen ? ' daily-open' : ''}`}>
      <aside className={`library-sidebar${collapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-brand">
          <strong>个人书库</strong>
          <span>RESEARCH LIBRARY</span>
        </div>

        <nav className="flex flex-col gap-1" aria-label="书库视图">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'shelves') { setCategoryFilter(''); setTagFilter(''); }
                onViewChange(item.id);
              }}
              aria-current={view === item.id ? 'page' : undefined}
              title={item.label}
              className={`nav-item${view === item.id ? ' active' : ''}`}
            >
              <WorkspaceIcon name={item.icon} /><span className="nav-label">{item.label}</span>
              {item.count != null && item.count > 0 ? <span className="nav-count">{item.count}</span> : null}
            </button>
          ))}
        </nav>

        {meta.categories.length || managingCategories ? (
          <div className="sidebar-shelves flex flex-col gap-1 px-1">
              <span className="px-2 text-[10px] uppercase tracking-wide text-ink-faint">我的书架</span>
            {meta.categories.map((item) => (
              <button
                key={item.name}
                type="button"
              onClick={() => { setCategoryFilter(categoryFilter === item.name ? '' : item.name); onViewChange('all'); }}
                className={`nav-item${categoryFilter === item.name ? ' active' : ''}`}
                style={{ minHeight: 32 }}
              >
                <span className="ann-color-dot" style={{ background: categoryDot(item.color) }} />
                <span className="min-w-0 flex-1 truncate text-left">{item.name}</span>
                {countInShelf(item.name) > 0 ? <span className="nav-count">{countInShelf(item.name)}</span> : null}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setManagingCategories((value) => !value)}
              className="px-2 py-1 text-left text-[11px] text-ink-faint hover:text-accent"
            >
              {managingCategories ? '收起书架管理' : '+ 管理书架'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setManagingCategories(true)}
            className="sidebar-shelves px-3 py-1 text-left text-[11px] text-ink-faint hover:text-accent"
          >
            + 新建书架
          </button>
        )}

        {managingCategories ? <CategoryManager meta={meta} onDone={() => setManagingCategories(false)} /> : null}

        <div className="sidebar-bottom">
          {/* 左下角：AI 助手设置。放在持久可见的侧栏底部，不再占顶栏空间。 */}
          <button type="button" className="nav-item" onClick={onOpenSettings} title="AI 助手设置">
            <WorkspaceIcon name="settings" /><span className="nav-label">AI 助手设置</span>
          </button>
          {meta.error ? <p className="px-3 text-[10px] leading-relaxed text-bad">{meta.error}</p> : null}
        </div>
      </aside>

      <section className="library-main">
        <header className="library-topbar">
          <div className="library-heading">
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              className="sidebar-toggle"
              title={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed}
            >
              <WorkspaceIcon name="panel" size={17} />
            </button>
            <div className="min-w-0">
            <p className="section-eyebrow">MY LIBRARY</p>
            <h1>
              {view === 'all' ? '全部文档' : view === 'favorite' ? '收藏' : view === 'trash' ? '回收站' : view === 'shelves' ? '我的书架' : view === 'graph' ? '知识图谱' : '阅读日历'}
            </h1>
            <p className="library-description">集中管理论文、精读笔记与复现计划。</p>
            </div>
          </div>
          <div className="library-view-actions">
            {missingPDFs.length > 0 ? (
              <button type="button" className="mr-2 rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-accent hover:border-accent disabled:opacity-50" disabled={fetchingArxiv} onClick={() => void fetchMissingArxivPDFs()}>
                {fetchingArxiv ? '正在自动获取…' : `自动获取缺失 PDF（${missingPDFs.length}）`}
              </button>
            ) : null}
            {fetchingArxiv ? <button type="button" className="mr-2 rounded-md border border-line px-2 py-1 text-[11px] text-bad" onClick={() => arxivController.current?.abort()}>停止</button> : null}
            {view === 'trash' ? (
              <button type="button" className="mr-2 rounded-md border border-line px-2 py-1 text-[11px] text-bad disabled:opacity-40" disabled={!Object.values(meta.items).some(item => item.deleted)} onClick={() => setEmptyTrashKeys(Object.values(meta.items).filter(item => item.deleted).map(item => item.key))}>
                清空回收站
              </button>
            ) : null}
            <div className="view-switch" role="group" aria-label="文献布局">
            {(['grid', 'list', 'table'] as Layout[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setLayout(item)}
                aria-pressed={layout === item}
                className={layout === item ? 'active' : ''}
              >
                <WorkspaceIcon name={item} size={15} /><span>{item === 'grid' ? '网格' : item === 'list' ? '列表' : '表格'}</span>
              </button>
            ))}
            </div>
            <button
              type="button"
              onClick={() => setDailyOpen((value) => !value)}
              aria-pressed={dailyOpen}
              title="每日论文推荐单独占一个侧栏；宽度可拖拽，双击分隔线复位"
              className={`discovery-toggle${dailyOpen ? ' active' : ''}`}
            >
              <WorkspaceIcon name="sparkles" size={15} /><span>每日推荐</span>
            </button>
          </div>
        </header>

        <div className="library-content">
          {arxivProgress ? <p role="status" className="mb-2 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">{arxivProgress}</p> : null}
          {arxivSummary ? <p role="status" className="mb-2 rounded-md bg-surface-sunk px-3 py-2 text-xs text-ink-soft">{arxivSummary}</p> : null}
          {view === 'trash' ? <div className="mb-3 text-xs leading-relaxed text-ink-soft"><p>清空仅移除书库条目和关联阅读数据，所有 PDF / EPUB 文件均保留。</p>{phase.kind === 'ready' ? <p className="break-all">导入副本位置：{phase.meta.dataRoot.replace(/[\\/]$/, '')}/library</p> : null}</div> : null}
          {phase.kind === 'ready' && view !== 'trash' ? (
            <div className="library-metrics" aria-label="当前列表概览">
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="file" /></span><strong>{documents.length}</strong><span>当前文献</span></div>
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="library" /></span><strong>{documents.filter(doc => doc.status === 'reading').length}</strong><span>正在阅读</span></div>
              <div className="library-metric"><span className="metric-icon"><WorkspaceIcon name="check" /></span><strong>{documents.filter(doc => doc.status === 'done').length}</strong><span>已精读</span></div>
            </div>
          ) : null}
          <div className="library-controls">
            <label className="search-field">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="搜索标题 / 作者 / 会场"
                aria-label="搜索文献标题、作者或会场"
              />
            </label>
            <span style={{ flex: 1 }} />
            {meta.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                className={`rounded-pill px-2 py-1 text-[11px] transition ${tagFilter === tag ? 'bg-accent-soft font-medium text-accent' : 'bg-surface-sunk text-ink-soft hover:text-ink'}`}
              >
                {tag}
              </button>
            ))}
          </div>

          {phase.kind === 'loading' ? <SkeletonGrid /> : null}
          {phase.kind === 'error' ? (
            <p className="py-6 text-[13px] leading-relaxed text-ink-soft">{phase.message}</p>
          ) : null}

          {phase.kind === 'ready' && documents.length === 0 ? (
            <div className="empty-state">
              {view === 'trash' ? (
                <>
                  <h2>回收站为空</h2>
                  <p>点击文章右上角的垃圾桶即可移入，移入后可以恢复到书库。</p>
                </>
              ) : total === 0 ? (
                <>
                  <h2>库里还没有论文</h2>
                  <p>
                    点右上「＋ 导入 PDF / EPUB」选择本地文件，或从每日推荐卡片一键导入公开全文。
                    <br />
                    导入时会先识别题目、作者、期刊/会议与中文题名，并完成全文翻译再入库。
                  </p>
                  <button
                    type="button"
                    onClick={onOpenImport}
                    className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-surface shadow-sm transition hover:brightness-105"
                  >
                    导入 PDF / EPUB
                  </button>
                </>
              ) : (
                <>
                  <h2>没有符合条件的文档</h2>
                  <p>调整搜索或清空书架/标签筛选后再看。</p>
                </>
              )}
            </div>
          ) : null}

          {view === 'shelves' && phase.kind === 'ready' ? (
            <ShelfOverview
              documents={documents}
              categories={meta.categories}
              meta={meta.items}
              selectedId={selectedId}
              onSelect={onOpenDocument}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={toggleTrash}
              onSetShelves={(key, categories) => meta.patch(key, { categories })}
            />
          ) : null}

          {view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'grid' ? (
            <div className="book-grid">
              {documents.map((doc) => (
                <LibraryCard
                  key={doc.id}
                  doc={doc}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === selectedId}
                  onSelect={() => onOpenDocument(doc.id)}
                  onOpenReproduction={onOpenReproduction}
                  onToggleTrash={() => toggleTrash(doc.key)}
                  onSetShelves={(categories) => meta.patch(doc.key, { categories })}
                />
              ))}
            </div>
          ) : null}

          {view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'list' ? (
            <ul className="flex flex-col gap-1.5">
              {documents.map((doc) => (
                <ListRow
                  key={doc.id}
                  doc={doc}
                  meta={meta.items[doc.key]}
                  categories={meta.categories}
                  selected={doc.id === selectedId}
                  onSelect={() => onOpenDocument(doc.id)}
                  onOpenReproduction={onOpenReproduction}
                  onToggleFavorite={() => void meta.patch(doc.key, { favorite: !meta.items[doc.key]?.favorite }).catch(() => undefined)}
                  onToggleTrash={() => toggleTrash(doc.key)}
                />
              ))}
            </ul>
          ) : null}

          {view !== 'shelves' && phase.kind === 'ready' && documents.length > 0 && layout === 'table' ? (
            <DocumentTable
              documents={documents}
              meta={meta.items}
              selectedId={selectedId}
              sort={sort}
              onSort={toggleSort}
              onSelect={onOpenDocument}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={toggleTrash}
            />
          ) : null}

          {duplicates.length > 0 ? (
            <p className="mt-4 rounded-lg bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
              检测到 {duplicates.length} 组疑似重复（arXiv 号 / DOI / 标题+作者）。仅提示，不自动合并——逐篇核对后再手动取舍。
            </p>
          ) : null}
        </div>
      </section>

      {dailyOpen ? (
        <>
          <ResizeHandle
            label="每日推荐栏宽度"
            value={dailyWidth}
            onStart={() => {
              const start = dailyWidth;
              return (delta: number) => setDailyWidth(Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, start - delta)));
            }}
            onStep={(delta: number) => setDailyWidth((value) => Math.min(DAILY_MAX_WIDTH, Math.max(DAILY_MIN_WIDTH, value - delta)))}
            onReset={() => setDailyWidth(DAILY_DEFAULT_WIDTH)}
          />
          <aside className="daily-sidebar" style={{ width: dailyWidth }} aria-label="每日论文推荐">
            <header className="daily-sidebar-head">
              <span className="flex items-center gap-2 truncate text-[14px] font-semibold text-ink"><WorkspaceIcon name="sparkles" size={17} />每日论文推荐</span>
              <button
                type="button"
                onClick={() => setDailyOpen(false)}
                className="rounded-md border border-line px-2 py-0.5 text-[11px] text-ink-soft transition hover:text-ink"
                title="收起每日推荐侧栏"
              >
                »
              </button>
            </header>
            <div className="daily-sidebar-body">
              <DailyRecommendations documents={rawDocuments} onReload={onReload} embedded />
            </div>
          </aside>
        </>
      ) : null}
      {emptyTrashKeys ? <EmptyTrashDialog keysToDelete={emptyTrashKeys} onClose={() => setEmptyTrashKeys(null)} onCleared={async () => { setEmptyTrashKeys(null); onTrashEmptied(); await meta.reload(); }} /> : null}
    </div>
  );
}

function ShelfOverview({
  documents, categories, meta, selectedId, onSelect, onOpenReproduction, onToggleTrash, onSetShelves,
}: {
  documents: DocumentSummary[];
  categories: Category[];
  meta: Record<string, DocumentMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenReproduction: (key: string) => void;
  onToggleTrash: (key: string) => Promise<unknown>;
  onSetShelves: (key: string, categories: string[]) => Promise<unknown>;
}) {
  const groups = categories.map((shelf) => ({
    name: shelf.name,
    color: shelf.color,
    docs: documents.filter((doc) => (meta[doc.key]?.categories ?? []).includes(shelf.name)),
  }));
  const unassigned = documents.filter((doc) => !(meta[doc.key]?.categories ?? []).some((name) => categories.some((shelf) => shelf.name === name)));
  if (unassigned.length || !groups.length) groups.push({ name: '未归入书架', color: 'slate', docs: unassigned });
  const visibleGroups = groups.filter((group) => group.docs.length > 0 || group.name !== '未归入书架');

  if (!documents.length) return <div className="empty-state"><h2>书架里还没有论文</h2><p>在全部文档中给论文选择所属书架，按研究领域整理阅读。</p></div>;

  return (
    <div className="space-y-5">
      {!categories.length ? <p className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">先在左侧点击「+ 新建书架」，再用论文卡片上的「归入书架」整理同领域论文。</p> : null}
      {visibleGroups.map((shelf) => (
        <section key={shelf.name} className="rounded-xl border border-line bg-surface p-3">
          <header className="mb-3 flex items-center gap-2">
            <span className="ann-color-dot" style={{ background: categoryDot(shelf.color) }} />
            <h2 className="text-sm font-semibold text-ink">{shelf.name}</h2>
            <span className="rounded-pill bg-surface-sunk px-2 py-0.5 text-[10px] text-ink-soft">{shelf.docs.length} 篇</span>
            {shelf.name === '未归入书架' ? <span className="text-[10px] text-ink-faint">可从卡片快速归类</span> : null}
          </header>
          {shelf.docs.length ? <div className="book-grid">
            {shelf.docs.map((doc) => <LibraryCard
              key={`${shelf.name}-${doc.id}`}
              doc={doc}
              meta={meta[doc.key]}
              categories={categories}
              selected={doc.id === selectedId}
              onSelect={() => onSelect(doc.id)}
              onOpenReproduction={onOpenReproduction}
              onToggleTrash={() => onToggleTrash(doc.key)}
              onSetShelves={(names) => onSetShelves(doc.key, names)}
            />)}
          </div> : <p className="text-xs text-ink-faint">这个书架还没有论文，可以在全部文档卡片上选择该书架。</p>}
        </section>
      ))}
    </div>
  );
}

function ListRow({
  doc,
  meta,
  categories,
  selected,
  onSelect,
  onOpenReproduction,
  onToggleFavorite,
  onToggleTrash,
}: {
  doc: DocumentSummary;
  meta: DocumentMeta | undefined;
  categories: Category[];
  selected: boolean;
  onSelect: () => void;
  onOpenReproduction: (key: string) => void;
  onToggleFavorite: () => void;
  onToggleTrash: () => Promise<unknown>;
}) {
  const tone = STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft';
  return (
    <li
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 transition ${selected ? 'border-accent/40 bg-accent-soft/60' : 'border-line hover:bg-surface-sunk'}`}
    >
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[13px] font-medium text-ink">{doc.title || '（无标题）'}</p>
        {doc.translatedTitle && <p className="truncate text-xs text-ink-faint">{doc.translatedTitle}</p>}
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span className={`rounded-pill px-1.5 py-0.5 font-medium ${tone}`}>{statusLabel(doc.status)}</span>
          <span className="truncate">{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}{doc.year ? ` · ${doc.year}` : ''}</span>
        </p>
        {meta?.categories.length ? (
          <p className="mt-1 flex flex-wrap gap-1">
            {meta.categories.map((name) => {
              const definition = categories.find((item) => item.name === name);
              return (
                <span key={name} className="flex items-center gap-1 rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft">
                  <span className="ann-color-dot" style={{ background: categoryDot(definition?.color ?? 'slate') }} />
                  {name}
                </span>
              );
            })}
          </p>
        ) : null}
      </button>
      <span className="flex shrink-0 items-center gap-1 text-[11px]">
        <button type="button" onClick={onToggleFavorite} className={meta?.favorite ? 'text-accent' : 'text-ink-faint hover:text-ink'}>
          {meta?.favorite ? '★' : '☆'}
        </button>
        <button type="button" onClick={() => onOpenReproduction(doc.key)} className="text-ink-faint hover:text-accent">
          复现
        </button>
        <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(meta?.deleted)} onToggle={onToggleTrash} />
      </span>
    </li>
  );
}

function DocumentTable({
  documents,
  meta,
  selectedId,
  sort,
  onSort,
  onSelect,
  onOpenReproduction,
  onToggleTrash,
}: {
  documents: DocumentSummary[];
  meta: Record<string, DocumentMeta>;
  selectedId: string | null;
  sort: { key: SortKey; reverse: boolean };
  onSort: (key: SortKey) => void;
  onSelect: (id: string) => void;
  onOpenReproduction: (key: string) => void;
  onToggleTrash: (key: string) => Promise<unknown>;
}) {
  const arrow = (key: SortKey) => (sort.key === key ? (sort.reverse ? ' ↓' : ' ↑') : '');
  return (
    <table className="w-full border-collapse text-left text-[12px]">
      <thead>
        <tr className="border-b border-line text-[11px] text-ink-faint">
          <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('title')}>标题{arrow('title')}</th>
          <th className="px-2 py-2 font-medium">作者</th>
          <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('year')}>年份{arrow('year')}</th>
          <th className="cursor-pointer px-2 py-2 font-medium hover:text-ink" onClick={() => onSort('status')}>状态{arrow('status')}</th>
          <th className="px-2 py-2 font-medium">书架</th>
          <th className="px-2 py-2 font-medium" />
        </tr>
      </thead>
      <tbody>
        {documents.map((doc) => {
          const item = meta[doc.key];
          return (
            <tr
              key={doc.id}
              className={`border-b border-line/60 align-top transition ${doc.id === selectedId ? 'bg-accent-soft/50' : 'hover:bg-surface-sunk'}`}
            >
              <td className="px-2 py-2">
                <button type="button" onClick={() => onSelect(doc.id)} className="text-left font-medium text-ink hover:text-accent">
                  {item?.favorite ? <span className="mr-1 text-accent">★</span> : null}
                  {doc.title || '（无标题）'}
                  {doc.translatedTitle && <small className="block text-ink-faint">{doc.translatedTitle}</small>}
                </button>
              </td>
              <td className="px-2 py-2 text-ink-soft">{doc.authors[0] ?? '作者未知'}{doc.authors.length > 1 ? ' 等' : ''}</td>
              <td className="px-2 py-2 tabular-nums text-ink-soft">{doc.year ?? '—'}</td>
              <td className="px-2 py-2">
                <span className={`rounded-pill px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[doc.status] ?? 'bg-surface-sunk text-ink-soft'}`}>
                  {statusLabel(doc.status)}
                </span>
              </td>
              <td className="px-2 py-2">
                {(item?.categories ?? []).length ? (
                  <span className="flex flex-wrap gap-1">
                    {(item?.categories ?? []).map((name) => (
                      <span key={name} className="rounded-pill bg-surface-sunk px-1.5 py-0.5 text-[10px] text-ink-soft">{name}</span>
                    ))}
                  </span>
                ) : (
                  <span className="text-ink-faint">—</span>
                )}
              </td>
              <td className="px-2 py-2">
                <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenReproduction(doc.key)}
                  className="rounded-md border border-line bg-surface px-2 py-0.5 text-[10px] text-ink-soft transition hover:border-accent hover:text-accent"
                >
                  复现
                </button>
                <LibraryTrashButton title={doc.title || doc.key} deleted={Boolean(item?.deleted)} onToggle={() => onToggleTrash(doc.key)} />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CategoryManager({ meta, onDone }: { meta: ReturnType<typeof useLibraryMeta>; onDone: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(CATEGORY_COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await meta.upsertCategory(name.trim(), color);
      setName('');
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2 rounded-lg border border-line bg-surface-sunk/50 px-2 py-2">
      <div className="flex items-center gap-1">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create();
          }}
          placeholder="领域书架名称（如：图像重建）"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-[12px] focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !name.trim()}
          className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-surface disabled:opacity-40"
        >
          添加
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1">
        {CATEGORY_COLORS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setColor(value)}
            aria-label={categoryLabel(value)}
            title={categoryLabel(value)}
            className={`ann-color-choice${color === value ? ' ann-color-current' : ''}`}
          >
            <span className="ann-color-dot" style={{ background: categoryDot(value) }} />
          </button>
        ))}
      </div>
      {meta.categories.length ? (
        <ul className="mt-1.5 space-y-1">
          {meta.categories.map((item) => (
            <li key={item.name} className="flex items-center gap-1.5 text-[11px]">
              <span className="ann-color-dot" style={{ background: categoryDot(item.color) }} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void meta.deleteCategory(item.name).catch(() => undefined)}
                className="text-ink-faint hover:text-bad"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-1 text-[11px] text-bad">{error}</p> : null}
      <button type="button" onClick={onDone} className="mt-1 text-[11px] text-ink-faint underline">
        完成
      </button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="book-grid">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div key={index}>
          <div className="h-[263px] animate-pulse rounded-[7px] bg-surface-sunk" />
          <div className="mt-3 h-3 w-3/4 animate-pulse rounded bg-surface-sunk" />
        </div>
      ))}
    </div>
  );
}
