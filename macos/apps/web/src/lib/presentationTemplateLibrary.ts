import type { PresentationTheme } from './presentation';

export interface PresentationTemplateRecord {
  id: string;
  name: string;
  summary: string;
  theme: PresentationTheme;
  file: Blob;
  builtin: boolean;
  savedAt: string;
}

const DATABASE = 'readx-presentation-template-library';
const STORE = 'templates';
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持本地模板库。'));
      return;
    }
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地模板库。'));
  });
}

export async function listPresentationTemplates(): Promise<PresentationTemplateRecord[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as PresentationTemplateRecord[]).sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)));
      request.onerror = () => reject(request.error ?? new Error('无法读取模板库。'));
    });
  } finally {
    db.close();
  }
}

export async function savePresentationTemplate(template: PresentationTemplateRecord): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(template);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('保存模板失败。'));
    });
  } finally {
    db.close();
  }
}
