import JSZip from 'jszip';
import { newId } from './db';
import type { ParsedAsset, ParsedChapter, ParsedComic, ParsedNovel } from './types';

const XLINK = 'http://www.w3.org/1999/xlink';
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const IMAGE_MEDIA = /^image\//i;
const HTML_MEDIA = /(x?html?|xml)$/i;
const TEXT_NAME = /\.(txt|md|markdown|text)$/i;

const DROP_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'audio', 'video', 'form', 'input', 'button', 'select', 'textarea', 'noscript',
  'template', 'canvas',
]);

const ALLOWED_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'sup', 'sub',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'code', 'pre',
]);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function baseName(name: string): string {
  const clean = name.split(/[\\/]/).pop() ?? name;
  return clean.replace(/\.[^./\\]+$/, '').trim() || '未命名资料';
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_NAME.test(file.name);
}

export function isEpubFile(file: File): boolean {
  return file.type === 'application/epub+zip' || /\.epub$/i.test(file.name);
}

export function isTextFile(file: File): boolean {
  return file.type.startsWith('text/') || TEXT_NAME.test(file.name);
}

export function isComicArchive(file: File): boolean {
  return /\.(zip|cbz)$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-cbz';
}

export function imageMime(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'avif') return 'image/avif';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

/** 多张图片作为一本漫画时，用文件名公共前缀当书名；前缀没意义就退回第一页文件名。 */
export function comicTitleFromFiles(files: File[]): string {
  const names = files.map((file) => baseName(file.name));
  const first = names[0];
  if (!first) return '未命名漫画';
  if (names.length === 1) return first;
  let prefix = first;
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  const cleaned = prefix
    .replace(/[\s_\-—·.]*[0-9]*[\s_\-—·.]*$/, '')
    .trim();
  return cleaned.length >= 2 ? cleaned : first;
}

export async function parseTextFile(file: File): Promise<ParsedNovel> {
  const text = decodeBytes(await file.arrayBuffer());
  if (!text.trim()) throw new Error('文本是空的');
  const title = baseName(file.name);
  return {
    title,
    author: '',
    chapters: splitNovelText(text, title),
    assets: [],
    coverAssetId: '',
    sizeBytes: file.size,
  };
}

export async function parseComicImages(files: File[], title: string): Promise<ParsedComic> {
  const sorted = [...files].sort((a, b) => collator.compare(a.name, b.name));
  const assets: ParsedAsset[] = sorted.map((file, index) => ({
    id: newId(),
    order: index,
    name: file.name,
    mime: file.type || imageMime(file.name),
    blob: file,
  }));
  return {
    title,
    assets,
    sizeBytes: files.reduce((total, file) => total + file.size, 0),
  };
}

export async function parseComicArchive(file: File): Promise<ParsedComic> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && IMAGE_NAME.test(entry.name) && !/(^|\/)(__MACOSX|\._)/.test(entry.name))
    .sort((a, b) => collator.compare(a.name, b.name));
  if (!entries.length) throw new Error('压缩包里没有找到图片');
  const assets: ParsedAsset[] = [];
  for (const entry of entries) {
    const blob = new Blob([await entry.async('blob')], { type: imageMime(entry.name) });
    assets.push({
      id: newId(),
      order: assets.length,
      name: entry.name,
      mime: imageMime(entry.name),
      blob,
    });
  }
  return { title: baseName(file.name), assets, sizeBytes: file.size };
}

