import { useEffect, useRef, useState } from 'react';
import {
  api,
  type ImportCandidate,
  type ImportedDocument,
} from '../api/client';
import { ImportProgressPanel, useImportProgress } from './ImportProgressPanel';
const readPDFMetadata: typeof import('../api/pdfMetadata').readPDFMetadata = async (...args) =>
  (await import('../api/pdfMetadata')).readPDFMetadata(...args);

export function ImportDialog({
  files,
  onClose,
  onImported,
}: {
  files: File[];
  onClose: () => void;
  onImported: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const started = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const [results, setResults] = useState<ImportedDocument[]>([]);
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [error, setError] = useState('');
  const activity = useImportProgress();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const upload = async (selected: File[]) => {
    if (!selected.length) return;
    setBusy(true);
    activity.begin('preparing', `正在检查 ${selected.length} 个文件的格式和大小`);
    setError('');
    controller.current = new AbortController();
    try {
      if (selected.length > 16 || selected.reduce((sum, file) => sum + file.size, 0) > 100 * 1048576)
        throw new Error('每次最多 16 个文件，合计不超过 100 MB');
      const hints = [];
      for (const file of selected) {
        if (controller.current.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const fileIndex = hints.length + 1;
        activity.update({ stage: 'parse', message: '正在打开文件、读取首页和文档信息', name: file.name, file: fileIndex, files: selected.length, completed: 0, total: 0 });
        const hint = await readPDFMetadata(file, controller.current.signal, (page, total) => activity.update({ stage: 'parse', message: `正在识别段落和栏位，已解析 ${page}/${total} 页`, name: file.name, file: fileIndex, files: selected.length, completed: page, total }));
        if (/\.pdf$/i.test(file.name) && !hint.firstPage.trim())
          throw new Error(`${file.name} 首页没有可读取的文本，暂无法用 AI 识别。请使用带文本层的 PDF。`);
        hints.push(hint);
      }
      activity.update({ stage: 'upload', message: '准备上传论文与排版数据到本地服务', completed: 0, total: 0 });
      const result = await api.upload(selected, controller.current.signal, hints, activity.receive);
      setResults((current) => [...current, ...result.results]);
      const failed = result.results.filter(item => item.error).length;
      activity.update({ stage: 'complete', message: `处理结束：${result.results.length - failed} 篇成功，${failed} 篇失败`, completed: result.results.length, total: selected.length });
    } catch (cause) {
      activity.update({ stage: controller.current?.signal.aborted ? 'cancelled' : 'failed', message: controller.current?.signal.aborted ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setError(
        controller.current?.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      setBusy(false);
      onImported();
    }
  };
  useEffect(() => {
    if (files.length && !started.current) {
      started.current = true;
      void upload(files);
    }
  }, [files]);
  const importLink = async (
    url: string,
    title?: string,
    _metadata?: ImportCandidate,
  ) => {
    setBusy(true);
    activity.begin('download', '正在解析链接并下载公开全文，等待下载服务返回');
    setError('');
    controller.current = new AbortController();
    try {
      const downloaded = await api.downloadPublication(url, title, controller.current.signal, (received, total) => activity.update({ stage: 'download', message: '正在接收下载的论文全文', completed: received, total }));
      activity.update({ stage: 'parse', message: '正在打开下载文件、读取首页和文档信息', name: downloaded.file.name, file: 1, files: 1, completed: 0, total: 0 });
      const hint = await readPDFMetadata(downloaded.file, controller.current.signal, (page, total) => activity.update({ stage: 'parse', message: `正在识别段落和栏位，已解析 ${page}/${total} 页`, name: downloaded.file.name, file: 1, files: 1, completed: page, total }));
      hint.source = downloaded.source;
      if (/\.pdf$/i.test(downloaded.file.name) && !hint.firstPage.trim())
        throw new Error('下载文件没有可读取的 PDF 首页，请检查是否为扫描件或登录页面。');
      activity.update({ stage: 'upload', message: '准备上传论文与排版数据到本地服务', completed: 0, total: 0 });
      const result = await api.upload([downloaded.file], controller.current.signal, [hint], activity.receive);
      setResults((current) => [...current, ...result.results]);
      activity.update({ stage: 'complete', message: result.results.some(item => item.error) ? '处理结束，导入失败原因见下方' : '论文信息、原文和译文已保存到书库', completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: controller.current?.signal.aborted ? 'cancelled' : 'failed', message: controller.current?.signal.aborted ? '已停止当前请求；已经完成的论文保留在书库' : '导入未完成，请查看下方错误后重试', completed: 0, total: 0 });
      setError(
        controller.current?.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      setBusy(false);
      onImported();
    }
  };
  const search = async () => {
    setBusy(true);
    activity.begin('search', '正在检索标题 / DOI 并查找公开全文地址');
    setError('');
    setCandidates([]);
    controller.current = new AbortController();
    try {
      const found = (await api.searchImport(value, controller.current.signal)).results;
      setCandidates(found);
      activity.update({ stage: 'complete', message: `检索完成，找到 ${found.length} 个候选结果`, completed: 1, total: 1 });
    } catch (cause) {
      activity.update({ stage: controller.current?.signal.aborted ? 'cancelled' : 'failed', message: controller.current?.signal.aborted ? '检索已取消' : '检索失败，请查看下方错误', completed: 0, total: 0 });
      setError(
        controller.current?.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')
          ? '已取消'
          : String(cause),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <dialog
      className="app-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        controller.current?.abort();
        onImported();
        onClose();
      }}
    >
      <header>
        <h2>导入文档</h2>
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
      <ImportProgressPanel activity={activity} busy={busy} />
      <label
        className="file-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) void upload(Array.from(event.dataTransfer.files));
        }}
      >
        选择或拖入 PDF / EPUB
        <input
          type="file"
          accept=".pdf,.epub,application/pdf,application/epub+zip"
          multiple
          disabled={busy}
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <small>每次最多 16 个文件，合计 100 MB；相同文件自动去重。</small>
      </label>
      <label>
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
      <p className="text-xs text-ink-faint">
	        PDF 会在进入书库前，使用 AI 设置中的模型解析首页，识别真实题目、作者、期刊/会议、年份及中文题名，并完成全文翻译；无法确认的字段留空。论文文字会发送给所选模型，译文按原页布局保存，可取消。扫描件需先添加文本层。
      </p>
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
        <button disabled={busy} onClick={onClose}>
          完成
        </button>
      </footer>
    </dialog>
  );
}
