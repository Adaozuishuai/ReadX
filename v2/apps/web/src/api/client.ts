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

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>('/healthz', { signal }),
  meta: (signal?: AbortSignal) => request<MetaResponse>('/v1/meta', { signal }),
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
