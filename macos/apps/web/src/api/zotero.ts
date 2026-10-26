import { authenticatedFetch, request } from './client';

export interface ZoteroAttachment { key: string; name: string }
export interface ZoteroEntry {
  key: string; title: string; authors: string[]; year?: number; doi: string; venue: string;
  attachments: ZoteroAttachment[]; error?: string;
}
export interface ZoteroSelection { item: ZoteroEntry; attachment: ZoteroAttachment }
export interface ZoteroCollection { key: string; name: string; parent: string | false }
export interface ZoteroPage { items: ZoteroEntry[]; total: number; start: number; hasMore: boolean }

export const zotero = {
  collections: (signal?: AbortSignal) => request<{ collections: ZoteroCollection[] }>('/v1/import/zotero/collections', { signal }),
  items: (q: string, collection: string, start: number, signal?: AbortSignal) => request<ZoteroPage>(`/v1/import/zotero/items?${new URLSearchParams({ q, collection, start: String(start) })}`, { signal }),
  file: async (attachment: ZoteroAttachment, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/v1/import/zotero/attachments/${encodeURIComponent(attachment.key)}/file`, { signal });
    return new File([await response.blob()], attachment.name, { type: 'application/pdf' });
  },
};
