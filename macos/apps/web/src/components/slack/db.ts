import type { ParsedAsset, SlackAsset, SlackChapter, SlackItem, SlackProgress } from './types';

/**
 * 摸鱼文库只落本机 IndexedDB：
 *   items      书目元数据（列表页只读它，不碰正文）
 *   chapters   正文按书整包存放（打开时才读）
 *   assets     漫画页 / EPUB 内嵌图，按 blob 存
 *
 * 不经过 Go server，也不写 localStorage：正文和图片都可能很大，localStorage
 * 的 5MB 配额和同步读写都不适合。
 */
const DB_NAME = 'readx-slack';
const DB_VERSION = 1;
const ITEMS = 'items';
const CHAPTERS = 'chapters';
const ASSETS = 'assets';

interface ChapterSet {
  itemId: string;
  chapters: SlackChapter[];
}

let database: Promise<IDBDatabase> | null = null;

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `slack-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB，无法保存摸鱼资料'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ITEMS)) {
        const items = db.createObjectStore(ITEMS, { keyPath: 'id' });
        items.createIndex('openedAt', 'openedAt');
      }
      if (!db.objectStoreNames.contains(CHAPTERS)) {
        db.createObjectStore(CHAPTERS, { keyPath: 'itemId' });
      }
      if (!db.objectStoreNames.contains(ASSETS)) {
        const assets = db.createObjectStore(ASSETS, { keyPath: 'id' });
        assets.createIndex('itemId', 'itemId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开本地文库失败'));
  });
  return database;
}

function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('本地文库读写失败'));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('本地文库事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('本地文库事务已取消'));
  });
}

export async function listItems(): Promise<SlackItem[]> {
  const db = await openDatabase();
  const items = await toPromise<SlackItem[]>(
    db.transaction(ITEMS, 'readonly').objectStore(ITEMS).getAll(),
  );
  return items.sort((a, b) => b.openedAt - a.openedAt || b.createdAt - a.createdAt);
}

export async function getItem(id: string): Promise<SlackItem | null> {
  const db = await openDatabase();
  const item = await toPromise<SlackItem | undefined>(
    db.transaction(ITEMS, 'readonly').objectStore(ITEMS).get(id),
  );
  return item ?? null;
}

/** 一个导入条目只提交一次：任一正文/图片写入失败，三个 store 一起回滚。 */
export async function putLibraryEntry(
  item: SlackItem,
  chapters: SlackChapter[],
  assets: ParsedAsset[],
): Promise<SlackItem> {
  const db = await openDatabase();
  const transaction = db.transaction([ITEMS, CHAPTERS, ASSETS], 'readwrite');
  const completion = done(transaction);
  let saved = item;
  try {
    // Keep the duplicate check and all writes in one transaction, including
    // simultaneous imports from another tab. Existing progress is untouched.
    const request = transaction.objectStore(ITEMS).getAll();
    request.onsuccess = () => {
      const existing = item.contentSha256 && (request.result as SlackItem[]).find(value => value.contentSha256 === item.contentSha256);
      if (existing) { saved = existing; return; }
      transaction.objectStore(ITEMS).add(item);
      transaction.objectStore(CHAPTERS).add({ itemId: item.id, chapters } satisfies ChapterSet);
      const store = transaction.objectStore(ASSETS);
      for (const asset of assets) store.add({ ...asset, itemId: item.id });
    };
  } catch (cause) {
    transaction.abort();
    await completion.catch(() => {});
    throw cause;
  }
  await completion;
  return saved;
}

export async function touchItem(id: string): Promise<SlackItem | null> {
  const db = await openDatabase();
  const transaction = db.transaction(ITEMS, 'readwrite');
  const store = transaction.objectStore(ITEMS);
  let updated: SlackItem | null = null;
  const request = store.get(id);
  request.onsuccess = () => {
    const item = request.result as SlackItem | undefined;
    if (!item) return;
    item.openedAt = Date.now();
    updated = item;
    store.put(item);
  };
  await done(transaction);
  return updated;
}

export async function updateProgress(id: string, progress: SlackProgress): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(ITEMS, 'readwrite');
  const store = transaction.objectStore(ITEMS);
  const request = store.get(id);
  request.onsuccess = () => {
    const item = request.result as SlackItem | undefined;
    if (!item) return;
    item.progress = progress;
    store.put(item);
  };
  await done(transaction);
}

export async function getChapters(itemId: string): Promise<SlackChapter[]> {
  const db = await openDatabase();
  const record = await toPromise<ChapterSet | undefined>(
    db.transaction(CHAPTERS, 'readonly').objectStore(CHAPTERS).get(itemId),
  );
  return record?.chapters ?? [];
}

/** 连载刷新目录：书目元数据和章节目录一起替换，任一步失败一起回滚。 */
export async function replaceItemAndChapters(
  item: SlackItem,
  chapters: SlackChapter[],
): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([ITEMS, CHAPTERS], 'readwrite');
  transaction.objectStore(ITEMS).put(item);
  transaction.objectStore(CHAPTERS).put({ itemId: item.id, chapters } satisfies ChapterSet);
  await done(transaction);
}

/** 连载按章加载后把正文写回章节集合，保留目录里的其它章节。 */
export async function updateChapter(itemId: string, chapter: SlackChapter): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(CHAPTERS, 'readwrite');
  const store = transaction.objectStore(CHAPTERS);
  const request = store.get(itemId);
  request.onsuccess = () => {
    const record = request.result as ChapterSet | undefined;
    if (!record) return;
    record.chapters = record.chapters.map((entry) =>
      entry.order === chapter.order ? chapter : entry,
    );
    store.put(record);
  };
  await done(transaction);
}

export async function getAsset(id: string): Promise<SlackAsset | null> {
  const db = await openDatabase();
  const asset = await toPromise<SlackAsset | undefined>(
    db.transaction(ASSETS, 'readonly').objectStore(ASSETS).get(id),
  );
  return asset ?? null;
}

export async function getAssets(itemId: string): Promise<SlackAsset[]> {
  const db = await openDatabase();
  const assets = await toPromise<SlackAsset[]>(
    db.transaction(ASSETS, 'readonly').objectStore(ASSETS).index('itemId').getAll(itemId),
  );
  return assets.sort((a, b) => a.order - b.order);
}

export async function deleteItemDeep(id: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([ITEMS, CHAPTERS, ASSETS], 'readwrite');
  transaction.objectStore(ITEMS).delete(id);
  transaction.objectStore(CHAPTERS).delete(id);
  const assets = transaction.objectStore(ASSETS);
  const cursor = assets.index('itemId').openKeyCursor(IDBKeyRange.only(id));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    assets.delete(current.primaryKey);
    current.continue();
  };
  await done(transaction);
}
