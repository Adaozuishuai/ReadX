// 页级向量检索的网络与索引编排（移植自 macOS RetrievalService 的 Store 部分）。
//
// 只在主进程跑：读 library/text 缓存、调 /embeddings（失败回退关键词）、落盘索引。
// 嵌入请求绝不阻塞 Chat 首响应：Chat 路径用 allowEmbedding=false，只读本地索引。

import * as fs from 'fs';
import * as path from 'path';

import { Paths, readCachedPDFText, saveJSON, readJSONStrict } from '../core/store';
import { pages } from '../core/evidence';
import { Config } from '../core/types';
import {
  RetrievalIndex, RetrievalChunk, RetrievedPassage,
  chunks, fingerprint, embeddingBase, embeddingVectors, matchesSource, matchesEmbedding, embedCacheKey,
  selectTopPassages,
} from '../core/retrieval';

/** OpenAI 兼容 /embeddings；任何失败返回 null（调用方回退关键词）。 */
export async function embed(texts: string[], base: string, apiKey: string, model: string, timeoutMs = 30_000): Promise<number[][] | null> {
  const urlStr = embeddingBase(base) + '/embeddings';
  let endpoint: URL;
  try { endpoint = new URL(urlStr); } catch { return null; }
  if (!/^https?:$/.test(endpoint.protocol) || !endpoint.hostname) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts }),
      signal: ac.signal,
    });
    if (resp.status !== 200) return null;
    const obj = await resp.json() as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(obj.data)) return null;
    return embeddingVectors(obj.data, texts.length);
  } catch { return null; } finally { clearTimeout(timer); }
}

function indexPath(paths: Paths, key: string): string {
  return path.join(paths.dataDir, 'embeddings', `${key}.json`);
}

/** 已有页文本缓存的论文 key（library/text/*-v3.txt）。 */
export function cachedKeys(paths: Paths): string[] {
  try {
    return fs.readdirSync(paths.textDir).filter((n) => n.endsWith('-v3.txt')).map((n) => n.slice(0, -'-v3.txt'.length));
  } catch { return []; }
}

/** 按 key 找论文标题（用于候选材料的来源标注）。 */
export type TitleLookup = (key: string) => string | null;

/**
 * 载入或构建单篇论文的检索索引。
 * @param allowEmbedding false 时只用本地关键词索引，**绝不发起 /embeddings 请求**（Chat 路径必须传 false）。
 */
export async function retrievalIndex(
  paths: Paths, cfg: Config, key: string, allowEmbedding = true,
): Promise<RetrievalIndex | null> {
  const source = readCachedPDFText(paths, key) ?? '';
  const pageCount = pages(source).length; // 与 matchesSource 同口径（Requires === Page <digits> ===），否则索引会被误判过期
  const embedModel = cfg.embeddingModel || cfg.model || 'text-embedding-3-small';
  const base = cfg.baseURL ?? '';
  const cacheKey = embedCacheKey(base, embedModel);

  const prior = readJSONStrict<RetrievalIndex>(indexPath(paths, key));
  const embedFailures: Record<string, string> = (prior.ok && prior.value.embedFailures) ? { ...prior.value.embedFailures } : {};
  const hasKey = !!(cfg.apiKey && cfg.apiKey.length && !cfg.apiKey.includes('在这里填入'));
  const embedFailedBefore = !!source && embedFailures[cacheKey] !== undefined;
  const wantEmbedding = hasKey && allowEmbedding && !embedFailedBefore;

  // 命中新鲜缓存且嵌入要求一致 -> 直接返回
  if (prior.ok && matchesSource(prior.value, key, source) && (!wantEmbedding || matchesEmbedding(prior.value, embedModel, base))) {
    return prior.value;
  }

  const list: RetrievalChunk[] = chunks(key, source);
  let usedModel: string | null = null;
  if (wantEmbedding && list.length && cfg.apiKey) {
    const limited = list.slice(0, 80);
    const vectors = await embed(limited.map((c) => c.text), base, cfg.apiKey, embedModel);
    if (vectors && vectors.length === limited.length) {
      for (let i = 0; i < limited.length; i++) list[i].vector = vectors[i];
      usedModel = embedModel;
    } else {
      embedFailures[cacheKey] = new Date().toISOString();
    }
  }
  if (!list.length) return null;
  // PDF 可能在嵌入请求在途时被替换；绝不让旧响应覆盖新索引
  if ((readCachedPDFText(paths, key) ?? '') !== source) return null;
  if (usedModel) delete embedFailures[cacheKey]; // 成功后清除负缓存

  const index: RetrievalIndex = {
    key, pageCount, model: usedModel, builtAt: new Date().toISOString(), chunks: list,
    sourceFingerprint: fingerprint(source),
    embeddingBase: usedModel === null ? null : embeddingBase(base),
    embedFailures,
  };
  fs.mkdirSync(path.dirname(indexPath(paths, key)), { recursive: true });
  saveJSON(indexPath(paths, key), index);
  return index;
}

/** 后台预热嵌入索引（不阻塞任何用户操作）。 */
export function prewarmRetrievalIndex(paths: Paths, cfg: Config, key: string): void {
  void retrievalIndex(paths, cfg, key, true).catch(() => { /* 预热失败不影响主流程 */ });
}

/** 只读磁盘上已有的索引（后台预热会补齐缺失的）。 */
export function loadIndices(paths: Paths, keys: string[]): Record<string, RetrievalIndex> {
  const out: Record<string, RetrievalIndex> = {};
  for (const key of keys) {
    const r = readJSONStrict<RetrievalIndex>(indexPath(paths, key));
    if (!r.ok) continue;
    const source = readCachedPDFText(paths, key);
    if (!source) continue;
    if (!matchesSource(r.value, key, source)) continue;
    out[key] = r.value;
  }
  return out;
}

/**
 * Chat 跨论文扩展检索：在除当前论文外的其余缓存论文中取 topK 候选段落。
 * 只读本地索引；查询向量仅在模型与端点一致时才请求（最多 3 秒），失败立即回退关键词。
 */
export async function retrieveAcrossLibrary(
  paths: Paths, cfg: Config, query: string, excluding: string, titleOf: TitleLookup, topK = 3,
): Promise<RetrievedPassage[]> {
  const others = [...new Set(cachedKeys(paths))].filter((k) => k !== excluding).sort();
  if (!others.length) return [];
  const indices = loadIndices(paths, others);
  if (!Object.keys(indices).length) return [];

  const embedModel = cfg.embeddingModel || cfg.model || 'text-embedding-3-small';
  const base = cfg.baseURL ?? '';
  const hasKey = !!(cfg.apiKey && cfg.apiKey.length && !cfg.apiKey.includes('在这里填入'));
  // 只有当已有嵌入索引时才发这一次小请求；失败即回退关键词
  let queryVector: number[] | null = null;
  if (hasKey && cfg.apiKey && Object.values(indices).some((i) => matchesEmbedding(i, embedModel, base) && i.chunks.some((c) => c.vector))) {
    const v = await embed([query], base, cfg.apiKey, embedModel, 3000);
    queryVector = v && v[0] ? v[0] : null;
  }
  const titles: Record<string, string> = {};
  for (const key of Object.keys(indices)) titles[key] = titleOf(key) ?? key;
  return selectTopPassages(indices, titles, queryVector, query, embedModel, base, topK);
}
