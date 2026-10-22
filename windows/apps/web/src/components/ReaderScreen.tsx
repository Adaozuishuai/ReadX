import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentSummary, PDFLayout } from '@cbct/shared';
import { pageParagraphs, segmentParagraph, statusLabel } from '@cbct/shared';
import { api, type Annotation, type EPUBSection, type TranslationPreview } from '../api/client';
import type { DocumentPhase } from '../hooks/useDocument';
import { AssistantSidebar, type AssistantTab } from './AssistantPanels';
import type { useAnnotations } from '../hooks/useAnnotations';
import { PDFDocumentView, usePDF, usePDFData, type PDFFindReport, type PDFFindState, type PendingSelection } from './PDFView';
import type { LeeParagraphs } from '../api/client';
import { ResizeHandle } from './ResizeHandle';
import { EPUBView } from './EPUBView';
import { ParagraphActions, type SelectedParagraph, type ParagraphQuestion } from './ParagraphActions';
import { ExportPDFDialog } from './ExportPDFDialog';
import { CitationExportDialog } from './CitationExportDialog';
import { CitationNetworkDialog } from './CitationNetworkDialog';
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
  /** 从全文检索结果进来时带的关键词与目标页：打开查找栏并定位到那一页的命中。 */
  pendingFind?: { query: string; page: number; nonce: number } | null;
  /** 按论文键打开另一篇（引用关系里跳转用）。 */
  onOpenDocument?: (key: string) => void;
}

