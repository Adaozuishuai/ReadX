import type {
  ApiFailure,
  BootstrapInfo,
  DocumentDetail,
  DocumentsResponse,
  HealthResponse,
  MetaResponse,
  PageListResponse,
  PageText,
  WireStatus,
} from '@cbct/shared';
import { isApiFailure } from '@cbct/shared';
import type { PDFMetadataHint } from './pdfMetadata';

/**
 * API 客户端。
 *
 * token 来源只有一条路径：Electron preload 经 contextBridge 注入。纯浏览器 dev 模式下
 * 没有 token，此时 /v1 请求由 Vite dev proxy 在服务端补上 Authorization——凭据不落渲染进程。
 */
function bootstrap(): BootstrapInfo {
  const injected =
    typeof window === 'undefined' ? undefined : window.__CBCT_V2__;
  return { apiBase: injected?.apiBase ?? '', token: injected?.token ?? '' };
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** 本地服务不可达（server 未启动 / 崩溃）与业务错误的文案要分开，否则用户看不懂该重启还是重试。 */
export function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof ApiError && error.status === 0)
  );
}

async function request<T>(
  path: string,
  init?: { signal?: AbortSignal; method?: string; body?: unknown },
): Promise<T> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  try {
    response = await fetch(apiBase + path, {
      headers,
      signal: init?.signal,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw new ApiError('本地服务未响应，请确认 server 已启动', 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const message = isApiFailure(payload)
      ? (payload as ApiFailure).error
      : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  if (payload === null)
    throw new ApiError(`${path} 返回空响应`, response.status);
  return payload as T;
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && value.trim()) search.set(key, value.trim());
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export interface AIStatus {
  provider?: string;
  configured: boolean;
  model?: string;
  host?: string;
  error?: string;
}

export interface ReadingEntry {
  value: string;
  demoted: string[];
  validationError: string | null;
  updatedAt: string;
}

export interface ReadingVisualReference {
  id: string;
  kind: 'figure' | 'table';
  page: number;
  caption: string;
  suggestedStep: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction';
}

export interface ReadingsResponse {
  key: string;
  entries: Record<string, unknown>;
}

export interface GenerateResponse {
  saved: boolean;
  kind: string;
  pruned: boolean;
  demoted: string[];
  validationError: string | null;
  attempts: number;
}

export interface GenerateProgress {
  percent: number;
  message: string;
}

export interface ChatChunk {
  meta?: { included: number; total: number; scope: string; unit?: string };
  delta?: string;
  done?: boolean;
  text?: string;
  error?: string;
  partial?: string;
}

/**
 * 流式对话：SSE 逐块回调。
 *
 * 服务端在流里既会发 delta 也会发 error（例如上游 finish_reason 不是 stop）——
 * 那种情况下已吐出的半句必须保留在界面上但标明「未保存」，不能假装成功。
 */
export async function streamChat(
  request: {
    key: string;
    mode?: string;
    question: string;
    scope?: string;
    history?: Array<{ role: string; text: string }>;
  },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  });
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(`${apiBase}/v1/ai/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal,
    credentials: 'omit',
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as ApiFailure;
      if (isApiFailure(parsed)) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 200);
    }
    throw new ApiError(message, response.status);
  }
  if (!response.body)
    throw new ApiError('接口没有返回流式内容。', response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;
  const processLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      return;
    }
    if (chunk.done || chunk.error) terminal = true;
    onChunk(chunk);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(processLine);
  }
  processLine(buffer + decoder.decode());
  if (!terminal) throw new ApiError('连接中断，回答未完成，未保存。', 502);
}

export interface Annotation {
  locator?: AnnotationLocator;
  id: string;
  documentId: string;
  page: number | null;
  kind: 'highlight' | 'underline' | 'question' | string;
  quote: string;
  note: string;
  color: string;
  tags: string[];
  startOffset: number | null;
  endOffset: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationListResponse {
  key: string;
  annotations: Annotation[];
  total: number;
}

export interface TranslationItem {
  hash: string;
  source: string;
  target: string;
}

export interface TranslationResponse {
  key: string;
  items: TranslationItem[];
  total: number;
  cached: number;
  newly: number;
  distinct: number;
}

export interface DocumentMeta {
  key: string;
  favorite: boolean;
  tags: string[];
  categories: string[];
  deleted: boolean;
  updatedAt: string;
}

export interface DocumentMetaResponse {
  meta: DocumentMeta[];
  total: number;
}

export interface Category {
  name: string;
  color: string;
  order: number;
}

export interface CategoryListResponse {
  categories: Category[];
  total: number;
}

export interface ReproductionTask {
  status: 'todo' | 'verified' | 'blocked' | string;
  note: string;
  updatedAt: string;
}

export interface ReproductionItem {
  finding: {
    k: string;
    v: string;
    page: number | null;
    excerpt: string | null;
  };
  assessment: string;
  action: string;
}

export interface ReproductionChecklist {
  key: string;
  revisions: Record<string, Record<string, ReproductionTask>>;
  analyses: Record<
    string,
    {
      resources: ReproductionItem[];
      environment: ReproductionItem[];
      cost: ReproductionItem[];
      missing: ReproductionItem[];
      risks: ReproductionItem[];
    }
  >;
  repoChecks: Record<string, ReproductionTask>;
}

export interface RepoCheck {
  path: string;
  kind: string;
  detail: string;
  line: number | null;
  id: string;
}

export interface TagListResponse {
  tags: string[];
  total: number;
}

export interface TrendFinding {
  Topic: string;
  Count: number;
  Sample: {
    papers: string[];
    windowStart: string | null;
    windowEnd: string | null;
  };
  Evidence: { category: string; value: string; evidence: string }[];
  IsSupported: boolean;
  Claim: string;
  Caveat: string;
}

export interface TrendsResponse {
  sample: { papers: string[]; count: number };
  findings: TrendFinding[];
  evidence: Record<string, string[]>;
  coverage: { Category: string; Count: number }[];
  minimum: number;
}

export interface IdeaEvidence {
  id: string;
  paperKey: string;
  paperTitle: string;
  origin: string;
  page: number | null;
  excerpt: string;
  verifiedAt: string | null;
}

export interface ResearchIdea {
  id: string;
  question: string;
  observation: string;
  hypothesis: string;
  method: string;
  experiment: string;
  status: string;
  evidence: IdeaEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationLocator {
  kind: 'pdf' | 'epub';
  href?: string;
  blockStart?: number;
  blockEnd?: number;
  startOffset?: number;
  endOffset?: number;
  rects?: { x: number; y: number; width: number; height: number }[];
}
export interface EPUBSection {
  index: number;
  href: string;
  title: string;
  text: string;
  blocks: { kind: string; text?: string; src?: string; id?: string }[];
}
export interface AISettings {
  provider: string;
  baseURL: string;
  model: string;
  keyConfigured: boolean;
  status: AIStatus;
  cli: Record<string, boolean>;
}
export interface ImportedDocument {
  document?: import('@cbct/shared').DocumentSummary;
  name: string;
  existing: boolean;
  error?: string;
  warning?: string;
}
export interface DailyRecommendation {
  id: string;
  title: string;
  authors: string[];
  venue: string;
  venueTier: number;
  year: number;
  published: string;
  doi: string;
  url: string;
  pdfUrl: string;
  abstract: string;
}
export interface ImportProgress {
  stage: string;
  message: string;
  name?: string;
  file?: number;
  files?: number;
  completed: number;
  total: number;
}
export interface ImportStreamEvent {
  progress?: ImportProgress;
  heartbeat?: boolean;
}

function uploadPublications(files: File[], signal?: AbortSignal, metadata?: PDFMetadataHint[], onProgress?: (event: ImportStreamEvent) => void): Promise<{ results: ImportedDocument[] }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const { apiBase, token } = bootstrap();
    const data = new FormData();
    files.forEach(file => data.append('files', file));
    if (metadata) data.set('metadata', JSON.stringify(metadata));
    const xhr = new XMLHttpRequest();
    let offset = 0, buffer = '', settled = false;
    let result: { results: ImportedDocument[] } | undefined;
    const abort = () => xhr.abort();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new ApiError('导入连接中断，未确认结果，请刷新书库查看。', 502));
    };
    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const event = JSON.parse(line.slice(5).trim()) as ImportStreamEvent & { results?: ImportedDocument[]; error?: string };
      if (event.error) throw new ApiError(event.error, 502);
      if (event.results) result = { results: event.results };
      onProgress?.(event);
    };
    const read = (last = false) => {
      if (!xhr.getResponseHeader('Content-Type')?.includes('text/event-stream')) return;
      buffer += xhr.responseText.slice(offset);
      offset = xhr.responseText.length;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(processLine);
      if (last && buffer.trim()) { processLine(buffer); buffer = ''; }
    };
    xhr.open('POST', apiBase + '/v1/import/files');
    xhr.setRequestHeader('Accept', 'text/event-stream');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => onProgress?.({ progress: { stage: 'upload', message: '正在上传文件与排版数据到本地服务', completed: event.loaded, total: event.lengthComputable ? event.total : 0 } });
    xhr.upload.onload = () => onProgress?.({ progress: { stage: 'upload', message: '上传已完成，等待本地服务检查文件', completed: 0, total: 0 } });
    xhr.onprogress = () => { try { read(); } catch (error) { finish(error); xhr.abort(); } };
    xhr.onload = () => {
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `HTTP ${xhr.status}`;
          try { message = (JSON.parse(xhr.responseText) as ApiFailure).error || message; } catch { /* Preserve HTTP status. */ }
          throw new ApiError(message, xhr.status);
        }
        read(true);
        if (!xhr.getResponseHeader('Content-Type')?.includes('text/event-stream')) result = JSON.parse(xhr.responseText) as typeof result;
        finish();
      } catch (error) { finish(error); }
    };
    xhr.onerror = () => finish(new ApiError('本地服务连接中断，请刷新书库确认已导入的文件。', 0));
    xhr.onabort = () => finish(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(data);
  });
}
export interface ImportCandidate {
  title: string;
  doi: string;
  url: string;
  arxiv?: string;
  authors: string[];
  venue?: string;
  year?: number;
}
export interface ReadingLocation {
  kind: 'pdf' | 'epub';
  page?: number;
  href?: string;
  index?: number;
}

export interface ArxivDownloadProgress {
  message: string;
  received: number;
  total: number;
}

async function authenticatedFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(apiBase + path, {
    ...init,
    headers,
    credentials: 'omit',
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => null)) as ApiFailure | null;
    throw new ApiError(
      payload?.error ?? `HTTP ${response.status}`,
      response.status,
    );
  }
  return response;
}
export interface NewAnnotation {
  page: number | null;
  locator?: AnnotationLocator;
  kind: string;
  quote: string;
  note?: string;
  color?: string;
  tags?: string[];
}

async function importRemotePublication(
  value: string,
  title?: string,
  metadata?: { doi: string; authors: string[]; venue?: string; year?: number },
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<ImportedDocument> {
  const response = await authenticatedFetch('/v1/import/url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ value, title, ...metadata }),
    signal,
  });
  if (!response.body) throw new ApiError('下载服务未返回内容', 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ImportedDocument | undefined;
  const process = (line: string) => {
    if (!line.startsWith('data:')) return;
    let event: {
      progress?: { received: number; total: number };
      result?: ImportedDocument;
      error?: string;
    };
    try {
      event = JSON.parse(line.slice(5).trim()) as typeof event;
    } catch {
      throw new ApiError('下载服务返回了无效的进度数据，导入状态未确认。', 502);
    }
    if (event.error) throw new ApiError(event.error, 502);
    if (event.progress)
      onProgress?.(event.progress.received, event.progress.total);
    if (event.result) result = event.result;
  };
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    lines.forEach(process);
  }
  process(buffer + decoder.decode());
  if (!result)
    throw new ApiError('连接中断，未确认导入结果，请刷新书库。', 502);
  return result;
}

export const api = {
  settings: () => request<AISettings>('/v1/ai/settings'),
  saveSettings: (body: {
    provider: string;
    baseURL: string;
    model: string;
    apiKey?: string;
    clearKey?: boolean;
  }) => request<AISettings>('/v1/ai/settings', { method: 'PUT', body }),
  testAI: () =>
    request<{ ok: boolean; answer: string }>('/v1/ai/test', {
      method: 'POST',
      body: {},
    }),
  upload: uploadPublications,
  importURL: importRemotePublication,
  dailyRecommendations: (signal?: AbortSignal) => request<{ papers: DailyRecommendation[]; fetchedAt: string }>('/v1/discovery/daily', { signal }),
  downloadPublication: async (value: string, title: string | undefined, signal?: AbortSignal, onProgress?: (received: number, total: number) => void) => {
    const response = await authenticatedFetch('/v1/import/url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, title, downloadOnly: true }), signal,
    });
    const decode = (header: string) => decodeURIComponent((response.headers.get(header) ?? '').replace(/\+/g, ' '));
    const chunks: BlobPart[] = [];
    const total = Number(response.headers.get('Content-Length')) || 0;
    let received = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new ApiError('下载服务未返回论文文件', 502);
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk as BlobPart);
      received += chunk.byteLength;
      onProgress?.(received, total);
    }
    return { file: new File(chunks, decode('X-Publication-Name') || 'paper.pdf'), source: decode('X-Publication-Source') };
  },
  searchImport: (q: string, signal?: AbortSignal) =>
    request<{ results: ImportCandidate[] }>(
      `/v1/import/search?q=${encodeURIComponent(q)}`,
      { signal },
    ),
  attachArxivPDF: async (key: string, arxiv: string, signal?: AbortSignal, onProgress?: (progress: ArxivDownloadProgress) => void) => {
    const response = await authenticatedFetch(`/v1/documents/${encodeURIComponent(key)}/arxiv-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ arxiv }), signal,
    });
    if (!response.body) throw new ApiError('arXiv 下载服务没有返回进度流', 502);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ImportedDocument | undefined;
    let streamError = '';
    const processLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const event = JSON.parse(line.slice(5).trim()) as { progress?: ArxivDownloadProgress; result?: ImportedDocument; error?: string };
      if (event.progress) onProgress?.(event.progress);
      if (event.result) result = event.result;
      if (event.error) streamError = event.error;
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(processLine);
    }
    processLine(buffer + decoder.decode());
    if (streamError) throw new ApiError(streamError, 502);
    if (!result) throw new ApiError('arXiv 下载连接中断，未确认 PDF 已关联。', 502);
    return result;
  },
  file: async (key: string, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/file`,
        { signal },
      )
    ).arrayBuffer(),
  section: (key: string, index: number, signal?: AbortSignal) =>
    request<EPUBSection>(
      `/v1/documents/${encodeURIComponent(key)}/sections/${index}`,
      { signal },
    ),
  resource: async (key: string, path: string, signal?: AbortSignal) =>
    (
      await authenticatedFetch(
        `/v1/documents/${encodeURIComponent(key)}/resource?path=${encodeURIComponent(path)}`,
        { signal },
      )
    ).blob(),
  location: (key: string) =>
    request<{ location: ReadingLocation | null }>(
      `/v1/documents/${encodeURIComponent(key)}/location`,
    ),
  saveLocation: (key: string, location: ReadingLocation) =>
    request<{ saved: boolean }>(
      `/v1/documents/${encodeURIComponent(key)}/location`,
      { method: 'PUT', body: location },
    ),
  health: (signal?: AbortSignal) =>
    request<HealthResponse>('/healthz', { signal }),
  meta: (signal?: AbortSignal) => request<MetaResponse>('/v1/meta', { signal }),
  aiStatus: (signal?: AbortSignal) =>
    request<AIStatus>('/v1/ai/status', { signal }),
  annotations: (key: string, signal?: AbortSignal) =>
    request<AnnotationListResponse>(
      `/v1/annotations/${encodeURIComponent(key)}`,
      { signal },
    ),
  createAnnotation: (key: string, body: NewAnnotation) =>
    request<Annotation>(`/v1/annotations/${encodeURIComponent(key)}`, {
      method: 'POST',
      body,
    }),
  patchAnnotation: (
    id: string,
    body: { note?: string; color?: string; kind?: string; tags?: string[] },
  ) =>
    request<{ id: string; updated: boolean }>(
      `/v1/annotation/${encodeURIComponent(id)}`,
      { method: 'PATCH', body },
    ),
  deleteAnnotation: (id: string) =>
    request<{ id: string; deleted: boolean }>(
      `/v1/annotation/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
  /** 批注导出为 Markdown：走带 token 的 fetch 拿 blob，再由渲染进程触发下载（直链拿不到 token）。 */
  exportAnnotations: async (key: string): Promise<string> => {
    const { apiBase, token } = bootstrap();
    const headers = new Headers();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(
      `${apiBase}/v1/annotations/${encodeURIComponent(key)}/export`,
      {
        headers,
        credentials: 'omit',
      },
    );
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as ApiFailure;
        if (isApiFailure(parsed)) message = parsed.error;
      } catch {
        /* 非 JSON 错误体：保留兜底文案 */
      }
      throw new ApiError(message, response.status);
    }
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const filename =
      /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${key}-annotations.md`;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return filename;
  },
  readings: (key: string, signal?: AbortSignal) =>
    request<ReadingsResponse>(`/v1/readings/${encodeURIComponent(key)}`, {
      signal,
    }),
  translate: (key: string, segments: string[], signal?: AbortSignal, cachedOnly = false) =>
    request<TranslationResponse & { complete?: boolean }>(
      `/v1/translations/${encodeURIComponent(key)}`,
      {
        method: 'POST',
        body: { segments, cachedOnly },
        signal,
      },
    ),
  generate: async (
    key: string,
    kind: 'motivation' | 'method' | 'experiment' | 'results' | 'reproduction',
    visuals: ReadingVisualReference[] = [],
    onProgress?: (progress: GenerateProgress) => void,
  ): Promise<GenerateResponse> => {
    const { apiBase, token } = bootstrap();
    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`${apiBase}/v1/ai/generate`, {
        method: 'POST', headers, body: JSON.stringify({ key, kind, visuals }), credentials: 'omit',
      });
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : '本地服务未响应', 0);
    }
    if (!response.ok) {
      const text = await response.text();
      let message = `HTTP ${response.status}`;
      try { const parsed = JSON.parse(text) as ApiFailure; if (isApiFailure(parsed)) message = parsed.error; }
      catch { if (text) message = text.slice(0, 200); }
      throw new ApiError(message, response.status);
    }
    if (!response.body) throw new ApiError('精读生成没有返回进度流。', response.status);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: GenerateResponse | null = null;
    let streamError = '';
    const processLine = (raw: string) => {
      const line = raw.trim();
      if (!line.startsWith('data:')) return;
      try {
        const event = JSON.parse(line.slice(5).trim()) as { progress?: GenerateProgress; result?: GenerateResponse; error?: string };
        if (event.progress) onProgress?.(event.progress);
        if (event.result) result = event.result;
        if (event.error) streamError = event.error;
      } catch { /* Ignore incomplete or malformed progress events. */ }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(processLine);
    }
    processLine(buffer + decoder.decode());
    if (streamError) throw new ApiError(streamError, 502);
    if (!result) throw new ApiError('生成连接中断，精读结果未确认保存。', 502);
    return result;
  },
  documents: (
    signal?: AbortSignal,
    filters?: { status?: string; q?: string },
  ) =>
    request<DocumentsResponse>(`/v1/documents${query(filters ?? {})}`, {
      signal,
    }),
  document: (key: string, signal?: AbortSignal) =>
    request<DocumentDetail>(`/v1/documents/${encodeURIComponent(key)}`, {
      signal,
    }),
  pages: (key: string, signal?: AbortSignal) =>
    request<PageListResponse>(
      `/v1/documents/${encodeURIComponent(key)}/pages`,
      { signal },
    ),
  page: (key: string, page: number, signal?: AbortSignal) =>
    request<PageText>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}`,
      { signal },
    ),
  putPage: (key: string, page: number, text: string, signal?: AbortSignal) =>
    request<{ page: number; hash: string; chars: number }>(
      `/v1/documents/${encodeURIComponent(key)}/pages/${page}`,
      {
        method: 'PUT',
        body: { text },
        signal,
      },
    ),
  setStatus: (key: string, status: WireStatus) =>
    request<{ key: string; status: string }>(
      `/v1/documents/${encodeURIComponent(key)}/status`,
      {
        method: 'PATCH',
        body: { status },
      },
    ),
  documentsMeta: (signal?: AbortSignal) =>
    request<DocumentMetaResponse>('/v1/documents-meta', { signal }),
  emptyTrash: (keys: string[]) =>
    request<{ deletedKeys: string[]; filesPreserved: boolean }>('/v1/trash/empty', {
      method: 'POST',
      body: { keys },
    }),
  patchDocumentMeta: (
    key: string,
    body: {
      favorite?: boolean;
      tags?: string[];
      categories?: string[];
      deleted?: boolean;
    },
  ) =>
    request<DocumentMeta>(`/v1/documents/${encodeURIComponent(key)}/meta`, {
      method: 'PATCH',
      body,
    }),
  categories: (signal?: AbortSignal) =>
    request<CategoryListResponse>('/v1/categories', { signal }),
  upsertCategory: (body: { name: string; color: string; order?: number }) =>
    request<{ categories: Category[]; updated: boolean }>('/v1/categories', {
      method: 'POST',
      body,
    }),
  deleteCategory: (name: string) =>
    request<{ categories: Category[]; deleted: boolean }>(
      `/v1/category/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    ),
  reproduction: (key: string, signal?: AbortSignal) =>
    request<{ key: string; checklist: ReproductionChecklist }>(
      `/v1/reproduction/${encodeURIComponent(key)}`,
      { signal },
    ),
  analyzeReproduction: (key: string, value: string) =>
    request<{
      ok: boolean;
      revision: string;
      groups: { id: string; label: string; count: number }[];
      unknownCount: number;
    }>(`/v1/reproduction/${encodeURIComponent(key)}/analyze`, {
      method: 'POST',
      body: { value },
    }),
  setReproductionTask: (
    key: string,
    body: { revision: string; itemId: string; status?: string; note?: string },
  ) =>
    request<{ ok: boolean; task: ReproductionTask }>(
      `/v1/reproduction/${encodeURIComponent(key)}/task`,
      { method: 'PATCH', body },
    ),
  repoChecks: (files: { path: string; lines: string[] }[]) =>
    request<{ ok: boolean; checks: RepoCheck[] }>(
      '/v1/reproduction/repo-checks',
      { method: 'POST', body: { files } },
    ),
  tags: (signal?: AbortSignal) =>
    request<TagListResponse>('/v1/tags', { signal }),
  duplicates: (signal?: AbortSignal) =>
    request<{
      groups: { primaryKey: string; keys: string[] }[];
      total: number;
    }>('/v1/duplicates', { signal }),
  trends: (status: string, signal?: AbortSignal) =>
    request<TrendsResponse>(`/v1/trends${query({ status })}`, { signal }),
  ideas: (signal?: AbortSignal) =>
    request<{ ideas: ResearchIdea[]; total: number }>('/v1/ideas', { signal }),
  createIdea: (body: Partial<ResearchIdea>) =>
    request<ResearchIdea>('/v1/ideas', { method: 'POST', body }),
  patchIdea: (id: string, body: Partial<ResearchIdea>) =>
    request<ResearchIdea>(`/v1/idea/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),
  deleteIdea: (id: string) =>
    request<{ id: string; deleted: boolean }>(
      `/v1/idea/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
};
