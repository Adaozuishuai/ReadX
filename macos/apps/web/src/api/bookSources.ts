import { authenticatedFetch, request } from './client';
import { contentHash } from '../components/slack/bookImport';

export interface BookRights {
  access: 'allowed' | 'denied' | 'unknown'; basis?: string;
  canDownload: boolean; canCache: boolean; canRead: boolean; reason?: string;
}
export interface BookSource {
  providerId: string; name: string; enabled: boolean; reason?: string;
  capabilities: { search: boolean; detail: boolean; download: boolean; requiresAuth: boolean };
}
export interface SourceBook {
  id: string; providerId: string; title: string; authors: string[]; isbn?: string;
  language?: string; coverUrl?: string; description?: string; formats: string[]; sourceUrl?: string; rights: BookRights;
  requiresRightsConfirmation?: boolean;
}
export interface ZLibraryStatus {
  origin: string; downloadOrigins: string[]; connected: boolean; accountName?: string;
  downloadsToday?: number; dailyLimit?: number; message: string;
}
export const zLibraryConnection = {
  status: (signal?: AbortSignal) => request<ZLibraryStatus>('/v1/book-sources/zlibrary/connection', { signal }),
  configure: (origin: string, downloadOrigins: string[]) => request<ZLibraryStatus>('/v1/book-sources/zlibrary/connection', { method: 'PUT', body: { origin, downloadOrigins } }),
  connect: (body: { email?: string; password?: string; userId?: string; userKey?: string }) => request<ZLibraryStatus>('/v1/book-sources/zlibrary/connection', { method: 'POST', body }),
  disconnect: () => request<ZLibraryStatus>('/v1/book-sources/zlibrary/connection', { method: 'DELETE' }),
  probe: () => request<ZLibraryStatus>('/v1/book-sources/zlibrary/probe', { method: 'POST', body: {} }),
};
export interface BookSearchResult { books: SourceBook[]; nextCursor?: string }
export interface BookDownloadTask {
  id: string; providerId: string; bookId: string; format: string;
  leaseId?: string;
  state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
  receivedBytes: number; totalBytes?: number; errorCode?: string; message?: string;
  fileName?: string; contentType?: string; sha256?: string;
}
const bookPath = (source: string, id: string) => `/v1/book-sources/${encodeURIComponent(source)}/books/${encodeURIComponent(id)}`;
export const bookSources = {
  list: (signal?: AbortSignal) => request<{ sources: BookSource[] }>('/v1/book-sources', { signal }),
  search: (source: string, q: string, cursor = '', signal?: AbortSignal) => request<BookSearchResult>(`/v1/book-sources/${encodeURIComponent(source)}/search?${new URLSearchParams({ q, cursor })}`, { signal }),
  detail: (source: string, id: string, signal?: AbortSignal) => request<SourceBook>(bookPath(source, id), { signal }),
  start: (book: SourceBook, format: string, signal?: AbortSignal, userAuthorized = false) => request<BookDownloadTask>(`${bookPath(book.providerId, book.id)}/downloads`, { method: 'POST', body: { format, userAuthorized }, signal }),
  cover: async (book: SourceBook, signal?: AbortSignal) => (await authenticatedFetch(`${bookPath(book.providerId, book.id)}/cover`, { signal })).blob(),
  status: (id: string, signal?: AbortSignal) => request<BookDownloadTask>(`/v1/book-downloads/${encodeURIComponent(id)}`, { signal }),
  cancel: (id: string, leaseId: string) => request<BookDownloadTask>(`/v1/book-downloads/${encodeURIComponent(id)}?${new URLSearchParams({ lease: leaseId })}`, { method: 'DELETE' }),
  file: async (task: BookDownloadTask, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/v1/book-downloads/${encodeURIComponent(task.id)}/file`, { signal });
    const blob = await response.blob();
    const hash = await contentHash(blob);
    if (!task.sha256 || hash !== task.sha256) throw new Error('下载文件校验不一致，请重试');
    return new File([blob], task.fileName ?? `readx.${task.format}`, { type: task.contentType });
  },
};
export function mayDownload(book: SourceBook, userAuthorized = false) {
  return (book.rights.access === 'allowed' && book.rights.canDownload && book.rights.canCache && book.rights.canRead)
    || (book.providerId === 'zlibrary' && book.rights.access === 'unknown' && book.requiresRightsConfirmation === true && userAuthorized);
}
export const readableFormats = (book: SourceBook) => ['epub', 'txt'].filter(format => book.formats.includes(format));
