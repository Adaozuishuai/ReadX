import { useEffect, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import workerURL from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, type DocumentJob, type JobStage } from '../api/client';
import { AppDialog } from './AppDialog';
import { downloadBlob } from '../lib/download';

GlobalWorkerOptions.workerSrc = workerURL;

interface JobDocument {
  key: string;
  title: string;
  translatedTitle?: string;
  authors?: string[];
  venue?: string;
  year?: number | null;
  doi?: string;
  format?: string;
  hasPdf?: boolean;
  addedAt?: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: '处理中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const STAGE_LABEL: Record<string, string> = {
  pending: '等待中',
  running: '处理中',
  done: '已完成',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消',
  interrupted: '已中断',
};

type Tab = 'overview' | 'progress' | 'files';

function stageOf(job: DocumentJob | null, key: string): JobStage | undefined {
  return job?.stages.find((stage) => stage.key === key);
}

function stageCount(stage: JobStage | undefined) {
  if (!stage || stage.total <= 0) return '';
  return `${Math.max(0, stage.completed)} / ${stage.total}`;
}

function stageUnit(stage: JobStage | undefined) {
  if (stage?.unit) return stage.unit;
  if (stage?.key === 'translate') return '段';
  return stage?.key === 'memory' ? '份' : '页';
}

/**
 * 文档任务面板：对齐 LeePDF 的 OCR → 翻译 → 渲染 进度页。
 *
 * 左侧是原页封面、题录与下载；右侧分「概览 / 进度 / 文件」三个标签。
 * 任务数据来自导入时持久化的 job，运行中每隔 1.2s 轮询，可随时取消。
 */
