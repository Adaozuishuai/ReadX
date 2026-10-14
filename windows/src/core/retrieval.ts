// 页级向量检索（R-05 Metadata Index）——移植自 macOS RetrievalService.swift 的纯逻辑部分。
//
// 链路：页级分块 → /embeddings 嵌入（不可用时自动回退关键词检索）→ 本地向量索引。
// Chat 的跨论文扩展：当前论文仍由全文直供，这里只在其余论文中检索候选材料。
//
// 网络部分（/embeddings 请求）在 main/retrieval.ts；这里只做可测的纯计算：
// 余弦相似度、SHA256 指纹、分块、关键词打分、索引新鲜度校验、候选段落选取。
//
// 硬约束（继承自 macOS）：
// - Chat 路径**不得**发起嵌入请求（不能阻塞首响应）；只用本地关键词索引；
// - 嵌入失败要负缓存，避免端点不支持时每次打开论文都重复一轮注定失败的请求；
// - 响应里的 `index` 才标识输入；数组顺序不保证，必须据此重排并拒绝不完整/维度不一的向量。

import { createHash } from 'node:crypto';
import { pages } from './evidence';

export interface RetrievalChunk {
  paper: string;
  page: number;
  text: string;
  vector?: number[] | null;
}

export interface RetrievalIndex {
  key: string;
  pageCount: number;
  /** 嵌入模型名；null 表示关键词索引 */
  model: string | null;
  builtAt: string;
  chunks: RetrievalChunk[];
  sourceFingerprint: string | null;
  embeddingBase: string | null;
  /** 嵌入失败负缓存：键 = "base|model"，值 = 失败时间 */
  embedFailures: Record<string, string> | null;
}

/** 余弦相似度；零向量、维度不一致或非有限值返回 0。 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!(na > 0) || !(nb > 0)) return 0;
  const score = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(score) ? score : 0;
}

export function fingerprint(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

export function embeddingBase(base: string): string {
  let v = (base ?? '').trim();
  while (v.endsWith('/')) v = v.slice(0, -1);
  return v;
}

/**
 * 解析 /embeddings 响应里的向量。
 * 响应的 `index` 标识对应输入；数组顺序不保证。拒绝不完整、重复或不一致维度的向量。
 */
export function embeddingVectors(entries: Array<Record<string, unknown>>, inputCount: number): number[][] | null {
  if (!(inputCount > 0) || entries.length !== inputCount) return null;
  const ordered: Array<number[] | null> = new Array(inputCount).fill(null);
  let dimension: number | null = null;
  for (const entry of entries) {
    const position = entry.index;
    const values = entry.embedding;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position >= inputCount) return null;
    if (ordered[position] !== null) return null;
    if (!Array.isArray(values)) return null;
    const vector = values.map((v) => Number(v));
    if (!vector.length || !vector.every(Number.isFinite)) return null;
    if (dimension === null) dimension = vector.length;
    else if (dimension !== vector.length) return null;
    ordered[position] = vector;
  }
  return ordered.every((v) => v !== null) ? (ordered as number[][]) : null;
}

/** 从 `=== Page N ===` 文本切页级分块；超长页按 ~1200 字符二次切块。 */
export function chunks(paper: string, source: string): RetrievalChunk[] {
  const out: RetrievalChunk[] = [];
  for (const page of pages(source)) {
    const t = page.text.replace(/^\s+|\s+$/g, '');
    if (!t) continue;
    if (t.length <= 1600) { out.push({ paper, page: page.number, text: t }); continue; }
    let index = 0;
    while (index < t.length) {
      const end = Math.min(index + 1200, t.length);
      out.push({ paper, page: page.number, text: t.slice(index, end) });
      index = end;
    }
  }
  return out;
}

