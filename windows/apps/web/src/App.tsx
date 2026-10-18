import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
const ReaderScreen = lazy(() => import('./components/ReaderScreen').then((module) => ({ default: module.ReaderScreen })));
const ReproductionSection = lazy(() => import('./components/ReproductionSection').then((module) => ({ default: module.ReproductionSection })));
import { LibraryScreen } from './components/LibraryScreen';
const KnowledgeGraphSection = lazy(() => import('./components/KnowledgeGraphSection').then((module) => ({ default: module.KnowledgeGraphSection })));
const ReadingCalendarSection = lazy(() => import('./components/ReadingCalendarSection').then((module) => ({ default: module.ReadingCalendarSection })));
import { useAnnotations } from './hooks/useAnnotations';
import { useDocument } from './hooks/useDocument';
import { useLibraryMeta } from './hooks/useLibraryMeta';
import { useTheme } from './hooks/useTheme';
import { useWorkspace } from './hooks/useWorkspace';
import { WorkspaceIcon } from './components/WorkspaceIcon';
const ImportDialog = lazy(() => import('./components/ImportDialog').then((module) => ({ default: module.ImportDialog })));
const AISettingsDialog = lazy(() => import('./components/AISettingsDialog').then((module) => ({ default: module.AISettingsDialog })));

/**
 * 视觉版式 v2（对齐 cynicalight/reader 的布局结构，token 映射到本仓库暖色系）：
 *
 *   书库   LibraryScreen   左侧边栏 + 封面网格/列表/表格（全屏，无边框工作区）
 *   阅读   ReaderScreen    顶部工具栏 + 左目录 + 原文·译文双栏（可切单栏/交换）
 *   图谱   KnowledgeGraphSection  概念 / 方法 / 结论 连成网络，跨文献合并，每条关系回到原文依据
 *   复现   ReproductionSection  分析校验 + 五组核对项 + R-11 仓库核对
 *
 * 书库点封面 → 进入阅读页（selected 决定）；阅读页「←」回书库。
 * 知识图谱/复现是独立入口，从书库侧栏进入。
 */
