import { api } from '../../../api/client';
import type { WebBookDetail, WebBookSource, WebSearchResult } from './web-types';
import {
  contentToText,
  decodePage,
  expandTemplate,
  extractElement,
  extractValue,
  resolvePageURL,
  selectNodes,
  type SourcePage,
} from './web-rules';

async function fetchPage(
  source: WebBookSource,
  url: string,
  signal?: AbortSignal,
): Promise<SourcePage> {
  const { bytes, contentType } = await api.fetchWebSourcePage(url, signal);
  return decodePage(url, bytes, contentType, source.charset);
}

function searchURLFor(source: WebBookSource, query: string): string {
  const key = encodeURIComponent(query);
  const expanded = expandTemplate(source.searchUrl, {
    key,
    query: key,
    page: '1',
    baseUrl: source.baseUrl,
  });
  return resolvePageURL(expanded, source.baseUrl);
}

export async function searchWebSource(
  source: WebBookSource,
  query: string,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  if (source.unsupported) throw new Error(`${source.name}：${source.unsupported}`);
  const url = searchURLFor(source, query);
  const page = await fetchPage(source, url, signal);
  const root = page.document ?? page.json;
  const items = selectNodes(page, root, source.rules.search.list);
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const item of items.slice(0, 100)) {
    const title = extractValue(page, item, source.rules.search.name);
    const bookUrlRaw = extractValue(page, item, source.rules.search.bookUrl);
    if (!title || !bookUrlRaw) continue;
    const bookUrl = resolvePageURL(bookUrlRaw, page.url);
    if (!bookUrl || seen.has(bookUrl)) continue;
    seen.add(bookUrl);
    results.push({
      sourceId: source.id,
      sourceName: source.name,
      title,
      author: extractValue(page, item, source.rules.search.author),
      bookUrl,
      cover: (() => {
        const cover = extractValue(page, item, source.rules.search.cover);
        return cover ? resolvePageURL(cover, page.url) : '';
      })(),
      intro: extractValue(page, item, source.rules.search.intro),
      lastChapter: extractValue(page, item, source.rules.search.lastChapter),
    });
  }
  return results;
}

export async function loadWebBook(
  source: WebBookSource,
  bookUrl: string,
  fallback: { title: string; author?: string; intro?: string; cover?: string },
  signal?: AbortSignal,
): Promise<WebBookDetail> {
  if (source.unsupported) throw new Error(`${source.name}：${source.unsupported}`);
  const page = await fetchPage(source, bookUrl, signal);
  const root = page.document ?? page.json;
  const title = extractValue(page, root, source.rules.book.name) || fallback.title;
  const author = extractValue(page, root, source.rules.book.author) || fallback.author || '';
  const intro = extractValue(page, root, source.rules.book.intro) || fallback.intro || '';
  const coverValue = extractValue(page, root, source.rules.book.cover) || fallback.cover || '';

  const tocRuleValue = source.rules.book.tocUrl
    ? extractValue(page, root, source.rules.book.tocUrl)
    : '';
  const tocURL = tocRuleValue ? resolvePageURL(tocRuleValue, page.url) : page.url;
  const tocPage = tocURL === page.url ? page : await fetchPage(source, tocURL, signal);
  const tocItems = selectNodes(
    tocPage,
    tocPage.document ?? tocPage.json,
    source.rules.toc.list,
  );

  const chapters: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < tocItems.length && chapters.length < 5000; index += 1) {
    const item = tocItems[index];
    if (item === undefined || item === null) continue;
    const urlRaw = extractValue(tocPage, item, source.rules.toc.url);
    if (!urlRaw) continue;
    const url = resolvePageURL(urlRaw, tocPage.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const chapterTitle =
      extractValue(tocPage, item, source.rules.toc.name) || `第 ${chapters.length + 1} 章`;
    chapters.push({ title: chapterTitle, url });
  }

  if (!chapters.length) {
    throw new Error(`《${title}》没有解析到章节目录，可能是书源规则不匹配或页面需要登录。`);
  }
  return {
    title,
    author,
    intro,
    cover: coverValue ? resolvePageURL(coverValue, page.url) : '',
    chapters,
  };
}

export async function loadWebChapterText(
  source: WebBookSource,
  chapterUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  if (source.unsupported) throw new Error(`${source.name}：${source.unsupported}`);
  const texts: string[] = [];
  const visited = new Set<string>();
  let url = chapterUrl;

  for (let pageIndex = 0; pageIndex < 5 && url && !visited.has(url); pageIndex += 1) {
    visited.add(url);
    const page = await fetchPage(source, url, signal);
    const root = page.document ?? page.json;
    const element = extractElement(page, root, source.rules.content.content);
    const text = element
      ? contentToText(element, source.rules.content.remove)
      : extractValue(page, root, source.rules.content.content);
    if (text.trim()) texts.push(text.trim());

    const next = source.rules.content.next
      ? extractValue(page, root, source.rules.content.next)
      : '';
    url = next ? resolvePageURL(next, page.url) : '';
  }

  if (!texts.length) {
    throw new Error('这一章没有解析到正文，可能是书源规则不匹配、页面需要登录或站点返回了验证页。');
  }
  return texts.join('\n\n');
}
