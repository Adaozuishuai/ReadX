import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary, PDFLayout } from '@cbct/shared';
import { pageParagraphs, segmentParagraph, statusLabel } from '@cbct/shared';
import { api, type EPUBSection } from '../api/client';
import type { DocumentPhase } from '../hooks/useDocument';
import { AssistantSidebar, type AssistantTab } from './AssistantPanels';
import type { useAnnotations } from '../hooks/useAnnotations';
import { PDFPage, usePDF, type PendingSelection } from './PDFView';
import { layoutFromPDF } from '../api/pdfLayout';
import { ResizeHandle } from './ResizeHandle';
import { EPUBView } from './EPUBView';
import { ParagraphActions, type SelectedParagraph, type ParagraphQuestion } from './ParagraphActions';
import { PrintedTranslation } from './PrintedTranslation';
import { ExportPDFDialog } from './ExportPDFDialog';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type ReadingMode = 'source' | 'parallel' | 'translation';

interface Props {
  detail: DocumentPhase;
  selected: DocumentSummary | null;
  page: number | null;
  onPage: (page: number) => void;
  onBack: () => void;
  cite: { page: number; nonce: number } | null;
  onCite: (page: number) => void;
  annotations: ReturnType<typeof useAnnotations>;
  onFocusAnnotation: (id: string, page: number | null) => void;
  focusedAnnotationId: string | null;
  onOpenAISettings: () => void;
}

