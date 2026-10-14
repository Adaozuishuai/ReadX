// 新模块（想法 / 复现核对 / 系统标签索引 / 对比会话）的本地存储。
//
// 存储位置与 macOS 版一致，保证两边读写同一份文件：
//   app/data/ideas.json
//   app/data/reproduction/<key>.json
//   app/data/compare.json
//
// 设计约束（从 macOS 版继承）：
// - 损坏的 JSON 必须显式报错，不得静默回退默认值（否则下次保存会覆盖用户数据）；
// - 写入走原子替换，避免进程中断留下半截文件。

import * as fs from 'fs';
import * as path from 'path';
import { Paths, readJSONStrict, saveJSON, atomicWrite, assertSafePathKey } from './store';

export interface StoredIdea {
  id: string;
  question: string;
  observation: string;
  hypothesis: string;
  method: string;
  experiment: string;
  status: string;
  evidence: Array<{
    id: string;
    paperKey: string;
    paperTitle: string;
    origin: string;
    page?: number | null;
    excerpt: string;
    verifiedAt?: string | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaFile { ideas: StoredIdea[] }

export function loadIdeas(paths: Paths): { ok: true; value: IdeaFile } | { ok: false; missing: boolean; error: string } {
  const file = paths.ideasPath;
  const r = readJSONStrict<IdeaFile | StoredIdea[]>(file);
  if (!r.ok) {
    if (r.missing) return { ok: true, value: { ideas: [] } }; // 首次使用不算错误
    return r;
  }
  // 兼容数组与 {ideas:[...]} 两种历史格式
  const ideas = Array.isArray(r.value) ? r.value : (r.value.ideas ?? []);
  return { ok: true, value: { ideas } };
}

export function saveIdeas(paths: Paths, file: IdeaFile): void {
  saveJSON(paths.ideasPath, file);
}

/** 复现核对记录：按「分析指纹」分版本，新分析不继承旧核对结果。 */
export interface ReproductionChecklistDoc {
  key: string;
  revisions: Record<string, Record<string, { status: string; note: string; updatedAt?: string | null }>>;
  analyses?: Record<string, unknown> | null;
  repoChecks?: Record<string, { status: string; note: string; updatedAt?: string | null }>;
}

export function reproductionPath(paths: Paths, key: string): string {
  return path.join(paths.dataDir, 'reproduction', `${assertSafePathKey(key)}.json`);
}

export function loadReproduction(paths: Paths, key: string): { ok: boolean; missing?: boolean; error?: string; value: ReproductionChecklistDoc } {
  const r = readJSONStrict<ReproductionChecklistDoc>(reproductionPath(paths, key));
  // 显式字段放在展开之后：文件里的 key 与文件名不一致时，以调用方请求的 key 为准，
  // 否则会把这份核对记录挂到错误的论文上。
  if (r.ok) return { ok: true, value: { ...r.value, key, revisions: r.value.revisions ?? {} } };
  if (r.missing) return { ok: true, value: { key, revisions: {} } };
  return { ok: false, missing: false, error: r.error, value: { key, revisions: {} } };
}

export function saveReproduction(paths: Paths, key: string, doc: ReproductionChecklistDoc): void {
  saveJSON(reproductionPath(paths, key), doc);
}

/** 对比会话：选中集合 + 固定列。 */
export interface CompareSessionDoc { selected: string[]; pinned?: string | null }

export function loadCompare(paths: Paths): CompareSessionDoc {
  const r = readJSONStrict<CompareSessionDoc>(paths.comparePath);
  if (r.ok) return { selected: r.value.selected ?? [], pinned: r.value.pinned ?? null };
  // 旧格式只有 selected；损坏时按空处理但不清除文件
  return { selected: [], pinned: null };
}

export function saveCompare(paths: Paths, doc: CompareSessionDoc): void {
  saveJSON(paths.comparePath, doc);
}

/** 导出产物写出（BibTeX / RIS / Markdown / JSON）。 */
export function writeExport(target: string, content: string): void {
  atomicWrite(target, content);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
