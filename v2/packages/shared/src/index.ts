/**
 * v2 前后端共享契约。
 *
 * 这里每个字段的命名都必须与 Go 侧的 JSON tag 完全一致（internal/httpapi/server.go）；
 * 改名属于破坏性变更，需要同步改 Go、web、desktop 三处。
 */

/** server 打印到 stdout 的就绪行前缀，desktop 壳按它解析。 */
export const READY_PREFIX = 'CBCT_V2_READY ';

/** dev 模式下 server 写出的就绪文件，Vite proxy 靠它注入本地 token。 */
export const DEV_INFO_FILE = 'apps/server/dev-info.json';

export type DocumentStatus = 'queue' | 'reading' | 'done' | 'archive';

/** 后端状态值可能先于前端枚举演进（S1 之后会加分类），因此运行时按 string 收，展示时兜底。 */
export type WireStatus = DocumentStatus | (string & {});

export interface DocumentSummary {
  id: string;
  key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  doi: string;
  url: string;
  status: WireStatus;
  pdfPath: string;
  addedAt: string;
  updatedAt: string;
}

export interface DocumentsResponse {
  documents: DocumentSummary[];
  total: number;
}

export interface MetaResponse {
  app: string;
  version: string;
  dataRoot: string;
  dbPath: string;
  schemaVersion: number;
  startedAt: string;
  documentsTotal: number;
}

export interface HealthResponse {
  ok: boolean;
  schemaVersion: number;
}

export interface ApiFailure {
  error: string;
}

/** Electron preload 经 contextBridge 注入；纯浏览器 dev 模式下不存在，此时走 Vite proxy。 */
export interface BootstrapInfo {
  apiBase: string;
  token: string;
}

export function isApiFailure(value: unknown): value is ApiFailure {
  return typeof value === 'object' && value !== null && typeof (value as ApiFailure).error === 'string';
}

export function statusLabel(status: WireStatus): string {
  switch (status) {
    case 'queue':
      return '待读';
    case 'reading':
      return '在读';
    case 'done':
      return '已精读';
    case 'archive':
      return '归档';
    default:
      return String(status);
  }
}

/** 就绪信息的线上格式（Go: cmd/server/main.go emitReady）。 */
export interface ReadyInfo {
  port: number;
  host: string;
  token: string;
  dataRoot: string;
  dbPath: string;
  pid: number;
}

declare global {
  interface Window {
    __CBCT_V2__?: BootstrapInfo;
  }
}
