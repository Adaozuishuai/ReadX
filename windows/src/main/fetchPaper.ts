// 自动导入：从论文的 pdfUrl 下载 PDF、抽取文本、落盘。
//
// 背景：发现页的论文已经带 pdfUrl（arXiv 的是公开可直接下载的 PDF），但此前必须
// 手动下载再手动导入；Windows 版也没有 PDF 文本抽取能力，只能读 macOS 生成的缓存。
// 这里补上「下载 -> 抽取 -> 写入 library/ 与 library/text/」的完整链路。
//
// 硬约束：
//  - 只下载论文自带的 pdfUrl，绝不猜 URL、绝不绕过任何访问限制（PRD 排除付费全文绕过）；
//  - 下载必须有超时与大小上限，避免挂起或撑爆内存；
//  - 抽不出文本（扫描件）时如实报告需要 OCR，而不是存一份空缓存冒充「有全文」。

import * as fs from 'fs';
import * as path from 'path';

import { Paths, atomicWrite } from '../core/store';
import { looksLikePdf, groupItemsIntoLines, formatPdfPages, PdfPageLines, isLikelyScanned } from '../core/pdfText';

const UA = 'cbct-reading-windows/0.1 (research reading assistant)';
const MAX_PDF_BYTES = 80 * 1024 * 1024;   // 80 MB：正常论文远小于此，防异常大文件
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface ImportResult {
  ok: boolean;
  key: string;
  /** 本次实际发生的动作：downloaded=新下载了 PDF；extracted=复用本地 PDF 重新抽取；skipped=已有全文缓存。 */
  action?: 'downloaded' | 'extracted' | 'skipped';
  pdfPath?: string;
  textPath?: string;
  pages?: number;
  chars?: number;
  error?: string;
  /** 导入成功但附带动作（如写入 queue.json）失败时的警示，不影响 ok。 */
  warning?: string;
}

/** 下载 PDF 字节；带超时、大小上限与魔数校验。 */
export async function downloadPdf(url: string): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('PDF 地址无效');
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) throw new Error('PDF 地址必须是 http/https');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(parsed, { headers: { 'User-Agent': UA }, signal: ac.signal, redirect: 'follow' });
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    const len = Number(resp.headers.get('content-length') ?? '0');
    if (len && len > MAX_PDF_BYTES) throw new Error(`PDF 过大（${Math.round(len / 1024 / 1024)} MB），已跳过`);
    // 分块读取并边读边限额：服务器不报 content-length（或谎报）时，
    // arrayBuffer() 会把任意大的响应体整个缓冲进内存。
    const buf = await readBodyCapped(resp, MAX_PDF_BYTES);
    if (!looksLikePdf(buf)) throw new Error('返回内容不是 PDF（可能是登录页或重定向）');
    return buf;
  } catch (e) {
    if (e instanceof Error && /abort/i.test(e.message)) throw new Error('下载超时，请稍后重试');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 流式读取响应体；超过上限立即取消并报错（不先缓冲后检查）。 */
async function readBodyCapped(resp: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error('下载失败：响应没有内容');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`PDF 过大（超过 ${Math.round(maxBytes / 1024 / 1024)} MB），已中止下载`);
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => { /* 取消失败不影响原错误 */ });
    throw e;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * 用 pdfjs 抽取按页文本。
 *
 * 必须是**真正的** dynamic import()：Electron 33 的 Node 20 不支持 require() 一个 ESM 包，
 * 而 pdfjs-dist 只发 ESM（实测 require 抛 ERR_REQUIRE_ESM，import() 正常）。
 *
 * 坑：TypeScript 在 module=CommonJS 下会把 `import(...)` 转译成
 * `Promise.resolve().then(() => require(...))`，于是又变回 require 而失败。
 * 因此这里用运行时构造的 import，绕开编译器的转译。
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs: any = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  // 关掉 eval 与系统字体，降低在本地解析不可信 PDF 的风险
  const doc = await pdfjs.getDocument({
    data: bytes,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
  }).promise;
  const pages: PdfPageLines[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items = content.items
        .filter((it: any) => typeof it.str === 'string')
        .map((it: any) => ({ str: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number }));
      pages.push({ number: n, lines: groupItemsIntoLines(items) });
    }
  } finally {
    // 及时释放 pdfjs 的 worker/资源，避免批量导入时堆积
    await doc.destroy?.();
  }
  return formatPdfPages(pages);
}