export default function App() {
  const {
    phase,
    allDocuments,
    filters,
    setFilters,
    reload,
  } = useWorkspace();
  const [screen, setScreen] = useState<
    'library' | 'reader' | 'graph' | 'reproduction' | 'calendar'
  >('library');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryView, setLibraryView] = useState<'all' | 'favorite' | 'trash' | 'shelves'>(
    'all',
  );

  // documents 只用于书库列表渲染（跟随搜索/筛选）；跨页跳转必须用不受筛选影响的全集，
  // 否则搜索状态下从图谱点「原文依据」会找不到目标论文、继续用上一篇的 selectedId。
  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const navigationDocuments = useMemo(
    () => (allDocuments.length ? allDocuments : documents),
    [allDocuments, documents],
  );
  const selected = useMemo(
    () => navigationDocuments.find((doc) => doc.id === selectedId) ?? null,
    [navigationDocuments, selectedId],
  );
  const detail = useDocument(
    screen === 'reader' ? (selected?.key ?? null) : null,
  );
  const annotations = useAnnotations(
    screen === 'reader' ? (selected?.key ?? null) : null,
  );
  const libraryMeta = useLibraryMeta();
  const theme = useTheme();
  // 后端从「未连接」变为「已连接」时重取库元数据：首次请求可能在 token 注入前发出并留下错误。
  const [page, setPage] = useState<number | null>(null);
  const [cite, setCite] = useState<{ page: number; nonce: number } | null>(
    null,
  );
  const [focusedAnnotationId, setFocusedAnnotationId] = useState<string | null>(
    null,
  );
  const lastScreen = useRef<string>('library');

  const pages =
    detail.phase.kind === 'ready'
      ? detail.phase.detail.pages.map((item) => item.page)
      : [];

  useEffect(() => {
    // pages 只列出已缓存文本页，阅读位置可能指向尚未索引的有效 PDF 页。
    // 只在页面尚未初始化时选首个缓存页，不用缓存列表把恢复位置弹回第一页。
    if (pages.length) setPage((current) => current ?? pages[0] ?? null);
  }, [pages.join(',')]);

  // 离开阅读页时把出处焦点清掉，回来不残留上次的闪烁。
  useEffect(() => {
    if (screen !== 'reader' && lastScreen.current === 'reader') setCite(null);
    lastScreen.current = screen;
  }, [screen]);



  const citePage = useCallback((target: number) => {
    setPage(target);
    setCite((current) => ({ page: target, nonce: (current?.nonce ?? 0) + 1 }));
  }, []);

  // 图谱里点某条关系的原文依据：选定该文献 → 进阅读页 → 跳到那一页并闪一下出处。
  const citeInDocument = useCallback(
    (target: { key: string; page: number }) => {
      const doc = navigationDocuments.find((item) => item.key === target.key);
      if (doc) setSelectedId(doc.id);
      setPage(target.page);
      setCite((current) => ({ page: target.page, nonce: (current?.nonce ?? 0) + 1 }));
      setScreen('reader');
    },
    [navigationDocuments],
  );

  const focusAnnotation = useCallback(
    (id: string, page: number | null) => {
      setFocusedAnnotationId(id);
      if (page != null) citePage(page);
    },
    [citePage],
  );

  const openDocument = useCallback((id: string) => {
    setPage(null);
    setCite(null);
    setFocusedAnnotationId(null);
    setSelectedId(id);
    setScreen('reader');
  }, []);

  const openReproduction = useCallback(
    (key: string) => {
      const target = navigationDocuments.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
      setScreen('reproduction');
    },
    [navigationDocuments],
  );

  const pickForReproduction = useCallback(
    (key: string) => {
      const target = navigationDocuments.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
    },
    [navigationDocuments],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          setImportFiles(Array.from(event.dataTransfer.files));
        }
      }}
    >
      <HeaderBar
        phase={phase}
        screen={screen}
        onScreen={setScreen}
        onReload={reload}
        onImport={() => setImportFiles([])}
        theme={theme.choice}
        onThemeChange={theme.setTheme}
      />

      <Suspense fallback={<p className="p-6" role="status">加载中…</p>}>
      {screen === 'library' ? (
        <LibraryScreen
          phase={phase}
          allDocuments={navigationDocuments}
          filters={filters}
          setFilters={setFilters}
          selectedId={selectedId}
          onOpenDocument={openDocument}
          onOpenImport={() => setImportFiles([])}
          onOpenSettings={() => setSettingsOpen(true)}
          meta={libraryMeta}
          view={libraryView}
          onViewChange={(view) => {
            if (view === 'all' || view === 'favorite' || view === 'trash' || view === 'shelves')
              setLibraryView(view);
            setScreen(
              view === 'graph'
                ? 'graph'
                : view === 'calendar'
                  ? 'calendar'
                  : 'library',
            );
          }}
          onOpenReproduction={openReproduction}
          onTrashEmptied={() => { setSelectedId(null); reload(); }}
          onReload={reload}
        />
      ) : screen === 'reader' ? (
        <ReaderScreen
          key={selected?.id ?? 'empty'}
          detail={detail.phase}
          selected={selected}
          page={page}
          onPage={setPage}
          onBack={() => setScreen('library')}
          cite={cite}
          onCite={citePage}
          annotations={annotations}
          onFocusAnnotation={focusAnnotation}
          focusedAnnotationId={focusedAnnotationId}
          onOpenAISettings={() => setSettingsOpen(true)}
        />
      ) : screen === 'graph' ? (
        <KnowledgeGraphSection
          phase={phase}
          documents={navigationDocuments}
          onBack={() => setScreen('library')}
          onCite={citeInDocument}
        />
      ) : screen === 'calendar' ? (
        <ReadingCalendarSection
          phase={phase}
          documents={navigationDocuments}
          onBack={() => setScreen('library')}
          onOpenDocument={openDocument}
        />
      ) : (
        <ReproductionSection
          document={selected}
          documents={navigationDocuments}
          onPick={pickForReproduction}
          onBack={() => setScreen('library')}
        />
      )}

      </Suspense>
      {/* 对话框各自一个边界：首次加载 chunk 时只让弹窗区域回退，绝不卸载整页
          （否则滚动位置、面板本地状态与已发出的列表请求都会重来一遍）。 */}
      {importFiles !== null && (
        <Suspense fallback={null}>
          <ImportDialog
            files={importFiles}
            onClose={() => setImportFiles(null)}
            onImported={reload}
            onOpenDocument={openDocument}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <AISettingsDialog onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {phase.kind === 'error' ? (
        <footer className="shrink-0 border-t border-bad/30 bg-bad/5 px-5 py-2">
          <p className="text-[12px] leading-relaxed text-bad">
            {phase.message}
            <span className="mx-2 text-line-strong">|</span>
            {phase.hint}
          </p>
        </footer>
      ) : null}
    </div>
  );
}