export async function parseEpubFile(file: File): Promise<ParsedNovel> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const containerFile = findZipFile(zip, 'META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  const container = parseXml(await containerFile.async('string'), true);
  const opfPath = localElements(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('不是有效的 EPUB：找不到 OPF 文件');
  const opfFile = findZipFile(zip, opfPath);
  if (!opfFile) throw new Error('EPUB 的 OPF 文件缺失');
  const opf = parseXml(await opfFile.async('string'), true);
  const opfDir = dirname(opfPath);

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  const assetByPath = new Map<string, ParsedAsset>();
  const assets: ParsedAsset[] = [];
  let assetOrder = 0;

  const manifestEl = localElements(opf, 'manifest')[0];
  const manifestItems = manifestEl ? localElements(manifestEl, 'item') : [];
  for (const item of manifestItems) {
    const id = item.getAttribute('id') ?? '';
    const href = item.getAttribute('href') ?? '';
    if (!id || !href) continue;
    const mediaType = item.getAttribute('media-type') ?? '';
    const properties = item.getAttribute('properties') ?? '';
    const path = resolvePath(opfDir, href);
    manifest.set(id, { href: path, mediaType, properties });
    if (IMAGE_MEDIA.test(mediaType)) {
      const asset = await readZipAsset(zip, path, mediaType, assetOrder);
      if (asset) {
        assetOrder += 1;
        assets.push(asset);
        assetByPath.set(path, asset);
      }
    }
  }

  let coverPath = '';
  const coverItem = manifestItems.find((item) =>
    (item.getAttribute('properties') ?? '').split(/\s+/).includes('cover-image'),
  );
  if (coverItem) coverPath = resolvePath(opfDir, coverItem.getAttribute('href') ?? '');
  if (!coverPath) {
    const coverMeta = localElements(opf, 'meta').find((meta) => meta.getAttribute('name') === 'cover');
    const coverId = coverMeta?.getAttribute('content') ?? '';
    coverPath = manifest.get(coverId)?.href ?? '';
  }
  if (!coverPath) coverPath = assets.find((asset) => /cover/i.test(asset.name))?.name ?? '';
  if (!coverPath) coverPath = assets[0]?.name ?? '';

  const spineEl = localElements(opf, 'spine')[0];
  const refs = spineEl ? localElements(spineEl, 'itemref') : [];
  const chapters: ParsedChapter[] = [];
  for (const ref of refs) {
    const entry = manifest.get(ref.getAttribute('idref') ?? '');
    if (!entry) continue;
    if (!HTML_MEDIA.test(entry.mediaType) && !/\.(x?html?)$/i.test(entry.href)) continue;
    const chapterFile = findZipFile(zip, entry.href);
    if (!chapterFile) continue;
    const document_ = parseXml(await chapterFile.async('string'), false);
    const body = localElements(document_, 'body')[0] ?? document_.documentElement;
    if (!body) continue;
    const chapterDir = dirname(entry.href);

    // 先补齐本章引用但未出现在 manifest 里的图片，再同步改写 HTML。
    const imageNodes = Array.from(body.querySelectorAll('img, image'));
    for (const node of imageNodes) {
      const href = imageHref(node);
      if (!href || href.startsWith('data:')) continue;
      const path = resolvePath(chapterDir, href);
      if (!path || assetByPath.has(path)) continue;
      const asset = await readZipAsset(zip, path, imageMime(path), assetOrder);
      if (!asset) continue;
      assetOrder += 1;
      assets.push(asset);
      assetByPath.set(path, asset);
    }

    const resolveImage = (href: string): string | null => {
      if (href.startsWith('data:')) return href;
      const path = resolvePath(chapterDir, href);
      const asset = assetByPath.get(path);
      return asset ? `slack-asset://${asset.id}` : null;
    };
    const title = chapterTitle(document_, body, chapters.length + 1);
    sanitizeChildren(body, resolveImage);
    const html = body.innerHTML.trim();
    const text = (body.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    if (!html && !text) continue;
    chapters.push({ title, text, html });
  }

  if (!chapters.length) throw new Error('EPUB 里没有可读的章节');
  const title =
    localElements(opf, 'title').map((node) => node.textContent?.trim()).find(Boolean) ??
    baseName(file.name);
  const author =
    localElements(opf, 'creator').map((node) => node.textContent?.trim()).find(Boolean) ?? '';
  const coverAssetId = coverPath ? (assetByPath.get(coverPath)?.id ?? '') : '';

  return { title, author, chapters, assets, coverAssetId, sizeBytes: file.size };
}

/** 按行识别「第 X 章 / Chapter N / 1. 标题」这类标题行；识别不到就按篇幅切节。 */
export function splitNovelText(text: string, bookTitle = ''): ParsedChapter[] {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const marks: { line: number; title: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (isHeading(line)) marks.push({ line: index, title: line.trim() });
  }

  if (!marks.length) return chunkText(normalized);

  const chapters: ParsedChapter[] = [];
  const prefix = lines.slice(0, marks[0]?.line ?? 0).join('\n').trim();
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    if (!mark) continue;
    const end = marks[index + 1]?.line ?? lines.length;
    let content = lines.slice(mark.line + 1, end).join('\n').trim();
    const sameAsTitle =
      Boolean(bookTitle.trim()) && prefix.trim().toLowerCase() === bookTitle.trim().toLowerCase();
    if (index === 0 && prefix && !sameAsTitle && prefix.length < 240) {
      content = `${prefix}\n\n${content}`.trim();
    } else if (index === 0 && prefix && !sameAsTitle) {
      chapters.push({ title: '前言', text: prefix, html: '' });
    }
    chapters.push({ title: mark.title, text: content || mark.title, html: '' });
  }

  if (chapters.length === 1 && chapters[0] && chapters[0].text.length > 12000) {
    return chunkText(chapters[0].text, chapters[0].title);
  }
  return chapters;
}

function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 38) return false;
  if (/[。！？!?；;，,]$/.test(trimmed)) return false;
  return /^(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回卷部篇集话話]|(?:序章|楔子|引子|前言|序言|后记|尾声|终章|番外(?:篇)?)|(?:chapter|CHAPTER)\s*(?:[0-9]+|[ivxlcdmIVXLCDM]+)|[0-9]{1,4}[、.．]\s*\S)/.test(
    trimmed,
  );
}