/**
 * 解析出可下载的 PDF 地址。
 *
 * 优先用条目自带的 pdfUrl；若没有但 key 是 arXiv 号，则用 arXiv 的**规范**地址
 * `https://arxiv.org/pdf/<id>`（这不是猜：arXiv 的 PDF 路径规则固定，且 C2RV 等
 * 从笔记进入的论文只有 arXiv 号、没有 pdfUrl）。其余情况保持没有，交由调用方如实报告。
 */
export function resolvePdfUrl(key: string, pdfUrl: string | null | undefined): string | null {
  if (pdfUrl && pdfUrl.trim()) return pdfUrl.trim();
  if (/^[0-9]{4}\.[0-9]{4,5}$/.test(key)) return `https://arxiv.org/pdf/${key}`;
  return null;
}

/**
 * 导入一篇论文：若本地已有 PDF 则复用；否则按 url 下载。
 * 抽取文本并写入 `library/text/<key>-v3.txt`（与 macOS 版同一文件名，两侧共用）。
 *
 * @param force 为 true 时即使本地已有缓存也重新抽取（用户手动点「重新导入」）
 */
export async function importPaper(
  paths: Paths,
  key: string,
  pdfUrl: string | null | undefined,
  force = false,
): Promise<ImportResult> {
  if (!key) return { ok: false, key, error: '论文缺少 key，无法导入' };

  const textPath = paths.pdfTextPath(key);
  const existingPdf = findExisting(paths, key);

  // 已有全文缓存且不强制：直接视为已导入（不重复下载）
  if (!force && fs.existsSync(textPath) && fs.statSync(textPath).size > 0) {
    return { ok: true, key, action: 'skipped', pdfPath: existingPdf ?? undefined, textPath };
  }

  fs.mkdirSync(paths.libraryDir, { recursive: true });
  let pdfPath = existingPdf;

  if (!pdfPath) {
    const url = resolvePdfUrl(key, pdfUrl);
    if (!url) return { ok: false, key, error: '该论文没有可下载的 PDF 地址（PubMed 元数据不保证可下载全文），请手动导入' };
    let bytes: Uint8Array;
    try {
      bytes = await downloadPdf(url);
    } catch (e) {
      return { ok: false, key, error: e instanceof Error ? e.message : String(e) };
    }
    pdfPath = path.join(paths.libraryDir, `${key}.pdf`);
    atomicWriteBytes(pdfPath, bytes);
  }

  let text: string;
  try {
    text = await extractPdfText(new Uint8Array(fs.readFileSync(pdfPath)));
  } catch (e) {
    return { ok: false, key, pdfPath, error: `PDF 文本抽取失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const pages = (text.match(/=== Page /g) ?? []).length;
  if (isLikelyScanned(text)) {
    // 扫描件抽不出文字：保留 PDF，但不写空缓存冒充「有全文」。
    // 如实报告需要 OCR（界面会引导走「公式 OCR / 页面 OCR」把页面转成文本）。
    return { ok: false, key, pdfPath, error: 'PDF 抽不出可读文字（可能是扫描件）。请用精读室「方法与公式」里的页面 OCR 把页面转成文本，或改用带文本层的 PDF。' };
  }

  atomicWrite(textPath, text);
  return { ok: true, key, action: existingPdf ? 'extracted' : 'downloaded', pdfPath, textPath, pages, chars: text.length };
}

function findExisting(paths: Paths, key: string): string | null {
  // 与 store.findLocalPdf 同序：key.pdf -> *-key.pdf -> 包含 key
  let names: string[] = [];
  try { names = fs.readdirSync(paths.libraryDir); } catch { return null; }
  const pdfs = names.filter((n) => n.toLowerCase().endsWith('.pdf'));
  const hit = pdfs.find((n) => n === `${key}.pdf`)
    ?? pdfs.find((n) => n.endsWith(`-${key}.pdf`))
    ?? (key.length >= 6 ? pdfs.find((n) => n.includes(key)) : undefined);
  return hit ? path.join(paths.libraryDir, hit) : null;
}

/** 原子写二进制：先写临时文件再 rename，避免中断留下半截 PDF。 */
function atomicWriteBytes(target: string, bytes: Uint8Array): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, bytes);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响原始错误 */ }
    throw e;
  }
}
