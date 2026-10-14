import type {
  ApiFailure,
  BootstrapInfo,
  DocumentDetail,
  DocumentsResponse,
  HealthResponse,
  ImportReport,
  MetaResponse,
  PageListResponse,
  PageText,
  WireStatus,
} from '@cbct/shared';
import { isApiFailure } from '@cbct/shared';

/**
 * API 客户端。
 *
 * token 来源只有一条路径：Electron preload 经 contextBridge 注入。纯浏览器 dev 模式下
 * 没有 token，此时 /v1 请求由 Vite dev proxy 在服务端补上 Authorization——凭据不落渲染进程。
 */
function bootstrap(): BootstrapInfo {
  const injected = typeof window === 'undefined' ? undefined : window.__CBCT_V2__;
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
  return error instanceof TypeError || (error instanceof ApiError && error.status === 0);
}

async function request<T>(path: string, init?: { signal?: AbortSignal; method?: string; body?: unknown }): Promise<T> {
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
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
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
    const message = isApiFailure(payload) ? (payload as ApiFailure).error : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  if (payload === null) throw new ApiError(`${path} 返回空响应`, response.status);
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

export interface ChatChunk {
  meta?: { included: number; total: number; scope: string };
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
  request: { key: string; mode?: string; question: string; scope?: string; history?: Array<{ role: string; text: string }> },
  onChunk: (chunk: ChatChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { apiBase, token } = bootstrap();
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' });
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
  if (!response.body) throw new ApiError('接口没有返回流式内容。', response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onChunk(JSON.parse(payload) as ChatChunk);
      } catch {
        // 单块解析失败不影响后续：与旧版一致跳过。
      }
    }
  }
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('/healthz', { signal }),
  meta: (signal?: AbortSignal) => request<MetaResponse>('/v1/meta', { signal }),
  aiStatus: (signal?: AbortSignal) => request<AIStatus>('/v1/ai/status', { signal }),
  readings: (key: string, signal?: AbortSignal) => request<ReadingsResponse>(`/v1/readings/${encodeURIComponent(key)}`, { signal }),
  generate: (key: string, kind: 'experiment' | 'results') =>
    request<GenerateResponse>('/v1/ai/generate', { method: 'POST', body: { key, kind } }),
  documents: (signal?: AbortSignal, filters?: { status?: string; q?: string }) =>
    request<DocumentsResponse>(`/v1/documents${query(filters ?? {})}`, { signal }),
  document: (key: string, signal?: AbortSignal) => request<DocumentDetail>(`/v1/documents/${encodeURIComponent(key)}`, { signal }),
  pages: (key: string, signal?: AbortSignal) =>
    request<PageListResponse>(`/v1/documents/${encodeURIComponent(key)}/pages`, { signal }),
  page: (key: string, page: number, signal?: AbortSignal) =>
    request<PageText>(`/v1/documents/${encodeURIComponent(key)}/pages/${page}`, { signal }),
  putPage: (key: string, page: number, text: string) =>
    request<{ page: number; hash: string; chars: number }>(`/v1/documents/${encodeURIComponent(key)}/pages/${page}`, {
      method: 'PUT',
      body: { text },
    }),
  setStatus: (key: string, status: WireStatus) =>
    request<{ key: string; status: string }>(`/v1/documents/${encodeURIComponent(key)}/status`, {
      method: 'PATCH',
      body: { status },
    }),
  importLegacy: (forceBackup = false) =>
    request<ImportReport>('/v1/import', { method: 'POST', body: { forceBackup } }),
  /** PDF 直链：渲染进程的 pdf.js 用它取字节（同源 + 同 token 通道）。 */
  pdfURL: (key: string): string => `/v1/documents/${encodeURIComponent(key)}/pdf`,
};
