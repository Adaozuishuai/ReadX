// 工作区路径解析与本地 JSON 读写。
//
// 与 macOS 版的区别：macOS 用 bundle 内 Resources/ROOT.txt + 向上找 queue.json。
// Windows 版沿用同一「向上找 queue.json」的根目录判定，因此指向同一个项目根时
// 直接读写同一份 queue.json / papers / library / app/data，不需要任何数据迁移。

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** 工作区根：依次尝试 环境变量 -> 显式覆盖 -> 从起点向上找 queue.json -> 当前目录。 */
export function findRoot(startDir?: string, override?: string | null): string {
  if (override) return path.resolve(override);
  const env = process.env.CBCT_ROOT;
  if (env) return path.resolve(env);

  let dir = path.resolve(startDir ?? process.cwd());
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'queue.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir ?? process.cwd());
}

// 渲染进程传来的 key 会直接拼进文件名或当对象键使用，必须挡住两类攻击：
//   1) 原型污染：obj['__proto__'] = ... 走 setter，会改写对象原型（C3 旧缺陷）；
//   2) 路径穿越：key='../../queue' 可越出数据目录读写（path.join 会归一化 ..）。
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 用作 Record 键的安全性：非保留名、非空、无 NUL。 */
export function isSafeObjectKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 300 &&
    !UNSAFE_KEYS.has(key) && !key.includes('\0');
}

/** 用作文件名一部分的安全性：在对象键基础上再禁 ..、绝对路径与盘符。 */
export function isSafePathKey(key: unknown): key is string {
  if (!isSafeObjectKey(key)) return false;
  return !key.includes('..') && !key.startsWith('/') && !key.startsWith('\\') && !/^[A-Za-z]:/.test(key);
}

export function assertSafePathKey(key: string, what = 'key'): string {
  if (!isSafePathKey(key)) {
    throw new Error(`非法${what}（含路径穿越或保留名，已拒绝）：${JSON.stringify(String(key).slice(0, 60))}`);
  }
  return key;
}

export class Paths {
  constructor(public readonly root: string) {}

  get papersDir(): string { return path.join(this.root, 'papers'); }
  get libraryDir(): string { return path.join(this.root, 'library'); }
  get textDir(): string { return path.join(this.libraryDir, 'text'); }
  get queuePath(): string { return path.join(this.root, 'queue.json'); }
  get dataDir(): string { return path.join(this.root, 'app', 'data'); }
  get configPath(): string { return path.join(this.root, 'app', 'config.json'); }
  get profilePath(): string { return path.join(this.dataDir, 'profile.json'); }
  get libraryStatePath(): string { return path.join(this.dataDir, 'library.json'); }
  get discoveryPath(): string { return path.join(this.dataDir, 'discovery.json'); }
  get progressPath(): string { return path.join(this.dataDir, 'progress.json'); }
  get comparePath(): string { return path.join(this.dataDir, 'compare.json'); }
  get ideasPath(): string { return path.join(this.dataDir, 'ideas.json'); }
  readingsPath(key: string): string { return path.join(this.dataDir, 'readings', `${assertSafePathKey(key)}.json`); }
  readingsHistoryDir(): string { return path.join(this.dataDir, 'readings', 'history'); }
  pdfTextPath(key: string): string { return path.join(this.textDir, `${assertSafePathKey(key)}-v3.txt`); }
  indexPath(key: string): string { return path.join(this.dataDir, 'embeddings', `${assertSafePathKey(key)}.json`); }
}

/**
 * 原子写入：先写同目录临时文件再 rename。
 * 与 macOS 版一致，避免进程中断后留下半截 JSON（曾导致队列静默加载为空）。
 */
export function atomicWrite(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响原始错误 */ }
    throw err;
  }
}

export function readJSON<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 读取 JSON，但区分「文件不存在」与「文件损坏」。
 * 损坏必须显式报错：静默回退成默认值会在下次保存时覆盖掉用户数据。
 */
export function readJSONStrict<T>(file: string): { ok: true; value: T } | { ok: false; missing: boolean; error: string } {
  if (!fs.existsSync(file)) return { ok: false, missing: true, error: '文件不存在' };
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return { ok: false, missing: false, error: '文件为空' };
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (e) {
    return { ok: false, missing: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function saveJSON(file: string, value: unknown): void {
  atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
}

/** 在 library/ 下按 key 找 PDF 文件名（与 macOS 版同样的三种匹配顺序）。 */
export function findLocalPdf(paths: Paths, key: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(paths.libraryDir);
  } catch {
    return null;
  }
  const pdfs = names.filter((n) => n.toLowerCase().endsWith('.pdf'));
  const hit =
    pdfs.find((n) => n === `${key}.pdf`) ??
    pdfs.find((n) => n.endsWith(`-${key}.pdf`)) ??
    (key.length >= 6 ? pdfs.find((n) => n.includes(key)) : undefined);
  return hit ? path.join(paths.libraryDir, hit) : null;
}

/** 全文缓存是否来自 OCR（OCR 文本的摘录校验可能失效，必须提示人工核对）。 */
export const OCR_MARKER = '【OCR 转写 · 扫描版 PDF：文本来自机器识别，摘录校验可能失效，请人工核对】';
export function isOCRSource(cached: string | null): boolean {
  return (cached ?? '').startsWith(OCR_MARKER);
}

/** 缓存的全文（`=== Page N ===` 分页），与 macOS 版共用同一份文件。 */
export function readCachedPDFText(paths: Paths, key: string): string | null {
  try {
    const s = fs.readFileSync(paths.pdfTextPath(key), 'utf8');
    return s.trim() ? s : null;
  } catch {
    return null;
  }
}

export function timestampSlug(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function today(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function userDataDir(appName = 'cbct-reading-windows'): string {
  const base = process.env.APPDATA ?? path.join(os.homedir(), '.config');
  return path.join(base, appName);
}