/**
 * 全局工作区导航：书库、图谱、日历、主题与导入入口在各页面保持一致。
 */
function HeaderBar({
  phase,
  screen,
  onScreen,
  onReload,
  onImport,
  theme,
  onThemeChange,
}: {
  phase: ReturnType<typeof useWorkspace>['phase'];
  screen: 'library' | 'reader' | 'graph' | 'reproduction' | 'calendar';
  onScreen: (screen: 'library' | 'reader' | 'graph' | 'reproduction' | 'calendar') => void;
  onReload: () => void;
  onImport: () => void;
  theme: string;
  onThemeChange: (theme: 'light' | 'dark' | 'paper' | 'system') => void;
}) {
  const ready = phase.kind === 'ready';
  return (
    <header className="app-header">
      <button type="button" className="app-brand" onClick={() => onScreen('library')} aria-label="ReadX，返回书库">
        <span className="brand-mark" aria-hidden="true">◈</span><span>ReadX</span>
      </button>
      <nav className="app-navigation" aria-label="工作区导航">
      <button
        type="button"
        onClick={() => onScreen('library')}
        aria-current={screen === 'library' || screen === 'reader' ? 'page' : undefined}
        className={screen === 'library' || screen === 'reader' ? 'active' : ''}
      >
        <WorkspaceIcon name="library" size={16} /><span>书库</span>
      </button>
      <button
        type="button"
        onClick={() => onScreen('graph')}
        aria-current={screen === 'graph' ? 'page' : undefined}
        className={screen === 'graph' ? 'active' : ''}
      >
        <WorkspaceIcon name="graph" size={16} /><span>图谱</span>
      </button>
      <button
        type="button"
        onClick={() => onScreen('calendar')}
        aria-current={screen === 'calendar' ? 'page' : undefined}
        className={screen === 'calendar' ? 'active' : ''}
      >
        <WorkspaceIcon name="calendar" size={16} /><span>日历</span>
      </button>
      </nav>
      <div className="app-header-actions">
        <div className="theme-switch" role="group" aria-label="界面主题">
          {(['light', 'dark', 'paper', 'system'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onThemeChange(item)}
              aria-pressed={theme === item}
              className={theme === item ? 'active' : ''}
            >
              {
                {
                  light: '浅色',
                  dark: '深色',
                  paper: '纸张',
                  system: '跟随系统',
                }[item]
              }
            </button>
          ))}
        </div>
        <select className="theme-select" aria-label="界面主题" value={theme} onChange={event => onThemeChange(event.target.value as 'light' | 'dark' | 'paper' | 'system')}>
          <option value="light">浅色</option><option value="dark">深色</option><option value="paper">纸张</option><option value="system">跟随系统</option>
        </select>
        <button
          type="button"
          onClick={onReload}
          className={`connection-button${ready ? ' ready' : ''}`}
          title={ready ? '后端已连接，点按重连' : '后端未连接，点按重试'}
        >
          <span aria-hidden="true" />{ready ? '已连接' : '未连接 · 重试'}
        </button>
        <button type="button" className="primary-button global-import" onClick={onImport}>
          <span>＋ 导入 PDF / EPUB</span>
        </button>
      </div>
    </header>
  );
}