function chunkText(text: string, firstTitle = '正文'): ParsedChapter[] {
  const paragraphs = text.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const chunks: ParsedChapter[] = [];
  let buffer = '';
  for (const paragraph of paragraphs.length ? paragraphs : [text]) {
    if (buffer && buffer.length + paragraph.length > 7000) {
      chunks.push({ title: chunks.length === 0 ? firstTitle : `第 ${chunks.length + 1} 节`, text: buffer.trim(), html: '' });
      buffer = '';
    }
    buffer += `${paragraph}\n\n`;
    while (buffer.length > 9000) {
      chunks.push({ title: chunks.length === 0 ? firstTitle : `第 ${chunks.length + 1} 节`, text: buffer.slice(0, 8000).trim(), html: '' });
      buffer = buffer.slice(8000);
    }
  }
  if (buffer.trim()) {
    chunks.push({ title: chunks.length === 0 ? firstTitle : `第 ${chunks.length + 1} 节`, text: buffer.trim(), html: '' });
  }
  return chunks.length ? chunks : [{ title: firstTitle, text, html: '' }];
}

function decodeBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

function parseXml(text: string, strict: boolean): Document {
  const parsed = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  const failed = parsed.querySelector('parsererror');
  if (!failed) return parsed;
  if (strict) throw new Error('XML 解析失败');
  return new DOMParser().parseFromString(text, 'text/html');
}

function localElements(root: Document | Element, name: string): Element[] {
  const all = root.getElementsByTagName('*');
  const matches: Element[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const element = all[index];
    if (element && element.localName?.toLowerCase() === name.toLowerCase()) matches.push(element);
  }
  return matches;
}

function findZipFile(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const direct = zip.file(path);
  if (direct) return direct;
  const wanted = path.toLowerCase();
  const actual = Object.keys(zip.files).find((name) => name.toLowerCase() === wanted);
  return actual ? (zip.file(actual) ?? null) : null;
}

async function readZipAsset(
  zip: JSZip,
  path: string,
  mime: string,
  order: number,
): Promise<ParsedAsset | null> {
  const file = findZipFile(zip, path);
  if (!file) return null;
  const blob = new Blob([await file.async('blob')], { type: mime });
  return { id: newId(), order, name: path, mime, blob };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function resolvePath(baseDir: string, href: string): string {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return '';
  let relative = href.split('#')[0]?.split('?')[0] ?? '';
  try {
    relative = decodeURIComponent(relative);
  } catch {
    /* 保留原始百分号编码：后面按字面量查 zip 条目。 */
  }
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function imageHref(element: Element): string {
  return (
    element.getAttribute('src') ??
    element.getAttribute('href') ??
    element.getAttributeNS(XLINK, 'href') ??
    element.getAttribute('xlink:href') ??
    ''
  );
}

function chapterTitle(document_: Document, body: Element, index: number): string {
  for (const name of ['h1', 'h2', 'h3']) {
    const heading = localElements(body, name)[0]?.textContent?.trim();
    if (heading) return heading.slice(0, 80);
  }
  const docTitle = localElements(document_, 'title')[0]?.textContent?.trim();
  return docTitle ? docTitle.slice(0, 80) : `第 ${index} 章`;
}

function sanitizeChildren(container: Element, resolveImage: (href: string) => string | null): void {
  for (const child of Array.from(container.children)) sanitizeElement(child, resolveImage);
}

function sanitizeElement(element: Element, resolveImage: (href: string) => string | null): void {
  for (const child of Array.from(element.children)) sanitizeElement(child, resolveImage);
  const tag = element.localName?.toLowerCase() ?? '';

  if (DROP_TAGS.has(tag)) {
    element.remove();
    return;
  }

  if (tag === 'image') {
    const src = resolveImage(imageHref(element));
    if (!src) {
      element.remove();
      return;
    }
    const image = element.ownerDocument.createElement('img');
    image.setAttribute('src', src);
    image.setAttribute('alt', '');
    element.replaceWith(image);
    return;
  }

  if (tag === 'img') {
    const src = resolveImage(imageHref(element));
    if (!src) {
      element.remove();
      return;
    }
    for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
    element.setAttribute('src', src);
    element.setAttribute('alt', '');
    return;
  }

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const keep =
      (tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan');
    if (!keep) element.removeAttribute(attribute.name);
  }

  if (!ALLOWED_TAGS.has(tag)) {
    const parent = element.parentNode;
    if (parent) {
      while (element.firstChild) parent.insertBefore(element.firstChild, element);
      element.remove();
    }
  }
}