export function DocumentJobDialog({
  document,
  fileKey,
  jobKey,
  coverFile,
  importing = false,
  pending = false,
  errorMessage = '',
  onClose,
  onOpenReader,
}: {
  document: JobDocument;
  /** Original library key when jobKey identifies a retranslation attempt. */
  fileKey?: string;
  /** 导入过程中文档尚未入库：用服务端提前返回的任务键轮询任务。 */
  jobKey?: string | null;
  /** 导入中的封面直接用本地文件渲染，避免请求还不存在的文档文件。 */
  coverFile?: File;
  importing?: boolean;
  pending?: boolean;
  errorMessage?: string;
  onClose: () => void;
  onOpenReader: () => void;
}) {
  const effectiveKey = pending && !jobKey ? '' : jobKey || document.key;
  const assetKey = fileKey || effectiveKey;
  const [tab, setTab] = useState<Tab>('progress');
  const [job, setJob] = useState<DocumentJob | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [cover, setCover] = useState('');
  const [notice, setNotice] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);


  useEffect(() => {
    if (!effectiveKey) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await api.documentJob(effectiveKey);
        if (cancelled) return;
        setJob(response.available ? response.job ?? null : null);
        setLoaded(true);
        if (response.job?.status === 'running' || response.job?.stages.some((stage) => stage.status === 'running')) {
          timer = window.setTimeout(load, 1200);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [effectiveKey, refreshKey]);

  // 封面用原 PDF 第一页渲染；导入中直接用本地文件，失败时退回纯色封面。
  useEffect(() => {
    let cancelled = false;
    setCover('');
    if (document.format === 'epub') return;
    if (!coverFile && !assetKey) return;
    if (!coverFile && importing && !fileKey) return;
    void (async () => {
      const data = coverFile ? await coverFile.arrayBuffer() : await api.file(assetKey);
      if (cancelled) return;
      const pdf = await getDocument({ data: new Uint8Array(data) }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const width = 260;
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = window.document.createElement('canvas');
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      await page.render({ canvasContext: context, viewport }).promise;
      if (!cancelled) setCover(canvas.toDataURL('image/png'));
    })().catch((error) => {
      // 封面只是装饰：失败时退回纯色封面，但保留日志便于排查。
      console.error('job cover failed', error);
    });
    return () => {
      cancelled = true;
    };
  }, [coverFile, assetKey, document.format, importing, fileKey]);

  const copyKey = async () => {
    if (!effectiveKey) return;
    try {
      await navigator.clipboard.writeText(effectiveKey);
      setNotice('已复制文档编号');
    } catch {
      setNotice('复制失败，请手动选择文本');
    }
    window.setTimeout(() => setNotice(''), 1600);
  };

  const download = (blob: Blob, name: string) => {
    downloadBlob(blob, name);
  };

  const downloadOriginal = async () => {
    if (!assetKey) return;
    setNotice('');
    try {
      const data = await api.file(assetKey);
      const epub = document.format === 'epub';
      download(new Blob([data], { type: epub ? 'application/epub+zip' : 'application/pdf' }), `${effectiveKey}.${epub ? 'epub' : 'pdf'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const downloadTranslated = async () => {
    if (!assetKey) return;
    setNotice('');
    try {
      download(await api.downloadTranslatedPDF(assetKey), `${assetKey}-translated.pdf`);
    } catch {
      setNotice('还没有生成译文 PDF：先在阅读器里“导出译文 PDF”。');
    }
  };

  const cancel = async () => {
    if (!effectiveKey) return;
    setNotice('');
    try {
      const result = await api.cancelDocumentJob(effectiveKey);
      setNotice(result.cancelled ? '已请求取消任务' : '任务已经结束，无需取消');
      setRefreshKey((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const status = job?.status ?? '';
  const jobRunning = status === 'running' || pending;
  const pages = job?.pages || 0;
  const ocrStage = stageOf(job, 'ocr');
  const translateStage = stageOf(job, 'translate');
  const renderStage = stageOf(job, 'render');
  const memoryStage = stageOf(job, 'memory');
  const memoryRunning = memoryStage?.status === 'running';
  const tracking = jobRunning || memoryRunning;
  const translationUnit = stageUnit(translateStage);
  const renderingUnit = stageUnit(renderStage);
  const translationCompleted = Math.max(0, translateStage?.completed ?? 0);
  const translationTotal = Math.max(0, translateStage?.total ?? 0);
  const processedPages = Math.max(0, renderStage?.completed ?? 0);
  const ocrPages = Math.max(0, ocrStage?.completed ?? 0);
  const ocrTotalPages = Math.max(0, ocrStage?.total || pages);
  const renderTotal = Math.max(0,
    renderStage?.total || (renderStage?.status === 'pending' && ocrStage?.status === 'done' ? ocrTotalPages : 0),
  );
  const statusText = memoryRunning && status === 'done'
    ? '入库完成，论文记忆处理中'
    : status ? STATUS_LABEL[status] ?? status : pending ? '处理中' : '还没有任务记录';
  const activeMessage = tracking ? job?.stages.find((stage) => stage.status === 'running' && stage.message)?.message : '';
  const statusDetail = job
    ? document.format === 'epub'
      ? '按 EPUB 章节结构保存；无需 OCR 和 PDF 版面渲染'
      : activeMessage
      ? activeMessage
      : translationTotal > 0
      ? `已处理 ${translationCompleted} / ${translationTotal} ${translationUnit} · 排版 ${processedPages} / ${renderTotal || '—'} ${renderingUnit}`
      : `排版 ${processedPages} / ${renderTotal || '—'} ${renderingUnit}`
    : pending
      ? document.format === 'epub' ? '正在上传文件，任务创建后显示章节导入状态' : '正在上传文件，任务创建后显示 OCR 进度'
      : document.format === 'epub' ? '导入后这里会显示 EPUB 章节导入状态。' : '导入后这里会显示 LeePDF 的 OCR、翻译与渲染进度。';
  const openDisabled = importing || !effectiveKey || job?.status === 'failed' || job?.status === 'cancelled';

  return (
    <AppDialog open onClose={onClose} className="job-dialog" aria-label="文档任务">
      <header className="job-dialog-header">
        <div>
          <p className="precision-overline">{importing ? '正在导入' : '文档处理'}</p>
          <h2>{document.title || '未命名文档'}</h2>
        </div>
        <div className="job-header-tools">
          {tracking ? <span className="job-header-state"><i /> {memoryRunning && !jobRunning ? '论文记忆处理中' : '正在处理'}</span> : null}
          <button type="button" onClick={onClose} aria-label="关闭任务面板">×</button>
        </div>
      </header>

      <div className="job-layout">
        <aside className="job-side">
          <div className={`job-cover${cover ? ' has-image' : ''}`}>
            {cover ? <img src={cover} alt="文档封面" /> : <span>{document.title || '未命名文档'}</span>}
          </div>
          <div className="job-document-heading">
            <span className="job-document-type">{(document.format || 'PDF').toUpperCase()} 文档</span>
            <h3>{document.title || '未命名文档'}</h3>
          </div>
          {document.translatedTitle ? <p className="job-subtitle">{document.translatedTitle}</p> : null}
          <p className="job-author">
            <span aria-hidden="true">◉</span>
            {document.authors?.length ? document.authors.join('，') : '未知作者'}
          </p>
          <button type="button" className="job-id" onClick={copyKey} title="复制文档编号">
            <span aria-hidden="true">#</span> {effectiveKey || '任务创建中…'}
            <span aria-hidden="true">⧉</span>
          </button>
          <button type="button" className="job-primary" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled}>
            <span aria-hidden="true">◉</span> 查看原版
          </button>
          <div className="job-downloads" aria-label="文件下载">
            <p className="job-side-label">文件与阅读</p>
            <div>
              <button type="button" onClick={downloadOriginal} disabled={openDisabled} title="下载原版 PDF" aria-label="下载原版 PDF">⇩</button>
              <button type="button" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled} title="在阅读器中打开" aria-label="在阅读器中打开">▤</button>
              {document.format !== 'epub' ? <button type="button" onClick={downloadTranslated} disabled={openDisabled} title="下载译文 PDF" aria-label="下载译文 PDF">Aa</button> : null}
            </div>
          </div>
        </aside>

        <section className="job-main">
          <nav className="job-tabs" role="tablist" aria-label="任务视图">
            {([
              ['overview', '概览'],
              ['progress', '进度'],
              ['files', '文件'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                type="button"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                <span aria-hidden="true">{id === 'overview' ? '▤' : id === 'progress' ? '◔' : '▣'}</span>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'progress' ? (
            <div className="job-progress">
              <div className="job-progress-heading">
                <div>
                  <span className="job-eyebrow">处理工作区</span>
                  <h3>{statusText}</h3>
                  <p>{statusDetail}</p>
                </div>
                <div className="job-progress-summary">
                  <span>{document.format === 'epub' ? '章节' : `翻译进度（${translationUnit}）`}</span>
                  <strong>{document.format === 'epub' ? 'EPUB' : `${translationCompleted}`}<small>{document.format === 'epub' ? '' : ` / ${translationTotal || '—'}`}</small></strong>
                  {document.format !== 'epub' ? <div className="job-meter" role="progressbar" aria-label="翻译进度" aria-valuemin={0} aria-valuemax={translationTotal || 1} aria-valuenow={translationCompleted}><span style={{ width: `${translationTotal ? Math.min(100, (translationCompleted / translationTotal) * 100) : 0}%` }} /></div> : null}
                </div>
              </div>

              <section className="job-card job-pipeline-card">
                <div className="job-status">
                  <span className={`job-spinner${tracking ? ' running' : ''}`} aria-hidden="true">{tracking ? '↻' : status === 'done' ? '✓' : '!'}</span>
                  <div>
                    <strong>处理流程</strong>
                    <p>{activeMessage || (document.format === 'epub' ? '保留原章节结构并准备阅读' : '识别原文、翻译段落并生成可读译文')}</p>
                  </div>
                </div>

                <ol className="job-stages job-stages-horizontal" aria-label="导入阶段">
                  {(job?.stages ?? [
                    { key: 'ocr', label: 'OCR', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'translate', label: '翻译', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'render', label: '渲染', status: 'pending', message: '', completed: 0, total: 0 },
                    { key: 'memory', label: '论文记忆', status: 'pending', message: '', completed: 0, total: 0 },
                  ]).map((stage, index, list) => (
                    <li key={stage.key} data-status={stage.status}>
                      <span className="job-stage-dot" aria-hidden="true">{stage.status === 'done' ? '✓' : stage.status === 'running' ? <i /> : index + 1}</span>
                      <div>
                        <p>
                          <strong>{stage.label}</strong>
                          <span className="job-chip">{STAGE_LABEL[stage.status] ?? stage.status}</span>
                        </p>
                        {stageCount(stage) ? <span className="job-stage-count">{stageCount(stage)} {stageUnit(stage)}</span> : null}
                        {stage.message ? <small>{stage.message}</small> : null}
                      </div>
                      {index < list.length - 1 ? <span className="job-stage-line" aria-hidden="true" /> : null}
                    </li>
                  ))}
                </ol>
              </section>

              <button type="button" className="job-live" onClick={() => { if (!openDisabled) onOpenReader(); }} disabled={openDisabled}>
                <span aria-hidden="true">↗</span>
                <div>
                  <strong>{document.format === 'epub' ? '打开文档阅读器' : '打开译文阅读器'}</strong>
                  <small>{importing ? '处理完成后可打开' : document.format === 'epub' ? '保留 EPUB 原章节结构' : '查看 ReadX 生成的译文 PDF'}</small>
                </div>
                <span className="job-live-shortcut">打开</span>
              </button>

              <div className="job-actions">
                {jobRunning ? (
                  <button type="button" className="job-cancel" onClick={cancel}>取消任务</button>
                ) : (
                  <span className="job-action-note">{memoryRunning ? '译文已入库，论文记忆后台整理中' : job ? `任务${STATUS_LABEL[status] ?? status}` : '尚无运行中的任务'}</span>
                )}
                <span className="job-meta">{document.format === 'epub' ? 'EPUB · 章节结构' : `OCR · ${job?.stages.find((stage) => stage.key === 'ocr')?.status === 'done' ? '已识别' : '未完成'}`}</span>
                <button type="button" onClick={() => setDetailsOpen((value) => !value)}>
                  {detailsOpen ? '收起' : '详情'}
                </button>
              </div>

              {detailsOpen ? (
                <section className="job-card job-details">
                  <p className="job-side-label">任务详情</p>
                  <dl className="job-detail">
                    <dt>开始时间</dt><dd>{job ? new Date(job.startedAt).toLocaleString([], { hour12: false }) : '—'}</dd>
                    <dt>最后更新</dt><dd>{job ? new Date(job.updatedAt).toLocaleString([], { hour12: false }) : '—'}</dd>
                    <dt>页数</dt><dd>{pages || '—'}</dd>
                    <dt>状态</dt><dd>{STATUS_LABEL[status] ?? (status || '—')}</dd>
                    {job?.stages.map((stage) => (
                      <div key={stage.key} className="job-detail-row">
                        <dt>{stage.label}</dt>
                        <dd>{stage.status} · {stage.message || '—'}（{Math.max(0, stage.completed)}/{Math.max(0, stage.total)} {stageUnit(stage)}）</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ) : null}

              {notice ? <p className="job-notice" role="status">{notice}</p> : null}
              {errorMessage ? <p className="job-error" role="alert">{errorMessage}</p> : null}

              {document.format === 'epub' ? (
                <section className="job-card" aria-label="EPUB 导入进度">
                  <p className="job-side-label">EPUB 处理方式</p>
                  <p>EPUB 按原章节结构保存并在阅读器中打开；无需 OCR 和 PDF 版面渲染。</p>
                </section>
              ) : <section className="job-progress-metrics" aria-label="翻译和排版进度">
                <article className="job-card job-metric-card">
                  <div className="job-metric-heading"><span className="job-metric-icon">文</span><span>翻译进度</span></div>
                  <strong>{translationCompleted}<small> / {translationTotal || '—'} {translationUnit}</small></strong>
                  <div className="job-meter" role="progressbar" aria-label="翻译进度" aria-valuemin={0} aria-valuemax={translationTotal || 1} aria-valuenow={translationCompleted}>
                    <span style={{ width: `${translationTotal ? Math.min(100, (translationCompleted / translationTotal) * 100) : 0}%` }} />
                  </div>
                  <small className="job-metric-foot">
                    {translateStage?.resultCount
                      ? `已缓存 ${translateStage.resultCount} ${translateStage.resultUnit || '段'}译文 · OCR 已识别 ${ocrPages} / ${ocrTotalPages || '—'} 页`
                      : `OCR 已识别 ${ocrPages} / ${ocrTotalPages || '—'} 页`}
                  </small>
                </article>
                <article className="job-card job-metric-card">
                  <div className="job-metric-heading"><span className="job-metric-icon">页</span><span>译文页面排版</span></div>
                  <strong>{processedPages}<small> / {renderTotal || '—'} {renderingUnit}</small></strong>
                  <div className="job-meter" role="progressbar" aria-label="排版进度" aria-valuemin={0} aria-valuemax={renderTotal || 1} aria-valuenow={processedPages}>
                    <span style={{ width: `${renderTotal ? Math.min(100, (processedPages / renderTotal) * 100) : 0}%` }} />
                  </div>
                  <small className="job-metric-foot">{renderStage?.message || '等待翻译段落处理完成'}</small>
                </article>
              </section>}

              <section className="job-card">
                <p className="job-side-label">任务记录 共 {job?.runs.length ?? 0} 次</p>
                <ol className="job-runs">
                  {(job?.runs ?? []).slice().reverse().map((run) => (
                    <li key={run.id}>
                      <strong>{STATUS_LABEL[run.status] ?? run.status}</strong>
                      <span>{new Date(run.startedAt).toLocaleString([], { hour12: false })}</span>
                      {document.format !== 'epub' ? <span>{run.pages} 页</span> : <span>EPUB</span>}
                      {run.error ? <small>{run.error}</small> : null}
                    </li>
                  ))}
                  {!job?.runs.length ? <li className="job-runs-empty">还没有任务记录。</li> : null}
                </ol>
              </section>
            </div>
          ) : null}

          {tab === 'overview' ? (
            <div className="job-progress">
              <section className="job-card">
                <dl className="job-detail">
                  <dt>标题</dt><dd>{document.title || '—'}</dd>
                  <dt>中文题名</dt><dd>{document.translatedTitle || '—'}</dd>
                  <dt>作者</dt><dd>{document.authors?.join('，') || '—'}</dd>
                  <dt>期刊/会议</dt><dd>{document.venue || '—'}</dd>
                  <dt>年份</dt><dd>{document.year || '—'}</dd>
                  <dt>DOI</dt><dd>{document.doi || '—'}</dd>
                  <dt>格式</dt><dd>{(document.format || 'pdf').toUpperCase()}</dd>
                  <dt>文档编号</dt><dd className="job-mono">{effectiveKey || '任务创建中…'}</dd>
                </dl>
              </section>
              {job?.error ? <p className="job-error" role="alert">{job.error}</p> : null}
            </div>
          ) : null}

          {tab === 'files' ? (
            <div className="job-progress">
              <section className="job-card job-files">
                <button type="button" onClick={downloadOriginal} disabled={openDisabled}>
                  <span aria-hidden="true">▣</span>
                  <div><strong>{document.format === 'epub' ? '原版 EPUB' : '原版 PDF'}</strong><small>导入时保存的原始文件</small></div>
                  <span aria-hidden="true">⇩</span>
                </button>
                {document.format !== 'epub' ? <button type="button" onClick={downloadTranslated} disabled={openDisabled}>
                  <span aria-hidden="true">Aa</span>
                  <div><strong>译文 PDF</strong><small>ReadX 排版完成后提供</small></div>
                  <span aria-hidden="true">⇩</span>
                </button> : null}
              </section>
              {document.format !== 'epub' ? <p className="job-action-note">PDF 的 OCR、段落整理、翻译与排版由 ReadX 本地处理。</p> : <p className="job-action-note">EPUB 保留原章节结构，在阅读器中打开。</p>}
            </div>
          ) : null}

          {!loaded ? <p className="job-notice">正在读取任务状态…</p> : null}
        </section>
      </div>
    </AppDialog>
  );
}