/** 查询分词：小写、按非字母数字切分、长度 > 2。 */
export function terms(query: string): string[] {
  return (query ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
}

/** 关键词回退打分：查询词命中次数。 */
export function keywordScore(text: string, ts: string[]): number {
  const lower = (text ?? '').toLowerCase();
  return ts.reduce((sum, term) => sum + Math.max(0, lower.split(term).length - 1), 0);
}

/** 索引是否仍对应当前源文本（按指纹；旧索引无指纹时比对完整分块）。 */
export function matchesSource(index: RetrievalIndex, paper: string, source: string): boolean {
  if (index.key !== paper || index.pageCount !== pages(source).length || !index.chunks.length) return false;
  if (index.sourceFingerprint) return index.sourceFingerprint === fingerprint(source);
  const expected = chunks(paper, source);
  return index.chunks.length === expected.length
    && index.chunks.every((c, i) => c.paper === expected[i].paper && c.page === expected[i].page && c.text === expected[i].text);
}

/** 索引的嵌入模型/端点是否与当前配置一致。 */
export function matchesEmbedding(index: RetrievalIndex, model: string, base: string): boolean {
  return index.model === model && index.embeddingBase === embeddingBase(base);
}

export interface RetrievedPassage {
  paper: string;
  title: string;
  page: number;
  text: string;
  viaEmbedding: boolean;
}

/**
 * 在给定索引集合上选 topK 候选段落（跨论文）。
 *
 * 纯计算：网络（查询向量）由调用方提供。嵌入可用时用余弦，否则回退关键词密度。
 * 每篇论文只取其最佳分块；然后跨论文取分最高的 topK。
 */
export function selectTopPassages(
  indices: Record<string, RetrievalIndex>,
  titles: Record<string, string>,
  queryVector: number[] | null,
  query: string,
  model: string,
  base: string,
  topK = 3,
): RetrievedPassage[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const semantic: Array<{ passage: RetrievedPassage; score: number }> = [];
  const lexical: Array<{ passage: RetrievedPassage; score: number }> = [];
  for (const [key, index] of Object.entries(indices)) {
    // 每篇论文只用**一种**打分尺度：嵌入可用时按余弦排（只比有向量的块），
    // 否则全部按关键词密度排。绝不能在同一循环里混比两种尺度——
    // 余弦值域 0–1、关键词密度可到 10²–10³，混比会让语义命中被无向量的尾部块压掉。
    const embeddable = matchesEmbedding(index, model, base) && !!queryVector
      && index.chunks.some((c) => c.vector && c.vector.length === queryVector!.length);
    let top: { chunk: RetrievalChunk; score: number } | null = null;
    for (const chunk of index.chunks) {
      let score: number;
      if (embeddable) {
        if (!chunk.vector || chunk.vector.length !== queryVector!.length) continue;
        score = cosine(queryVector!, chunk.vector);
      } else {
        score = keywordScore(chunk.text, ts) / Math.max(chunk.text.length, 1) * 1000;
      }
      if (score > 0 && (!top || score > top.score)) top = { chunk, score };
    }
    if (!top) continue;
    const passage: RetrievedPassage = {
      paper: key, title: titles[key] ?? key, page: top.chunk.page, text: top.chunk.text,
      viaEmbedding: embeddable,
    };
    // 跨论文比较同样不混尺度：嵌入命中单独归入 semantic 桶，关键词命中归入 lexical 桶。
    // 最终优先返回语义命中，不足 topK 时再用关键词命中补齐。
    if (embeddable) semantic.push({ passage, score: top.score });
    else lexical.push({ passage, score: top.score });
  }
  const byScore = (a: { score: number }, b: { score: number }): number => b.score - a.score;
  return [...semantic.sort(byScore), ...lexical.sort(byScore)].slice(0, topK).map((x) => x.passage);
}

/** Chat 请求附带的跨论文候选材料块（含来源标注与「必须写出论文名与页码」的硬约束）。 */
export function libraryContextBlock(passages: RetrievedPassage[]): string {
  if (!passages.length) return '';
  let out = '\n\n【来自论文库其他论文的候选材料（检索得到，仅供关联参考；引用它们时必须同时写出论文名与 Page N，否则视为无证据）】\n';
  for (const p of passages) out += `\n--- ${p.title} · Page ${p.page} ---\n` + p.text.slice(0, 1200) + '\n';
  return out;
}

/** 嵌入可用性的缓存键。 */
export function embedCacheKey(base: string, model: string): string {
  return embeddingBase(base) + '|' + model;
}