export function ReaderScreen({
  detail,
  selected,
  page,
  onPage,
  onBack,
  cite,
  onCite,
  annotations,
  onFocusAnnotation,
  focusedAnnotationId,
  onOpenAISettings,
}: Props) {
  const epub = selected?.format === 'epub';
  const documentKey = selected?.key ?? null;
  const pdf = usePDF(!epub ? documentKey : null);
  const [mode, setMode] = useState<ReadingMode>('source');
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1000);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth >= 1200);
  const [tab, setTab] = useState<AssistantTab>('chat');
  const [swapped, setSwapped] = useState(false);
  const [divider, setDivider] = useState(50);
  const [leftWidth, setLeftWidth] = useState(() => readPanelWidth('toc', 220));
  const [rightWidth, setRightWidth] = useState(() => readPanelWidth('assistant', 440));
  const [panelSpace, setPanelSpace] = useState(window.innerWidth);
  const panelRoot = useRef<HTMLDivElement>(null);
  const [headingTarget, setHeadingTarget] = useState<{ page: number; y: number; nonce: number } | null>(null);
  useEffect(() => {
    if (!panelRoot.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setPanelSpace(entry.contentRect.width); });
    observer.observe(panelRoot.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try { localStorage.setItem('cbct.reader.panels', JSON.stringify({ toc: leftWidth, assistant: rightWidth })); } catch { /* Storage may be disabled. */ }
  }, [leftWidth, rightWidth]);
  const desiredLeft = leftOpen ? leftWidth : 0;
  const desiredRight = rightOpen ? rightWidth : 0;
  const panelScale = Math.min(1, Math.max(0, panelSpace - 252) / (desiredLeft + desiredRight || 1));
  const visibleLeft = desiredLeft * panelScale;
  const visibleRight = desiredRight * panelScale;
  const resizeLeft = (value: number) => {
    const next = Math.max(0, Math.min(value, panelSpace - visibleRight - 252));
    setLeftOpen(next >= 48);
    if (next >= 48) setLeftWidth(next);
  };
  const resizeRight = (value: number) => {
    const next = Math.max(0, Math.min(value, panelSpace - visibleLeft - 252));
    setRightOpen(next >= 48);
    if (next >= 48) setRightWidth(next);
  };
  const dragCleanup = useRef<(() => void) | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [pdfLayout, setPDFLayout] = useState<PDFLayout | null>(null);
  const [section, setSection] = useState<EPUBSection | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [selectedParagraph, setSelectedParagraph] = useState<SelectedParagraph | null>(null);
  const [paragraphQuestion, setParagraphQuestion] = useState<ParagraphQuestion | null>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [color, setColor] = useState('amber');
  const [saving, setSaving] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const panes = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  // 导出保留排版的译文 PDF（文本层 PDF 用 rpr 引擎，扫描件走 PaddleOCR）。
  const [exportOpen, setExportOpen] = useState(false);
  // 导入时生成了 OCR 版式数据的文档：译文窗格自动显示排版译文，不再走文本层分段。
  const [layoutPages, setLayoutPages] = useState(0);
  const layoutMode = layoutPages > 0;
  // 由外部出处（图谱证据 / 批注）驱动跳转时置位：不让「恢复上次阅读位置」抢走目标页。
  const citeTakeover = useRef(false);
  const [locationReady, setLocationReady] = useState(false);
  const sections =
    detail.kind === 'ready' ? (detail.detail.sections ?? []) : [];
  const cachedPages =
    detail.kind === 'ready' ? detail.detail.pages.map((item) => item.page) : [];
  const count = epub
    ? sections.length
    : (pdf.document?.numPages ?? cachedPages.length);
  const current = Math.max(1, Math.min(page ?? 1, count || 1));
  const navigation = epub
    ? sections.map((item) => ({
        title: item.title,
        page: item.index,
        depth: 0,
      }))
    : pdf.outline;
  const paragraphs = useMemo(
    () =>
      epub && section
        ? section.blocks
            .filter((block) => block.text)
            .map((block) => block.text!)
        : pdfLayout ? pdfLayout.blocks.map((block) => block.text) : pageParagraphs(sourceText),
    [epub, section, sourceText, pdfLayout],
  );

  useEffect(() => {
    if (!documentKey || restored.current) return;
    restored.current = true;
    // 带着出处（cite）进来的：目标是那一页，不能被「上次读到哪」覆盖。
    // 位置请求是异步的，所以除了这里提前退出，下面的 then 里也要再挡一次。
    if (citeTakeover.current) {
      setLocationReady(true);
      return;
    }
    let cancelled = false;
    void api
      .location(documentKey)
      .then((result) => {
        if (!cancelled && !citeTakeover.current && result.location)
          onPage(
            result.location.kind === 'pdf'
              ? (result.location.page ?? 1)
              : (result.location.index ?? 1),
          );
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLocationReady(true);
      });
    return () => {
      cancelled = true;
      restored.current = false;
    };
  }, [documentKey, onPage]);
  useEffect(() => {
    if (!documentKey || !locationReady || count === 0) return;
    const chapter = sections.find((item) => item.index === current);
    const timer = setTimeout(() => {
      void api
        .saveLocation(
          documentKey,
          epub
            ? { kind: 'epub', href: chapter?.href, index: current }
            : { kind: 'pdf', page: current },
        )
        .catch((cause) => setError(`保存阅读位置失败：${String(cause)}`));
    }, 500);
    return () => clearTimeout(timer);
  }, [
    documentKey,
    current,
    epub,
    count,
    locationReady,
    sections.map((item) => item.href).join('|'),
  ]);
  useEffect(() => {
    let cancelled = false;
    setLayoutPages(0);
    if (!documentKey) return;
    void api
      .layoutStatus(documentKey)
      .then((status) => {
        if (!cancelled) setLayoutPages(status.available ? status.pages : 0);
      })
      .catch(() => {
        if (!cancelled) setLayoutPages(0);
      });
    return () => {
      cancelled = true;
    };
  }, [documentKey]);
  useEffect(() => {
    if (!cite) return;    // 标记「本次进入阅读页由出处跳转驱动」：恢复上次阅读位置的异步回填要让位给目标页。
    citeTakeover.current = true;
    setMode((value) => (value === 'translation' ? 'source' : value));
    onPage(cite.page);
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 1200);
    return () => clearTimeout(timer);
  }, [cite?.nonce, cite?.page, onPage]);
  useEffect(() => {
    setPending(null);
    setSelectedParagraph(null);
    setSourceText('');
    setPDFLayout(null);
    setSection(null);
    setError('');
    if (!documentKey) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        if (epub) {
          const chapter = await api.section(
            documentKey,
            current,
            controller.signal,
          );
          if (!cancelled) {
            setSection(chapter);
            setSourceText(chapter.text);
          }
        } else if (pdf.document) {
          const layout = await layoutFromPDF(pdf.document, current);
          if (!cancelled) {
            setPDFLayout(layout);
            setSourceText(layout.blocks.map((block) => block.text).join('\n\n'));
          }
        } else {
          const result = await api.page(
            documentKey,
            current,
            controller.signal,
          );
          if (!cancelled) setSourceText(result.text);
        }
      } catch (cause) {
        if (!cancelled && epub) setError(String(cause));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // reset is scoped to this document and position.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, current, epub, pdf.document]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPending(null);
        setSelectedParagraph(null);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const select = (value: PendingSelection) => {
    setSelectedParagraph(null);
    setPending(value);
    setNote('');
    setTags('');
    setError('');
  };
  const create = async (kind: string) => {
    if (!pending || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await annotations.create({
        ...pending.annotation,
        kind,
        color,
        note,
        tags: tags
          .split(/[,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
      });
      setPending(null);
      window.getSelection()?.removeAllRanges();
      if (result) {
        onFocusAnnotation(result.id, result.page);
        setRightOpen(true);
        setTab('notes');
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };
  const focus = (id: string, target: number | null) => {
    const item = annotations.items.find((value) => value.id === id);
    if (item?.locator?.kind === 'epub') {
      const chapter = sections.find(
        (value) => value.href === item.locator?.href,
      );
      if (chapter) onPage(chapter.index);
    }
    onFocusAnnotation(id, target);
    setMode((value) => (value === 'translation' ? 'source' : value));
    panes.current
      ?.querySelector(`[data-annotation-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const startDrag = (event: React.MouseEvent) => {
    event.preventDefault();
    const bounds = panes.current?.getBoundingClientRect();
    if (!bounds) return;
    const move = (next: MouseEvent) => {
      const ratio = Math.min(
        95,
        Math.max(5, ((next.clientX - bounds.left) / bounds.width) * 100),
      );
      setDivider(swapped ? 100 - ratio : ratio);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      dragCleanup.current = null;
    };
    dragCleanup.current?.();
    dragCleanup.current = stop;
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };
  useEffect(() => () => dragCleanup.current?.(), []);
  const source = (
    <div
      className="publication-pane"
      style={{ flex: mode === 'parallel' ? `0 0 calc((100% - 1px) * ${divider / 100})` : 1 }}
    >
      {epub ? (
        section ? (
          <EPUBView
            documentKey={documentKey!}
            section={section}
            annotations={annotations.items}
            focusedId={focusedAnnotationId}
            onSelect={select}
            paragraphMode
            onParagraph={(paragraph) => { setPending(null); setSelectedParagraph(paragraph); }}
          />
        ) : (
          <p className="p-6">{error || '加载章节…'}</p>
        )
      ) : pdf.document ? (
        <PDFPage
          document={pdf.document}
          page={current}
          annotations={annotations.items}
          focusedId={focusedAnnotationId}
          onSelect={select}
          onText={() => undefined}
          headingTarget={headingTarget}
          layout={pdfLayout}
          paragraphMode
          onParagraph={(paragraph) => { setPending(null); setSelectedParagraph(paragraph); }}
        />
      ) : (
        <div className="translation-document">
          <p className="text-bad">{pdf.error || '加载 PDF…'}</p>
          {paragraphs.map((text, index) => (
            <p key={index}>
              {segmentParagraph(
                text,
                annotations.items.filter((item) => item.page === current),
              ).map((part, n) =>
                part.annotationId ? (
                  <mark key={n} className={`ann-${part.kind}-${part.color}`}>
                    {part.text}
                  </mark>
                ) : (
                  part.text
                ),
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  );
  const translated = (
    <div
      className="publication-pane"
      style={{ flex: mode === 'parallel' ? `0 0 calc((100% - 1px) * ${(100 - divider) / 100})` : 1 }}
    >
      {layoutMode && documentKey && pdf.document ? (
        <PrintedTranslation
          documentKey={documentKey}
          pdfDocument={pdf.document}
          page={current}
          nonce={0}
        />
      ) : (
        <div className="translation-document">
          <p>
            {epub
              ? 'RetainPDF 排版译文只适用于 PDF。EPUB 请阅读原文。'
              : pdf.error
                ? pdf.error
                : '这篇文档还没有 OCR 排版译文。新文档导入后会自动生成。'}
          </p>
        </div>
      )}
    </div>
  );
  return (
    <div className="workspace-reader">
      <header className="reader-toolbar">
        <div className="reader-title-group">
          <button onClick={onBack}>← 书库</button>
          <button
            aria-pressed={leftOpen}
            onClick={() => {
              setLeftOpen((value) => !value);
              if (window.innerWidth < 1000) setRightOpen(false);
            }}
          >
            目录
          </button>
          <span className="reader-title" title={[selected?.title, selected?.translatedTitle].filter(Boolean).join('\n')}>
            {selected?.title ?? '未选择文档'}
          </span>
          <small>{selected && statusLabel(selected.status)}</small>
        </div>
        <div className="toolbar-actions">
          <span className="mode-pills">
            {(['source', 'parallel', 'translation'] as const).map((item) => (
              <button
                key={item}
                className="mode-pill"
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
              >
                {
                  {
                    source: '仅原文',
                    parallel: '原文译文',
                    translation: '仅译文',
                  }[item]
                }
              </button>
            ))}
          </span>
          {!epub && pdf.document && documentKey ? (
            <button onClick={() => setExportOpen(true)} title="生成保留原版式的译文 PDF；扫描件可用 PaddleOCR">
              导出译文 PDF
            </button>
          ) : null}
          <button
            aria-pressed={rightOpen && tab === 'chat'}
            onClick={() => {
              const shouldOpen = !rightOpen || tab !== 'chat';
              setTab('chat');
              setRightOpen(shouldOpen);
              if (shouldOpen && window.innerWidth < 1000) setLeftOpen(false);
            }}
          >
            AI 助教
          </button>
          {!epub && (
            <button
              aria-pressed={rightOpen && tab === 'reading'}
              onClick={() => {
                const shouldOpen = !rightOpen || tab !== 'reading';
                setTab('reading');
                setRightOpen(shouldOpen);
                if (shouldOpen && window.innerWidth < 1000) setLeftOpen(false);
              }}
            >
              精读五重奏
            </button>
          )}
        </div>
      </header>
      <div className="reader-panels" ref={panelRoot}>
        <aside className="reader-sidebar" data-open={leftOpen} style={{ width: visibleLeft, flexBasis: visibleLeft }}>
          <p className="panel-label">{epub ? '章节目录' : 'PDF 目录与页码'}</p>
          <div className="reader-page-nav">
            <button disabled={current <= 1} onClick={() => onPage(current - 1)}>
              上一{epub ? '章' : '页'}
            </button>
            <input
              aria-label={epub ? '章节序号' : '页码'}
              type="number"
              min={1}
              max={count || 1}
              value={current}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (value >= 1 && value <= count) onPage(value);
              }}
            />
            <span>/ {count || '—'}</span>
            <button
              disabled={current >= count}
              onClick={() => onPage(current + 1)}
            >
              下一{epub ? '章' : '页'}
            </button>
          </div>
          <div className="toc-tree">
            {navigation.length
              ? navigation.map((item, index) => (
                  <button
                    className={`toc-item${item.page === current ? ' selected' : ''}`}
                    style={{ paddingLeft: 8 + item.depth * 12 }}
                    key={index}
                    onClick={() => {
                      setHeadingTarget((previous) => ({ page: item.page, y: 'y' in item && typeof item.y === 'number' ? item.y : 0, nonce: (previous?.nonce ?? 0) + 1 }));
                      onPage(item.page);
                    }}
                  >
                    {item.title}
                  </button>
                ))
              : Array.from({ length: count }, (_, i) => (
                  <button
                    key={i}
                    className={`toc-item${i + 1 === current ? ' selected' : ''}`}
                    onClick={() => onPage(i + 1)}
                  >
                    Page {i + 1}
                  </button>
                ))}
          </div>
          {!epub && pdf.indexing && (
            <p className="p-3 text-xs text-ink-faint" role="status">
              {pdf.indexing}
            </p>
          )}
        </aside>
        <ResizeHandle label="调整目录宽度" value={visibleLeft}
          onStart={() => { const start = visibleLeft; return (delta) => resizeLeft(start + delta); }}
          onStep={(delta) => resizeLeft(visibleLeft + delta)} onReset={() => { setLeftWidth(220); setLeftOpen(true); }} />
        <div
          ref={panes}
          className={`translation-panes${flashing ? ' cite-flash' : ''}`}
        >
          {mode === 'source' ? (
            source
          ) : mode === 'translation' ? (
            translated
          ) : (
            <>
              {swapped ? translated : source}
              <div
                className="translation-divider"
                role="separator"
                aria-orientation="vertical"
                aria-valuemin={5}
                aria-valuemax={95}
                aria-valuenow={divider}
                aria-label="调整原文和译文宽度"
                tabIndex={0}
                onMouseDown={startDrag}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                  event.preventDefault();
                  const direction = event.key === 'ArrowRight' ? 2 : -2;
                  setDivider((value) => Math.min(95, Math.max(5, value + (swapped ? -direction : direction))));
                }}
              />
              {swapped ? source : translated}
              <button
                className="translation-swap"
                style={{ left: `${swapped ? 100 - divider : divider}%` }}
                onClick={() => setSwapped((value) => !value)}
                aria-label="交换原文和译文"
              >
                ⇄
              </button>
            </>
          )}
        </div>
        <ResizeHandle label="调整 AI 助教侧栏宽度" value={visibleRight}
          onStart={() => { const start = visibleRight; return (delta) => resizeRight(start - delta); }}
          onStep={(delta) => resizeRight(visibleRight - delta)} onReset={() => { setRightWidth(440); setRightOpen(true); }} />
        <aside className="assistant-sidebar" data-open={rightOpen} style={{ width: visibleRight, flexBasis: visibleRight }}>
          <AssistantSidebar
            key={documentKey}
            apiKey={documentKey}
            document={selected}
            pdfDocument={pdf.document as PDFDocumentProxy | null}
            format={epub ? 'epub' : 'pdf'}
            onCite={onCite}
            annotations={annotations}
            onFocusAnnotation={focus}
            tab={tab}
            onTabChange={setTab}
            paragraphQuestion={paragraphQuestion}
          />
        </aside>
      </div>
      {selectedParagraph && documentKey && <ParagraphActions
        key={`${current}-${selectedParagraph.index}-${selectedParagraph.text}`}
        paragraph={selectedParagraph}
        onClose={() => setSelectedParagraph(null)}
        onAsk={() => {
          setRightOpen(true);
          setTab('chat');
          setParagraphQuestion((previous) => ({ text: selectedParagraph.text, position: selectedParagraph.position, kind: selectedParagraph.kind, nonce: (previous?.nonce ?? 0) + 1 }));
          setSelectedParagraph(null);
        }}
      />}
      {error && !pending && (
        <p className="reader-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div
          role="dialog"
          aria-label="选区批注"
          className="selection-toolbar"
          style={{
            top: Math.min(pending.top + 8, window.innerHeight - 245),
            left: Math.max(8, Math.min(pending.left, window.innerWidth - 360)),
          }}
        >
          <p className="selection-quote">
            {pending.annotation.quote.slice(0, 100)}
          </p>
          <textarea
            aria-label="批注或问题"
            placeholder="批注或问题（可选）"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <input
            aria-label="批注标签"
            placeholder="标签，用逗号分隔"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
          <select
            aria-label="批注颜色"
            value={color}
            onChange={(event) => setColor(event.target.value)}
          >
            {['amber', 'rose', 'sky', 'green', 'violet'].map((item) => (
              <option key={item} value={item}>
                {
                  {
                    amber: '琥珀',
                    rose: '玫红',
                    sky: '天蓝',
                    green: '青绿',
                    violet: '紫色',
                  }[item]
                }
              </option>
            ))}
          </select>
          <div className="selection-actions">
            {(['highlight', 'underline', 'question'] as const).map((kind) => (
              <button
                key={kind}
                disabled={saving}
                onClick={() => void create(kind)}
              >
                {
                  {
                    highlight: '高亮',
                    underline: '下划线',
                    question: '问题批注',
                  }[kind]
                }
              </button>
            ))}
            <button
              onClick={() => {
                setRightOpen(true);
                setTab('chat');
                window.dispatchEvent(
                  new CustomEvent('cbct-quote', {
                    detail: {
                      key: documentKey,
                      text: `请解释选段：\n${pending.annotation.quote}\n(${epub ? 'Chapter' : 'Page'} ${current})`,
                    },
                  }),
                );
                setPending(null);
              }}
            >
              问 AI
            </button>
            <button onClick={() => setPending(null)}>关闭</button>
          </div>
          {error && (
            <p role="alert" className="text-bad">
              {error}
            </p>
          )}
        </div>
      )}
      {exportOpen && !epub && pdf.document && documentKey ? (
        <ExportPDFDialog
          documentKey={documentKey}
          document={pdf.document}
          pageCount={pdf.document.numPages}
          onClose={() => setExportOpen(false)}
          onOpenAISettings={() => { setExportOpen(false); onOpenAISettings(); }}
        />
      ) : null}
    </div>
  );
}

function readPanelWidth(name: string, fallback: number): number {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('cbct.reader.panels') ?? '{}')[name];
    return typeof value === 'number' && Number.isFinite(value) && value >= 48 && value <= 2000 ? value : fallback;
  } catch { return fallback; }
}
