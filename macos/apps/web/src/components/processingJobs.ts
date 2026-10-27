import type { DocumentProcessingJob } from '../api/client';

export function jobStatus(job: DocumentProcessingJob): string {
  if (job.status === 'running' || job.stages.some(stage => stage.status === 'running')) return 'running';
  if (job.status === 'failed' || job.stages.some(stage => stage.status === 'failed')) return 'failed';
  if (job.status === 'done' && job.stages.some(stage => stage.status === 'interrupted')) return 'interrupted';
  return job.status;
}

/** Retry only stopped documents, once per document; active jobs take precedence. */
export function stoppedDocumentJobs(jobs: DocumentProcessingJob[]): DocumentProcessingJob[] {
  const keyOf = (job: DocumentProcessingJob) => job.documentKey || job.key;
  const running = new Set(jobs.filter(job => jobStatus(job) === 'running').map(keyOf));
  const seen = new Set<string>();
  return jobs.filter(job => {
    const key = keyOf(job);
    if (!key || job.status === 'cancelled' || running.has(key) || seen.has(key) || !['failed', 'interrupted'].includes(jobStatus(job))) return false;
    seen.add(key);
    return true;
  });
}

export async function reprocessStoppedJobs(
  jobs: DocumentProcessingJob[],
  submit: (key: string) => Promise<unknown>,
  onProgress?: (finished: number, total: number) => void,
) {
  const candidates = stoppedDocumentJobs(jobs);
  const failures: { title: string; message: string }[] = [];
  let submitted = 0;
  for (const job of candidates) {
    try {
      await submit(job.documentKey || job.key);
      submitted++;
    } catch (error) {
      failures.push({ title: job.name || job.documentKey || job.key, message: error instanceof Error ? error.message : String(error) });
    }
    onProgress?.(submitted + failures.length, candidates.length);
  }
  return { total: candidates.length, submitted, failures };
}