// Lee document.v1 的段落块直接给 PDFView 做命中测试；坐标单位与 page 宽高保持一致。
function leeLayout(paragraphs: LeeParagraphs): PDFLayout {
  return {
    width: paragraphs.width,
    height: paragraphs.height,
    blocks: paragraphs.blocks.map((block) => ({
      text: block.text,
      x: block.box[0],
      y: block.box[1],
      width: Math.max(0, block.box[2] - block.box[0]),
      height: Math.max(0, block.box[3] - block.box[1]),
      fontSize: Math.max(8, (block.box[3] - block.box[1]) * 0.8),
    })),
    visuals: (paragraphs.visuals ?? []).map((block) => ({
      text: block.text,
      x: block.box[0],
      y: block.box[1],
      width: Math.max(0, block.box[2] - block.box[0]),
      height: Math.max(0, block.box[3] - block.box[1]),
      kind: block.kind,
      label: block.text || (block.kind === 'table' ? 'OCR 表格' : block.kind === 'formula' ? 'OCR 公式' : 'OCR 图片'),
    })),
  };
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
  pendingFind = null,
  onOpenDocument,
}: Props) {
  const epub = selected?.format === 'epub';
  const documentKey = selected?.key ?? null;
  const pdf = usePDF(!epub ? documentKey : null);
  const translatedPDF = usePDF(!epub ? documentKey : null, true);
  const [liveRenderedPage, setLiveRenderedPage] = useState<ArrayBuffer | null>(null);
  const liveRenderedPDF = usePDFData(liveRenderedPage);
  const [liveTranslationPreview, setLiveTranslationPreview] = useState<TranslationPreview | null>(null);
  const [liveTranslationProgress, setLiveTranslationProgress] = useState('等待本页译文…');
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
  useEffect(() => {
    if (!panelRoot.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setPanelSpace(entry.contentRect.width); });
    observer.observe(panelRoot.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setMode('source');
  }, [documentKey]);
  useEffect(() => {
    if (!epub && translatedPDF.document) setMode('translation');
  }, [documentKey, epub, translatedPDF.document]);
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
  const [selectedNavigationIndex, setSelectedNavigationIndex] = useState<number | null>(null);
  useEffect(() => setSelectedNavigationIndex(null), [documentKey]);
  const [paragraphQuestion, setParagraphQuestion] = useState<ParagraphQuestion | null>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [color, setColor] = useState('amber');
  const [saving, setSaving] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const panes = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  // 通过 LeePDF 重新处理并获取整本译文 PDF。
  const [exportOpen, setExportOpen] = useState(false);
  // 文档内查找：命中报告由当前的「查找栏」那一栏（原文或译文）回报。
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCase, setFindCase] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [findNonce, setFindNonce] = useState(0);
  const [findReport, setFindReport] = useState<PDFFindReport>({ pages: [], scanning: null, failed: 0 });
  const findInput = useRef<HTMLInputElement>(null);
  const [citationOpen, setCitationOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
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
  useEffect(() => {
    setLiveTranslationPreview(null);
    setLiveTranslationProgress('等待本页译文…');
    if (epub || !documentKey || !pdf.document || translatedPDF.document) return;
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        while (!cancelled) {
          const result = await api.translationPreview(documentKey, current, controller.signal);
          if (cancelled) return;
          setLiveTranslationPreview(result);
          const total = result.totalBlocks ?? 0;
          const translated = result.translatedBlocks ?? 0;
          setLiveTranslationProgress(!result.available
            ? '正在等待 LeePDF 完成本页识别…'
            : total === 0
              ? '本页没有可显示的译文'
              : `本页译文 ${translated} / ${total} 段${translated < total ? '，完成内容已实时显示' : ''}`);
          if (result.available && (total === 0 || translated >= total)) return;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 1500);
            controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      } catch (cause) {
        if (!cancelled && !controller.signal.aborted) {
          setLiveTranslationProgress(`本页译文暂不可用：${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [documentKey, epub, current, pdf.document, translatedPDF.document]);
  useEffect(() => {
    setLiveRenderedPage(null);
    if (epub || !documentKey || !pdf.document || translatedPDF.document) return;
    const controller = new AbortController();
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const data = await api.translatedRenderFile(documentKey, current, controller.signal);
          if (!controller.signal.aborted) setLiveRenderedPage(data);
          return;
        } catch {
          if (controller.signal.aborted) return;
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 1200);
            controller.signal.addEventListener('abort', () => { window.clearTimeout(timer); resolve(); }, { once: true });
          });
        }
      }
    })();
    return () => controller.abort();
  }, [documentKey, epub, current, pdf.document, translatedPDF.document]);
  const [navigationRequest, setNavigationRequest] = useState<{ page: number; y?: number; viewportOffset?: number; nonce: number }>(() => ({ page: page ?? 1, nonce: 0 }));
  const [translationNavigationRequest, setTranslationNavigationRequest] = useState<{ page: number; y?: number; viewportOffset?: number; nonce: number }>(() => ({ page: page ?? 1, nonce: 0 }));
  const navigatePage = useCallback((targetPage: number, y?: number) => {
    const target = Math.max(1, Math.min(targetPage, count || targetPage));
    onPage(target);
    setNavigationRequest((previous) => ({ page: target, y, nonce: previous.nonce + 1 }));
    setTranslationNavigationRequest((previous) => ({ page: target, y, nonce: previous.nonce + 1 }));
  }, [count, onPage]);
  const navigateTranslationPage = useCallback((targetPage: number, y?: number, viewportOffset?: number) => {
    const target = Math.max(1, Math.min(targetPage, translatedPDF.document?.numPages ?? targetPage));
    onPage(target);
    setTranslationNavigationRequest((previous) => ({ page: target, y, viewportOffset, nonce: previous.nonce + 1 }));
  }, [onPage, translatedPDF.document?.numPages]);
  const navigation = epub
    ? sections.map((item) => ({
        title: item.title,
        page: item.index,
        depth: 0,
      }))
    : pdf.outline;
  const activeNavigationIndex = selectedNavigationIndex !== null && navigation[selectedNavigationIndex]?.page === current
    ? selectedNavigationIndex
    : navigation.findIndex((item) => item.page === current);
  const paragraphs = useMemo(
    () =>
      epub && section
        ? section.blocks
            .filter((block) => block.text)
            .map((block) => block.text!)
        : pdfLayout ? pdfLayout.blocks.map((block) => block.text) : pageParagraphs(sourceText),
    [epub, section, sourceText, pdfLayout],
  );

  /**
   * 查找作用在「当前正在看的那一栏」：仅译文模式下查译文，其余情况查原文。
   * 只有这一栏会拿到 onFind，另一栏不重复扫描，也就不会两边同时标黄。
   */
  const findScope: 'source' | 'translated' =
    !epub && mode === 'translation' && translatedPDF.document ? 'translated' : 'source';
  const findTotal = findReport.pages.reduce((sum, item) => sum + item.count, 0);
  const findTarget = useMemo(() => {
    if (!findTotal) return null;
    let remaining = Math.min(Math.max(findIndex, 0), findTotal - 1);
    for (const item of findReport.pages) {
      if (remaining < item.count) return { page: item.page, occurrence: remaining + 1 };
      remaining -= item.count;
    }
    return null;
  }, [findReport.pages, findIndex, findTotal]);
  /**
   * 查找态。
   *
   * 关键：只要有 ≥2 个字的关键词就要把 query 交给视图——扫描是靠这个开始的。
   * 曾经这里额外要求 findTarget 存在（也就是要先有命中），扫描因此永远拿不到关键词，
   * 界面一直显示「没有找到」。activePage/activeOccurrence 才是「跳到第几处」。
   */
  const findState: PDFFindState | null = useMemo(
    () =>
      findOpen && findQuery.trim().length >= 2
        ? {
            query: findQuery,
            caseSensitive: findCase,
            activePage: findTarget?.page,
            activeOccurrence: findTarget?.occurrence,
            nonce: findNonce,
          }
        : null,
    [findOpen, findQuery, findCase, findTarget, findNonce],
  );
  const findStatus = findQuery.trim().length < 2
    ? '输入至少 2 个字符'
    : findReport.scanning
      ? `正在查找 ${findReport.scanning.done}/${findReport.scanning.total} 页…`
      : findTotal
        ? `${Math.min(findIndex + 1, findTotal)} / ${findTotal}`
          + (findReport.failed ? ` · ${findReport.failed} 页取文本失败` : '')
        : `没有找到「${findQuery.trim()}」`
          + (findReport.failed ? `（其中 ${findReport.failed} 页取文本失败，未参与匹配）` : '');
  const stepFind = useCallback(
    (delta: number) => {
      if (!findTotal) return;
      setFindIndex((value) => (value + delta + findTotal) % findTotal);
      setFindNonce((value) => value + 1);
    },
    [findTotal],
  );
  // 换栏（原文 ⇄ 译文）时旧的命中报告不再成立，等新栏重新扫描回报。
  useEffect(() => {
    setFindReport({ pages: [], scanning: null, failed: 0 });
  }, [findScope]);
  // 目标命中出现或换了一处时把对应那栏滚过去；扫描过程中的报告刷新不重复跳。
  const findJumped = useRef('');
  useEffect(() => {
    if (!findOpen || !findTarget) return;
    const key = `${findNonce}:${findTarget.page}:${findTarget.occurrence}`;
    if (key === findJumped.current) return;
    findJumped.current = key;
    if (findScope === 'translated') navigateTranslationPage(findTarget.page);
    else navigatePage(findTarget.page);
  }, [findOpen, findTarget, findNonce, findScope, navigatePage, navigateTranslationPage]);
  useEffect(() => {
    if (!findOpen) return;
    findInput.current?.focus();
    findInput.current?.select();
  }, [findOpen]);
  useEffect(() => {
    if (epub) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'f') return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [epub]);
  // 从全文检索进来：把关键词填进查找栏，并记下要落到哪一页。
  const pendingFindPage = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingFind?.query) return;
    setFindQuery(pendingFind.query);
    setFindCase(false);
    setFindIndex(0);
    setFindOpen(true);
    pendingFindPage.current = pendingFind.page;
    setFindNonce((value) => value + 1);
  }, [pendingFind?.nonce, pendingFind?.query, pendingFind?.page]);
  // 命中报告回来后，把序号定位到用户点的那一页（而不是文档里的第一处命中）。
  // 必须等扫描结束：扫描是逐页增量回报的，中途的页码表还不完整。
  useEffect(() => {
    const target = pendingFindPage.current;
    if (target == null || findReport.scanning || !findReport.pages.length) return;
    let index = 0;
    for (const item of findReport.pages) {
      if (item.page >= target) break;
      index += item.count;
    }
    pendingFindPage.current = null;
    setFindIndex(index);
    setFindNonce((value) => value + 1);
  }, [findReport]);

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
          navigatePage(
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
  }, [documentKey, navigatePage]);
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
    if (!cite) return;    // 标记「本次进入阅读页由出处跳转驱动」：恢复上次阅读位置的异步回填要让位给目标页。
    citeTakeover.current = true;
    setMode((value) => (value === 'translation' ? 'source' : value));
    navigatePage(cite.page);
    setFlashing(true);
    const timer = setTimeout(() => setFlashing(false), 1200);
    return () => clearTimeout(timer);
  }, [cite?.nonce, cite?.page, navigatePage]);
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
          // 段落识别直接用 Lee document.v1 的块与坐标，不再用 PDF.js 重新切段。
          const retained = await api.paragraphs(documentKey, current, controller.signal);
          if (!cancelled && retained.available) {
            setPDFLayout(leeLayout(retained));
            setSourceText(retained.blocks.map((block) => block.text).join('\n\n'));
          } else if (!cancelled) {
            setPDFLayout(null);
            setSourceText('');
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
  const openParagraphTranslation = (paragraph: SelectedParagraph) => {
    setPending(null);
    if (paragraph.kind === 'pdf') {
      setSelectedParagraph(null);
      if (mode !== 'parallel') setMode('parallel');
      const targetPage = Math.min(paragraph.position, translatedPDF.document?.numPages ?? paragraph.position);
      navigateTranslationPage(targetPage, paragraph.targetY, paragraph.viewportOffset);
      return;
    }
    if (mode !== 'parallel') return;
    setSelectedParagraph(paragraph);
  };
  const openHighlightedTextActions = (annotation: Annotation, position: { top: number; left: number }) => {
    if (annotation.page == null) return;
    const sourceLayout = annotation.page === current ? pdfLayout : null;
    const quote = annotation.quote.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const index = sourceLayout?.blocks.findIndex((block) => {
      const text = block.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      return quote && (text.includes(quote) || quote.includes(text));
    }) ?? -1;
    const block = index >= 0 ? sourceLayout?.blocks[index] : undefined;
    const rect = annotation.locator?.rects?.[0];
    const targetY = block && sourceLayout ? block.y / sourceLayout.height : rect?.y;
    const translationScroll = panes.current?.querySelectorAll<HTMLElement>('.publication-pane .pdf-document-scroll');
    const translationBounds = (translationScroll?.[1] ?? translationScroll?.[0])?.getBoundingClientRect();
    setPending(null);
    setSelectedParagraph({
      text: block?.text || annotation.quote || '公式',
      position: annotation.page,
      index: Math.max(0, index),
      targetY,
      viewportOffset: translationBounds ? position.top - translationBounds.top : undefined,
      top: position.top,
      left: position.left,
      kind: 'pdf',
    });
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
      if (chapter) navigatePage(chapter.index);
    } else if (item?.page && item.locator?.kind === 'pdf') {
      navigatePage(item.page);
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
        <PDFDocumentView
          document={pdf.document}
          page={current}
          onPage={(value) => onPage(Math.min(value, count || value))}
          navigationRequest={navigationRequest}
          annotations={annotations.items}
          focusedId={focusedAnnotationId}
          onSelect={select}
          onText={() => undefined}
          layout={pdfLayout}
          paragraphMode
          onParagraph={openParagraphTranslation}
          onAnnotationClick={openHighlightedTextActions}
          find={findScope === 'source' ? findState : null}
          onFind={findScope === 'source' ? setFindReport : undefined}
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
      {epub ? (
        <div className="translation-document">
          <p>LeePDF 排版译文只适用于 PDF。EPUB 请阅读原文。</p>
        </div>
      ) : translatedPDF.document ? (
        <PDFDocumentView
          document={translatedPDF.document}
          page={Math.min(current, translatedPDF.document.numPages)}
          onPage={(value) => onPage(Math.min(value, count || value))}
          navigationRequest={translationNavigationRequest}
          annotations={annotations.items}
          focusedId={focusedAnnotationId}
          onSelect={select}
          onText={() => undefined}
          onAnnotationClick={openHighlightedTextActions}
          find={findScope === 'translated' ? findState : null}
          onFind={findScope === 'translated' ? setFindReport : undefined}
        />
      ) : liveRenderedPDF.document ? (
        <PDFDocumentView
          document={liveRenderedPDF.document}
          page={1}
          onPage={() => undefined}
          navigationRequest={{ page: 1, nonce: current }}
          annotations={[]}
          focusedId={null}
          onSelect={select}
          onText={() => undefined}
          onAnnotationClick={openHighlightedTextActions}
        />
      ) : liveTranslationPreview?.blocks.length ? (
        <div className="translation-document live-translation-preview" aria-live="polite">
          <p className="live-translation-status">第 {current} 页 · {liveTranslationProgress}</p>
          {liveTranslationPreview.blocks.map((block, index) => (
            <p className="live-translation-block" key={`${index}-${block.source.slice(0, 32)}`}>{block.target}</p>
          ))}
        </div>
      ) : (
        <div className="translation-document">
          <p>{liveTranslationProgress || translatedPDF.error || '正在等待 LeePDF 逐页翻译…'}</p>
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
                onClick={() => { setMode(item); navigatePage(current); }}
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
          {!epub && pdf.document ? (
          <button
            aria-pressed={findOpen}
            onClick={() => setFindOpen((value) => !value)}
            title="在文档中查找（Ctrl+F）"
          >
            查找
          </button>
          ) : null}
          {!epub && pdf.document && documentKey ? (
          <button onClick={() => setCitationOpen(true)} title="导出这篇论文的 BibTeX / RIS 条目">
            引用
          </button>
          ) : null}
          {!epub && pdf.document && documentKey ? (
          <button onClick={() => setNetworkOpen(true)} title="看这篇论文与本库其它论文的引用关系">
            引用网络
          </button>
          ) : null}
          {!epub && pdf.document && documentKey ? (
          <button onClick={() => setExportOpen(true)} title="交给 LeePDF 重新生成整本译文 PDF">
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
      {findOpen && !epub ? (
        <div className="reader-find-bar" role="search">
          <input
            ref={findInput}
            type="text"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
              setFindNonce((value) => value + 1);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setFindOpen(false);
              }
            }}
            placeholder={findScope === 'translated' ? '在译文中查找' : '在原文中查找'}
            aria-label="查找内容"
          />
          <span className="reader-find-count" aria-live="polite">{findStatus}</span>
          <button type="button" onClick={() => stepFind(-1)} disabled={!findTotal} title="上一处（Shift+Enter）" aria-label="上一处">↑</button>
          <button type="button" onClick={() => stepFind(1)} disabled={!findTotal} title="下一处（Enter）" aria-label="下一处">↓</button>
          <label className="reader-find-option">
            <input
              type="checkbox"
              checked={findCase}
              onChange={(event) => {
                setFindCase(event.target.checked);
                setFindIndex(0);
                setFindNonce((value) => value + 1);
              }}
            />
            区分大小写
          </label>
          <button type="button" onClick={() => setFindOpen(false)}>关闭</button>
        </div>
      ) : null}
      <div className="reader-panels" ref={panelRoot}>
        <aside className="reader-sidebar" data-open={leftOpen} style={{ width: visibleLeft, flexBasis: visibleLeft }}>
          <p className="panel-label">{epub ? '章节目录' : 'PDF 目录与页码'}</p>
          <div className="reader-page-nav">
            <button disabled={current <= 1} onClick={() => navigatePage(current - 1)}>
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
                if (value >= 1 && value <= count) navigatePage(value);
              }}
            />
            <span>/ {count || '—'}</span>
            <button
              disabled={current >= count}
              onClick={() => navigatePage(current + 1)}
            >
              下一{epub ? '章' : '页'}
            </button>
          </div>
          <div className="toc-tree">
            {navigation.length
              ? navigation.map((item, index) => (
                  <button
                    className={`toc-item${index === activeNavigationIndex ? ' selected' : ''}`}
                    style={{ paddingLeft: 8 + item.depth * 12 }}
                    key={index}
                    onClick={() => {
                      setSelectedNavigationIndex(index);
                      navigatePage(item.page, 'y' in item && typeof item.y === 'number' ? item.y : undefined);
                    }}
                  >
                    {item.title}
                  </button>
                ))
              : Array.from({ length: count }, (_, i) => (
                  <button
                    key={i}
                    className={`toc-item${i + 1 === current ? ' selected' : ''}`}
                    onClick={() => navigatePage(i + 1)}
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
        onTranslate={() => openParagraphTranslation(selectedParagraph)}
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
          pageCount={pdf.document.numPages}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
      {citationOpen && documentKey ? (
        <CitationExportDialog
          keys={[documentKey]}
          scopeLabel={selected?.title || documentKey}
          onClose={() => setCitationOpen(false)}
        />
      ) : null}
      {networkOpen && documentKey ? (
        <CitationNetworkDialog
          documentKey={documentKey}
          onOpenDocument={onOpenDocument}
          onClose={() => setNetworkOpen(false)}
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
