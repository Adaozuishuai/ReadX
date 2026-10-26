import { lazy, Suspense, useEffect, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api, type DocumentProcessingJob, type JobStage } from '../api/client';
import { AppDialog } from './AppDialog';
import { WorkspaceIcon } from './WorkspaceIcon';
import './LibraryProcessingControl.css';

const DocumentJobDialog = lazy(() => import('./DocumentJobDialog').then(module => ({ default: module.DocumentJobDialog })));

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中', running: '处理中', done: '已完成', failed: '失败',
  skipped: '已跳过', cancelled: '已取消', interrupted: '已中断',
};

function jobStatus(job: DocumentProcessingJob): string {
  if (job.status === 'running' || job.stages.some(stage => stage.status === 'running')) return 'running';
  if (job.status === 'failed' || job.stages.some(stage => stage.status === 'failed')) return 'failed';
  if (job.status === 'done' && job.stages.some(stage => stage.status === 'interrupted')) return 'interrupted';
  return job.status;
}

function StageProgress({ stage, title }: { stage: JobStage; title: string }) {
  const complete = stage.status === 'done' || stage.status === 'skipped';
  const known = stage.total > 0;
  const value = complete ? 1 : known ? Math.min(1, Math.max(0, stage.completed / stage.total)) : stage.status === 'running' ? undefined : 0;
  return (
    <span className="processing-stage" data-status={stage.status} title={stage.message}>
      <span className="processing-stage-heading"><span>{stage.label}</span><span>{STATUS_LABEL[stage.status] ?? stage.status}</span></span>
      <progress value={value} max={1} aria-label={`${title} · ${stage.label}进度`} />
      {known ? <span className="processing-stage-count">{Math.max(0, stage.completed)} / {stage.total} {stage.unit || (stage.key === 'translate' ? '段' : stage.key === 'memory' ? '份' : '页')}</span> : null}
    </span>
  );
}

export function LibraryProcessingControl({ documents, onOpenDocument, onReload }: {
  documents: DocumentSummary[];
  onOpenDocument: (id: string) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<DocumentProcessingJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<DocumentProcessingJob | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const tracking = open || selectedJob !== null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await api.documentJobs(controller.signal);
        if (controller.signal.aborted) return;
        setJobs(response.jobs);
        setError('');
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (controller.signal.aborted) return;
      setLoaded(true);
      timer = window.setTimeout(load, tracking ? 1200 : 5000);
    };
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [tracking, revision]);

  const unfinishedJobs = jobs.filter(job => jobStatus(job) !== 'done');
  const running = unfinishedJobs.filter(job => jobStatus(job) === 'running').length;
  const stopped = unfinishedJobs.filter(job => ['failed', 'interrupted', 'cancelled'].includes(jobStatus(job))).length;
  const selectedTask = jobs.find(job => job.key === selectedJob?.key) ?? selectedJob;
  const selectedDocument = selectedTask
    ? documents.find(doc => doc.key === (selectedTask.documentKey || selectedTask.key))
    : undefined;

  useEffect(() => {
    if (selectedTask && !selectedDocument && (selectedTask.documentKey || selectedTask.status === 'done')) onReload();
  }, [selectedTask?.key, selectedTask?.documentKey, selectedTask?.status, selectedDocument?.id, onReload]);

  return (
    <>
      <button type="button" className="library-processing-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls="library-processing-panel" onClick={() => setOpen(true)} title="查看未完成文档的处理进度">
        <WorkspaceIcon name="list" size={16} /><span>处理</span>
        {running > 0 ? <span className="processing-running-count" aria-label={`${running} 篇文档处理中`}>{running}</span> : null}
      </button>
      <AppDialog open={open} onClose={() => setOpen(false)} className="processing-panel" aria-labelledby="library-processing-title" closeOnBackdrop>
        <div id="library-processing-panel">
          <header className="processing-panel-header">
            <div><h2 id="library-processing-title">处理面板</h2><p>仅显示未完成的文档，点击文档进入处理详情。</p></div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭处理面板"><WorkspaceIcon name="close" size={18} /></button>
          </header>
          <div className="processing-panel-summary">
            <span>未完成 <strong>{unfinishedJobs.length}</strong></span><span>处理中 <strong>{running}</strong></span><span>已停止 <strong>{stopped}</strong></span>
            <button type="button" onClick={() => setRevision(value => value + 1)}>刷新</button>
          </div>
          {error ? <p className="processing-panel-error" role="alert">进度更新失败：{error}，可以点击刷新重试。</p> : null}
          {!loaded ? <p className="processing-panel-empty" role="status">正在加载处理任务…</p> : unfinishedJobs.length === 0 && !error ? <p className="processing-panel-empty">暂无未完成的处理任务。</p> : null}
          <ul className="processing-task-list" aria-label="未完成文档处理进度">
            {unfinishedJobs.map(job => {
              const document = documents.find(doc => doc.key === (job.documentKey || job.key));
              const title = document?.title || job.name || '未命名文档';
              const status = jobStatus(job);
              const active = job.stages.filter(stage => stage.status === 'running');
              const message = job.error || active.map(stage => stage.message).filter(Boolean).join(' · ') || job.stages.find(stage => stage.status === 'failed')?.message;
              return (
                <li key={job.key}>
                  <button type="button" className="processing-task" data-status={status} onClick={() => { setOpen(false); setSelectedJob(job); onReload(); }} aria-label={`查看${title}的处理详情`}>
                    <span className="processing-task-heading"><WorkspaceIcon name="file" size={18} /><strong title={title}>{title}</strong><span className="processing-task-status">{STATUS_LABEL[status] ?? status}</span><WorkspaceIcon name="chevronRight" size={16} /></span>
                    <span className="processing-task-stages">{job.stages.map(stage => <StageProgress key={stage.key} stage={stage} title={title} />)}</span>
                    {message ? <span className="processing-task-message" title={message}>{message}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </AppDialog>
      {selectedTask ? <Suspense fallback={null}>
        <DocumentJobDialog
          key={selectedTask.key}
          document={selectedDocument ?? { key: selectedTask.key, title: selectedTask.name, format: /\.epub$/i.test(selectedTask.name) ? 'epub' : 'pdf' }}
          jobKey={selectedTask.key}
          fileKey={selectedDocument?.key || selectedTask.documentKey}
          importing={!selectedDocument}
          onClose={() => { setSelectedJob(null); onReload(); }}
          onOpenReader={() => {
            if (!selectedDocument) return;
            setSelectedJob(null);
            onOpenDocument(selectedDocument.id);
          }}
        />
      </Suspense> : null}
    </>
  );
}
