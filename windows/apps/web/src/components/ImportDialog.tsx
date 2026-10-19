import { useEffect, useRef, useState } from 'react';
import {
  api,
  type ImportCandidate,
  type ImportMetadataHint,
  type ImportedDocument,
} from '../api/client';
import { useImportProgress } from './ImportProgressPanel';
import { UploadShotStage, type ActiveImport } from './UploadShotStage';
import { DocumentJobDialog } from './DocumentJobDialog';

const MAX_PDF_BYTES = 512 * 1048576;
const MAX_EPUB_BYTES = 100 * 1048576;

export function ImportDialog({
  files,
  onClose,
  onImported,
  onOpenDocument,
}: {
  files: File[];
  onClose: () => void;
  onImported: () => void;
  onOpenDocument?: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const started = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [results, setResults] = useState<ImportedDocument[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [error, setError] = useState('');
  // 弹弓式导入：选中的文件先落进队列，用户逐个投进篮筐才开始导入。
  const [queue, setQueue] = useState<File[]>([]);
  const [active, setActive] = useState<ActiveImport | null>(null);
  // 文件进篮筐就切到任务面板：先显示上传/准备，拿到 jobKey 后轮询 OCR/翻译/渲染。
  const [jobFile, setJobFile] = useState<File | null>(null);
  // 来源跟随具体文件对象，避免同名文件互相覆盖题录来源。
  const sources = useRef(new WeakMap<File, string>());
  const activity = useImportProgress();
  useEffect(() => {
    dialog.current?.showModal();
    return () => controller.current?.abort();
  }, []);
  // ref 同步加锁，阻止 React 更新 busy 前的重复提交。
  const startRequest = () => {
    if (controller.current) return null;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    return request;
  };
  const finishRequest = (request: AbortController) => {
    if (controller.current !== request) return;
    controller.current = null;
    setBusy(false);
  };

  /** 投进一个：只导入这一篇，其余留在队列里。 */
  const upload = async (file: File) => {
    const request = startRequest();
    if (!request) return;
    setQueue((items) => items.filter((item) => item !== file));
    setActive({ file, result: null, cancelled: false });
    setError('');
    activity.begin('preparing', `正在检查 ${file.name}`);
    try {
      const isPDF = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
      if (file.size > (isPDF ? MAX_PDF_BYTES : MAX_EPUB_BYTES)) {
        throw new Error(isPDF ? 'PDF 文件不能超过 RetainPDF 默认的 512 MB 上传上限' : '单个 EPUB 文件不超过 100 MB');
      }
      const fileIndex = 1;
      const files = 1;
      activity.update({ stage: 'upload', message: '正在准备上传，由 RetainPDF 处理论文', name: file.name, file: fileIndex, files, completed: 0, total: 0 });
      const hint: ImportMetadataHint = { title: '', author: '', doi: '', arxiv: '', firstPage: '' };
      const source = sources.current.get(file);
      if (source) {
        hint.source = source;
      }
      // PDF processing is delegated to RetainPDF; EPUB keeps its chapter import flow.
      setJobFile(file);
      const result = await api.upload([file], request.signal, [hint], activity.receive);
      const imported = result.results[0];
      if (!imported) throw new Error('服务未返回导入结果，请刷新书库确认');
      setActive({ file, result: imported, cancelled: false });
      setResults((current) => [...current, ...result.results]);
      const failed = result.results.filter(item => item.error).length;
      activity.update({ stage: 'complete', message: failed ? '导入失败，原因见下方' : 'RetainPDF 译文已保存到书库', completed: 1, total: 1 });
    } catch (cause) {
      const cancelled = request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      const message = cancelled ? '已取消' : String(cause);
      activity.update({ stage: cancelled ? 'cancelled' : 'failed', message: cancelled ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setActive({ file, result: { name: file.name, existing: false, error: message }, cancelled });
      setError(message);
    } finally {
      finishRequest(request);
      onImported();
    }
  };
  // 从书库拖进来的文件先进队列，由用户自己投进篮筐才开始导入。
  useEffect(() => {
    if (files.length && !started.current) {
      started.current = true;
      setQueue(files);
    }
  }, [files]);
  const importLink = async (
    url: string,
    title?: string,
    _metadata?: ImportCandidate,
  ) => {
    const request = startRequest();
    if (!request) return;
    activity.begin('download', '正在解析链接并下载公开全文，等待下载服务返回');
    setError('');
    try {
      const downloaded = await api.downloadPublication(url, title, request.signal, (received, total) => activity.update({ stage: 'download', message: '正在接收下载的论文全文', completed: received, total }));
      request.signal.throwIfAborted();
      // 下载件同样进队列：投进筐才开始导入，规则与手动选文件一致。
      sources.current.set(downloaded.file, downloaded.source);
      setQueue((items) => [...items, downloaded.file]);
      activity.update({ stage: 'complete', message: `已下载《${downloaded.file.name}》，把它投进篮筐开始导入`, completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: request.signal.aborted ? 'cancelled' : 'failed', message: request.signal.aborted ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setError(
        request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      finishRequest(request);
      onImported();
    }
  };
  const search = async () => {
    const request = startRequest();
    if (!request) return;
    activity.begin('search', '正在检索标题 / DOI 并查找公开全文地址');
    setError('');
    setCandidates([]);
    try {
      const found = (await api.searchImport(value, request.signal)).results;
      request.signal.throwIfAborted();
      setCandidates(found);
      activity.update({ stage: 'complete', message: `检索完成，找到 ${found.length} 个候选结果`, completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: request.signal.aborted ? 'cancelled' : 'failed', message: request.signal.aborted ? '检索已取消' : '检索失败，请查看下方错误', completed: 0, total: 0 });
      setError(
        request.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      finishRequest(request);
    }
  };
  return (
    <>
    <dialog
      className="app-dialog import-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        controller.current?.abort();
        onImported();
        onClose();
      }}
    >
      <header>
        <div><p className="section-eyebrow">BUILD YOUR LIBRARY</p><h2>导入文档</h2><p className="import-subtitle">PDF / EPUB · 识别题录并保存全文翻译</p></div>
        <button
          onClick={() => {
            controller.current?.abort();
            onImported();
            onClose();
          }}
          aria-label="关闭导入"
        >
          ×
        </button>
      </header>
      <ol className="import-steps" aria-label="导入流程"><li><span>01</span>选择文件</li><li><span>02</span>加入待导入队列</li><li><span>03</span>识别题录并翻译</li></ol>
      <UploadShotStage
        queue={queue}
        active={active}
        current={activity.current}
        results={results}
        busy={busy}
        disabled={busy}
        onQueue={(selected) => setQueue((items) => [...items, ...selected])}
        onMake={(file) => void upload(file)}
      />
      <p className="text-xs text-ink-faint">
        PDF 最大 512 MB（RetainPDF 服务会继续校验 OCR 限制）；EPUB 最大 100 MB。相同文件自动去重，投进篮筐开始处理。
      </p>
      <label className="import-link-field">
        链接、arXiv 编号、DOI 或标题
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="https://… / 2209.14540 / 10.… / 论文标题"
          disabled={busy}
        />
      </label>
      <div className="dialog-actions">
        <button
          disabled={busy || !value.trim()}
          onClick={() => void importLink(value)}
        >
          从链接或编号导入
        </button>
        <button disabled={busy || !value.trim()} onClick={() => void search()}>
          按标题 / DOI 查找
        </button>
      </div>
      <details className="import-data-note"><summary>题录识别、翻译与数据说明</summary><p>PDF 导入后由 ReadX 执行 OCR、段落整理、翻译和 PDF 排版。OCR 与翻译模型配置在 AI 助手设置中管理。</p></details>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      {candidates.map((item, index) => (
        <article className="import-result" key={index}>
          <strong>{item.title}</strong>
          <p>{item.authors.slice(0, 4).join(' · ')}</p>
          <small>{[item.venue, item.year, item.doi].filter(Boolean).join(' · ')}</small>
          <button
            disabled={busy || !item.url}
            onClick={() => void importLink(item.url, item.title, item)}
          >
            {item.url ? '导入全文' : '未找到公开全文'}
          </button>
        </article>
      ))}
      {/* 上传行只显示文件名与进度；这里补上 AI 识别出的题录与失败原因，
          以及仅有服务端才知道的告警（例如译文不完整）。 */}
      {results.map((result, index) => (
        <p className={result.error ? 'text-bad' : 'text-good'} key={index}>
          {result.document?.title ?? result.name}：
          {result.error ?? (result.existing ? '书库已有此文件' : '已导入')}
          {result.warning && <small className="block text-amber-700">{result.warning}</small>}
          {result.document && <small className="block">{[result.document.translatedTitle, result.document.authors.join(' · '), result.document.venue, result.document.year].filter(Boolean).join(' / ')}</small>}
        </p>
      ))}
      <footer>
        {busy && (
          <button onClick={() => controller.current?.abort()}>取消请求</button>
        )}
        <button className="primary-button" disabled={busy} onClick={onClose}>
          完成
        </button>
      </footer>
    </dialog>
    {jobFile ? (
      <DocumentJobDialog
        document={{ key: activity.jobKey || '', title: active?.result?.document?.title || jobFile.name, authors: active?.result?.document?.authors || [], format: /\.epub$/i.test(jobFile.name) || jobFile.type === 'application/epub+zip' ? 'epub' : 'pdf' }}
        jobKey={activity.jobKey || null}
        coverFile={jobFile}
        importing={busy}
        pending={busy && !activity.jobKey}
        onClose={() => setJobFile(null)}
        onOpenReader={() => {
          const imported = active?.result?.document;
          if (!imported || !onOpenDocument) return;
          onOpenDocument(imported.id);
          onClose();
        }}
      />
    ) : null}
    </>
  );
}
