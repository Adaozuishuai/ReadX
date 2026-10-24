export type SlackKind = 'novel' | 'comic';

export interface DownloadedBookMetadata {
  title: string; author: string; source?: string; sourceUrl?: string;
  providerId?: string; providerBookId?: string; sourceLicense?: string; contentSha256?: string; importedAt?: number;
}

export interface SlackProgress {
  chapter: number;
  page: number;
  scroll: number;
}

export interface SlackItem {
  id: string;
  kind: SlackKind;
  title: string;
  author: string;
  createdAt: number;
  openedAt: number;
  progress: SlackProgress;
  chapterCount: number;
  pageCount: number;
  coverAssetId: string;
  coverTone: number;
  sizeBytes: number;
  /** 网络书源名称；本地拖入的文件没有这个字段。 */
  source?: string;
  /** 中文连载书源：true 时章节正文按需抓取，可刷新目录。 */
  serial?: boolean;
  sourceId?: string;
  sourceUrl?: string;
  sourceName?: string;
  lastCheckedAt?: number;
  providerId?: string;
  providerBookId?: string;
  sourceLicense?: string;
  contentSha256?: string;
  importedAt?: number;
}

export interface SlackChapter {
  order: number;
  title: string;
  text: string;
  html: string;
  /** 连载书源的章节页面 URL；正文缓存到 text 后仍然保留。 */
  url?: string;
}

export interface SlackAsset {
  id: string;
  itemId: string;
  order: number;
  name: string;
  mime: string;
  blob: Blob;
}

export interface ParsedAsset {
  id: string;
  order: number;
  name: string;
  mime: string;
  blob: Blob;
}

export interface ParsedChapter {
  title: string;
  text: string;
  html: string;
}

export interface ParsedNovel {
  title: string;
  author: string;
  chapters: ParsedChapter[];
  assets: ParsedAsset[];
  coverAssetId: string;
  sizeBytes: number;
}

export interface ParsedComic {
  title: string;
  assets: ParsedAsset[];
  sizeBytes: number;
}

export interface ImportJob {
  id: string;
  name: string;
  status: 'pending' | 'working' | 'done' | 'error';
  message: string;
}
