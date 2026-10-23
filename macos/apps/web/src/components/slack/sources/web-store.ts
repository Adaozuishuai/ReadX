import type { WebBookSource, WebSourceRules } from './web-types';

const STORAGE_KEY = 'readx-slack-web-sources';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hash(value: string): string {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(result).toString(36);
}

function normalizeCharset(value: string): string {
  const charset = value.trim().toLowerCase() || 'utf-8';
  if (charset === 'utf8') return 'utf-8';
  if (charset === 'gb2312' || charset === 'gb_2312' || charset === 'gb-2312') return 'gbk';
  return charset;
}

function pick(legacy: Record<string, unknown>, modern: Record<string, unknown>, legacyKey: string, modernKey: string): string {
  return asText(legacy[legacyKey]) || asText(modern[modernKey]);
}

/**
 * 同时接受本项目简化格式和 Legado 书源 JSON：
 *   Legado: bookSourceName / bookSourceUrl / searchUrl / ruleSearch / ruleBookInfo / ruleToc / ruleContent
 *   简化:   name / baseUrl / searchUrl / rules.search / rules.book / rules.toc / rules.content
 * 规则字符串本体（@css: / @XPath: / @json:）由 web-rules.ts 解释。
 */
export function normalizeBookSource(rawValue: unknown): WebBookSource {
  const raw = asRecord(rawValue);
  const modern = asRecord(raw.rules);
  const legacySearch = asRecord(raw.ruleSearch);
  const legacyBook = asRecord(raw.ruleBookInfo);
  const legacyToc = asRecord(raw.ruleToc);
  const legacyContent = asRecord(raw.ruleContent);
  const modernSearch = asRecord(modern.search);
  const modernBook = asRecord(modern.book);
  const modernToc = asRecord(modern.toc);
  const modernContent = asRecord(modern.content);

  const type = raw.bookSourceType;
  const unsupportedType = typeof type === 'number' && type !== 0;

  const name = asText(raw.bookSourceName) || asText(raw.name);
  const baseUrlRaw = asText(raw.bookSourceUrl) || asText(raw.baseUrl);
  const searchUrl = asText(raw.searchUrl);
  const charset = normalizeCharset(
    asText(raw.bookSourceCharset) || asText(raw.charset) || 'utf-8',
  );

  const rules: WebSourceRules = {
    search: {
      list: pick(legacySearch, modernSearch, 'bookList', 'list'),
      name: pick(legacySearch, modernSearch, 'name', 'name'),
      author: pick(legacySearch, modernSearch, 'author', 'author'),
      bookUrl: pick(legacySearch, modernSearch, 'bookUrl', 'bookUrl'),
      cover: pick(legacySearch, modernSearch, 'coverUrl', 'cover'),
      intro: pick(legacySearch, modernSearch, 'intro', 'intro'),
      lastChapter: pick(legacySearch, modernSearch, 'lastChapter', 'lastChapter'),
    },
    book: {
      name: pick(legacyBook, modernBook, 'name', 'name'),
      author: pick(legacyBook, modernBook, 'author', 'author'),
      intro: pick(legacyBook, modernBook, 'intro', 'intro'),
      cover: pick(legacyBook, modernBook, 'coverUrl', 'cover'),
      tocUrl: pick(legacyBook, modernBook, 'tocUrl', 'tocUrl'),
    },
    toc: {
      list: pick(legacyToc, modernToc, 'chapterList', 'list'),
      name: pick(legacyToc, modernToc, 'chapterName', 'name'),
      url: pick(legacyToc, modernToc, 'chapterUrl', 'url'),
    },
    content: {
      content: pick(legacyContent, modernContent, 'content', 'content'),
      remove: asText(legacyContent.remove) || asText(modernContent.remove),
      next: pick(legacyContent, modernContent, 'nextContentUrl', 'next'),
    },
  };

  const missing: string[] = [];
  if (!name) missing.push('书源名称');
  if (!baseUrlRaw) missing.push('书源地址');
  if (!searchUrl) missing.push('搜索地址');
  if (!rules.search.list || !rules.search.name || !rules.search.bookUrl) missing.push('搜索规则');
  if (!rules.toc.list || !rules.toc.name || !rules.toc.url) missing.push('目录规则');
  if (!rules.content.content) missing.push('正文规则');
  if (missing.length) {
    throw new Error(`书源「${name || '未命名'}」缺少：${missing.join('、')}`);
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    throw new Error(`书源「${name}」的地址不是有效 URL`);
  }
  if (baseUrl.protocol !== 'https:') {
    throw new Error(`书源「${name}」必须使用 HTTPS`);
  }
  if (/^https?:/i.test(searchUrl) && !searchUrl.toLowerCase().startsWith('https:')) {
    throw new Error(`书源「${name}」的搜索地址必须使用 HTTPS`);
  }

  const ruleText = JSON.stringify({ searchUrl, rules, legacy: raw });
  let unsupported = '';
  if (unsupportedType) unsupported = '只支持文本书源（bookSourceType=0）';
  else if (/@js:/i.test(ruleText)) unsupported = '包含 @js: 规则（当前不支持）';
  else if (/,{\s*"method"\s*:/i.test(searchUrl)) unsupported = '包含 POST/JSON 搜索配置（当前不支持）';

  return {
    id: `web-${hash(`${name}|${baseUrl.toString()}`)}`,
    name,
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    charset,
    searchUrl,
    rules,
    enabled: raw.enabled !== false && raw.bookSourceEnabled !== false,
    unsupported: unsupported || undefined,
  };
}

export interface ParsedSources {
  sources: WebBookSource[];
  errors: string[];
}

export function parseBookSources(text: string): ParsedSources {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON');
  }
  const record = asRecord(parsed);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record.bookSources)
      ? record.bookSources
      : [parsed];
  if (!list.length) throw new Error('JSON 里没有书源');

  const sources: WebBookSource[] = [];
  const errors: string[] = [];
  for (const item of list) {
    try {
      sources.push(normalizeBookSource(item));
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
    }
  }
  if (!sources.length) throw new Error(errors.join('；') || '没有可用的书源');
  return { sources, errors };
}

export function loadWebSources(): WebBookSource[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const sources: WebBookSource[] = [];
    for (const item of parsed) {
      try {
        sources.push(normalizeBookSource(item));
      } catch {
        /* 跳过损坏的旧记录。 */
      }
    }
    return sources;
  } catch {
    return [];
  }
}

export function saveWebSources(sources: WebBookSource[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  } catch {
    /* localStorage 不可用时本次会话仍然生效。 */
  }
}

export function mergeWebSources(current: WebBookSource[], incoming: WebBookSource[]): WebBookSource[] {
  const key = (source: WebBookSource) => `${source.name}|${source.baseUrl}`;
  const merged = new Map(current.map((source) => [key(source), source]));
  for (const source of incoming) merged.set(key(source), source);
  return Array.from(merged.values());
}

export function getWebSource(id: string): WebBookSource | null {
  return loadWebSources().find((source) => source.id === id) ?? null;
}

export function sourceHost(source: WebBookSource): string {
  try {
    return new URL(source.baseUrl).host;
  } catch {
    return source.baseUrl;
  }
}
