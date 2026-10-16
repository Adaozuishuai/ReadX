import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
const ReaderScreen = lazy(() => import('./components/ReaderScreen').then((module) => ({ default: module.ReaderScreen })));
const ReproductionSection = lazy(() => import('./components/ReproductionSection').then((module) => ({ default: module.ReproductionSection })));
import { LibraryScreen } from './components/LibraryScreen';
const TrendsSection = lazy(() => import('./components/TrendsSection').then((module) => ({ default: module.TrendsSection })));
import { useAnnotations } from './hooks/useAnnotations';
import { useDocument } from './hooks/useDocument';
import { useLibraryMeta } from './hooks/useLibraryMeta';
import { useTheme } from './hooks/useTheme';
import { useWorkspace } from './hooks/useWorkspace';
const ImportDialog = lazy(() => import('./components/ImportDialog').then((module) => ({ default: module.ImportDialog })));
const AISettingsDialog = lazy(() => import('./components/AISettingsDialog').then((module) => ({ default: module.AISettingsDialog })));

/**
 * 视觉版式 v2（对齐 cynicalight/reader 的布局结构，token 映射到本仓库暖色系）：
 *
 *   书库   LibraryScreen   左侧边栏 + 封面网格/列表/表格（全屏，无边框工作区）
 *   阅读   ReaderScreen    顶部工具栏 + 左目录 + 原文·译文双栏（可切单栏/交换）
 *   趋势   TrendsSection   按系统标签聚合 + 想法工作流
 *   复现   ReproductionSection  分析校验 + 五组核对项 + R-11 仓库核对
 *
 * 书库点封面 → 进入阅读页（selected 决定）；阅读页「←」回书库。
 * 趋势/复现是独立入口，从书库侧栏或封面卡上的按钮进入。
 */
export default function App() {
  const {
    phase,
    filters,
    setFilters,
    reload,
    importing,
    importError,
    runImport,
  } = useWorkspace();
  const [screen, setScreen] = useState<
    'library' | 'reader' | 'trends' | 'reproduction'
  >('library');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [libraryView, setLibraryView] = useState<'all' | 'favorite' | 'trash'>(
    'all',
  );

  const documents = phase.kind === 'ready' ? phase.documents.documents : [];
  const selected = useMemo(
    () => documents.find((doc) => doc.id === selectedId) ?? null,
    [documents, selectedId],
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
      const target = documents.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
      setScreen('reproduction');
    },
    [documents],
  );

  const pickForReproduction = useCallback(
    (key: string) => {
      const target = documents.find((doc) => doc.key === key);
      if (target) setSelectedId(target.id);
    },
    [documents],
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
      <div className="global-document-actions">
        <button onClick={() => setImportFiles([])}>＋ 导入 PDF / EPUB</button>
        <button onClick={() => setSettingsOpen(true)}>AI 设置</button>
      </div>
      <HeaderBar
        phase={phase}
        screen={screen}
        onScreen={setScreen}
        onReload={reload}
        theme={theme.choice}
        onThemeChange={theme.setTheme}
      />

      <Suspense fallback={<p className="p-6" role="status">加载中…</p>}>
      {screen === 'library' ? (
        <LibraryScreen
          phase={phase}
          filters={filters}
          setFilters={setFilters}
          selectedId={selectedId}
          onOpenDocument={openDocument}
          importing={importing}
          importError={importError}
          runImport={runImport}
          meta={libraryMeta}
          view={libraryView}
          onViewChange={(view) => {
            if (view === 'all' || view === 'favorite' || view === 'trash')
              setLibraryView(view);
            setScreen(
              view === 'trends'
                ? 'trends'
                : view === 'reproduction'
                  ? 'reproduction'
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
        />
      ) : screen === 'trends' ? (
        <TrendsSection phase={phase} onBack={() => setScreen('library')} />
      ) : (
        <ReproductionSection
          document={selected}
          documents={documents}
          onPick={pickForReproduction}
          onBack={() => setScreen('library')}
        />
      )}

      {importFiles !== null && (
        <ImportDialog
          files={importFiles}
          onClose={() => setImportFiles(null)}
          onImported={reload}
        />
      )}
      {settingsOpen && (
        <AISettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
      </Suspense>
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
 * 顶栏：参考实现没有全局顶栏（导航在书库侧栏里），这里保留一条极细的状态条——
 * 连接状态与主题切换是本仓库的既有能力，用户在阅读页也需要够到主题。
 */
function HeaderBar({
  phase,
  screen,
  onScreen,
  onReload,
  theme,
  onThemeChange,
}: {
  phase: ReturnType<typeof useWorkspace>['phase'];
  screen: 'library' | 'reader' | 'trends' | 'reproduction';
  onScreen: (screen: 'library' | 'reader' | 'trends' | 'reproduction') => void;
  onReload: () => void;
  theme: string;
  onThemeChange: (theme: 'light' | 'dark' | 'paper' | 'system') => void;
}) {
  const ready = phase.kind === 'ready';
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 text-[11px]">
      <button
        type="button"
        onClick={() => onScreen('library')}
        className={
          screen === 'library'
            ? 'font-medium text-ink'
            : 'text-ink-faint hover:text-ink'
        }
      >
        书库
      </button>
      <button
        type="button"
        onClick={() => onScreen('trends')}
        className={
          screen === 'trends'
            ? 'font-medium text-ink'
            : 'text-ink-faint hover:text-ink'
        }
      >
        趋势
      </button>
      <button
        type="button"
        onClick={() => onScreen('reproduction')}
        className={
          screen === 'reproduction'
            ? 'font-medium text-ink'
            : 'text-ink-faint hover:text-ink'
        }
      >
        复现
      </button>
      <span className="ml-auto flex items-center gap-2">
        <span className="flex items-center gap-0.5 rounded-pill bg-surface-sunk p-0.5">
          {(['light', 'dark', 'paper', 'system'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onThemeChange(item)}
              aria-pressed={theme === item}
              className={`rounded-pill px-1.5 py-0.5 text-[10px] transition ${theme === item ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-faint hover:text-ink'}`}
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
        </span>
        <button
          type="button"
          onClick={onReload}
          className={[
            'rounded-pill px-2 py-0.5 font-medium transition',
            ready ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad',
          ].join(' ')}
          title={ready ? '后端已连接，点按重连' : '后端未连接，点按重试'}
        >
          {ready ? '已连接' : '未连接 · 重试'}
        </button>
      </span>
    </header>
  );
}
