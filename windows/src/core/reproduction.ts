// 复现分析（Reproduction）：把论文结论拆成「资源/环境/成本/缺失/风险」五组核对项。
//
// 逐条对应 native/Sources/CBCTReading/ReproductionModels.swift。核心纪律：
// 未知不是空白，未知也必须给出「下一步核对行动」；清单只做提示，不做穷举。

import { createHash } from 'node:crypto';

import { ExperimentField } from './types';
import { citations, pages, validateExtraction } from './evidence';

export interface ReproductionItem {
  finding: ExperimentField;
  assessment: string;
  action: string;
}

/** Swift 的计算属性，移植为函数以免序列化时混入派生字段。 */
export function reproductionItemTitle(item: ReproductionItem): string {
  return item.finding.k;
}

export function reproductionItemIsUnknown(item: ReproductionItem): boolean {
  return item.finding.page == null;
}

export interface ReproductionAnalysis {
  resources: ReproductionItem[];
  environment: ReproductionItem[];
  cost: ReproductionItem[];
  missing: ReproductionItem[];
  risks: ReproductionItem[];
}

/** 对应 Swift `ReproductionAnalysis.groups`：五组的稳定顺序与中文标题。 */
export function reproductionGroups(
  x: ReproductionAnalysis,
): Array<[string, string, ReproductionItem[]]> {
  return [
    ['resources', '资源 · 数据 / 代码 / 权重', x.resources],
    ['environment', '环境 · 依赖 / 特殊算子', x.environment],
    ['cost', '训练成本 · 时间 / 显存', x.cost],
    ['missing', '关键缺失 · 几何 / 预处理 / 参数', x.missing],
    ['risks', '风险 · 实现 / 评测协议', x.risks],
  ];
}

export function reproductionItemCount(x: ReproductionAnalysis): number {
  return reproductionGroups(x).reduce((sum, [, , items]) => sum + items.length, 0);
}

/** 未知项仍计入总数：未知是「待核对」，不是「已确认」。 */
export function reproductionUnknownCount(x: ReproductionAnalysis): number {
  return reproductionGroups(x).flatMap(([, , items]) => items).filter(reproductionItemIsUnknown).length;
}

const REPRODUCTION_GROUP_KEYS = ['resources', 'environment', 'cost', 'missing', 'risks'] as const;

/**
 * 对应 Swift `ReproductionAnalysis.decode(_:)`：剥掉模型常见的 ``` 围栏。
 *
 * 与 Swift 的**关键差异**在于结构校验的时机：Swift 用 JSONDecoder 解码到非可选数组字段，
 * 缺字段会直接以 keyNotFound 失败；而 JSON.parse 只会把缺字段变成 undefined，
 * 让后续 validate 崩在 `undefined.length` 上，把「模型少给了一组」这条本可读的
 * 错误变成一个 TypeError。这里补回解码期的结构检查，使两边行为对齐。
 */
export function decodeReproductionAnalysis(text: string): ReproductionAnalysis {
  let raw = text.trim();
  if (raw.startsWith('```')) raw = raw.split('\n').slice(1, -1).join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('复现分析不是合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('复现分析必须是一个 JSON 对象。');
  }
  const obj = parsed as Record<string, unknown>;
  const missing = REPRODUCTION_GROUP_KEYS.filter((k) => !Array.isArray(obj[k]));
  if (missing.length) {
    throw new Error('复现分析缺少必需的组（或该组不是数组）：' + missing.join('、') + '。五组都必须给出。');
  }
  return parsed as ReproductionAnalysis;
}

/** 递归按键名排序，等价于 Swift JSONEncoder 的 .sortedKeys。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function stableJSON(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * 对应 Swift `ReproductionAnalysis.fingerprint`。
 *
 * 必须先按键名排序再哈希：SIFT 的规范就是「同一内容、不同字段顺序 → 同一指纹」，
 * 否则模型换个字段顺序输出就会让意义完全相同的分析被判成「新版分析」，
 * 已核对进度会被整批清空。
 */
export function fingerprint(x: ReproductionAnalysis): string {
  return createHash('sha256').update(stableJSON(x), 'utf8').digest('hex');
}

/**
 * 对应 Swift `ReproductionAnalysis.validate(source:)`。
 *
 * 未知也须给出核对行动：page == null 是允许的，但 assessment/action 不能空白，
 * 否则「不知道」会被当成结论存下来。
 */
export function validateReproductionAnalysis(analysis: ReproductionAnalysis, source: string): void {
  const problems: string[] = [];
  const available = new Set(pages(source).map((p) => p.number));
  for (const [, label, items] of reproductionGroups(analysis)) {
    // 清单只做「核对提示」，不做穷举：每组 1–4 项。
    if (items.length === 0 || items.length > 4) {
      problems.push(`${label}：须有 1–4 项，未知也须给出核对行动`);
    }
    if (new Set(items.map(reproductionItemTitle)).size !== items.length) {
      problems.push(`${label}：字段标题重复`);
    }
    for (const item of items) {
      const title = reproductionItemTitle(item);
      if ([title, item.assessment, item.action].some((s) => (s ?? '').trim() === '')) {
        problems.push(`${title}：缺少字段、分析或核对行动`);
      }
      try {
        validateExtraction(
          { dataset: [item.finding], acquisition: [], training: [], loss: [], metrics: [], results: [] },
          source,
        );
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
      // 分析/行动里出现的每个 Page N 都必须真实存在；引用不存在的页码比不引用更危险。
      const referenced = new Set(citations(item.assessment + '\n' + item.action));
      if ([...referenced].some((r) => !available.has(r))) {
        problems.push(`${title}：分析或行动引用了不存在的页码`);
      }
    }
  }
  if (problems.length) throw new Error(problems.join('；'));
}

/** 对应 Swift `ReproductionTaskStatus`。 */
export type ReproductionTaskStatus = 'todo' | 'verified' | 'blocked';

export const REPRODUCTION_TASK_STATUS_LABEL: Record<ReproductionTaskStatus, string> = {
  todo: '待核对',
  verified: '已核对',
  blocked: '受阻',
};

export const REPRODUCTION_TASK_STATUSES: readonly ReproductionTaskStatus[] = ['todo', 'verified', 'blocked'];

export interface ReproductionTask {
  status: ReproductionTaskStatus;
  note: string;
  updatedAt?: string | null;
}

export function defaultReproductionTask(): ReproductionTask {
  return { status: 'todo', note: '', updatedAt: null };
}

export interface ReproductionChecklist {
  key: string;
  /** 每个分析版本（fingerprint）单独存放；新版分析不继承旧核对结果。 */
  revisions: Record<string, Record<string, ReproductionTask>>;
  analyses?: Record<string, ReproductionAnalysis> | null;
  /** R-11：来自代码快照的仓库依赖/数据/权重核对项，键为 RepoDependencyCheck.id（随快照稳定）。 */
  repoChecks: Record<string, ReproductionTask>;
}

export function defaultReproductionChecklist(key: string): ReproductionChecklist {
  return { key, revisions: {}, analyses: null, repoChecks: {} };
}

/** 对应 Swift `ReproductionChecklist.task(_:itemID:)`：缺失时返回默认任务（待核对）。 */
export function checklistTask(checklist: ReproductionChecklist, revision: string, itemID: string): ReproductionTask {
  return checklist.revisions[revision]?.[itemID] ?? defaultReproductionTask();
}

// MARK: - R-11 仓库依赖核对（规则版，不执行仓库代码、不发请求）

/** 移植所需的代码快照子集：只需要文件路径与逐行文本。 */
export interface CodeSnapshot {
  files: Array<{ path: string; lines: string[] }>;
}

export interface RepoDependencyCheck {
  path: string;
  kind: '依赖' | '数据' | '权重';
  detail: string;
  line?: number | null;
  id: string;
}

/** 对应 Swift `RepoDependencyCheck.id`：kind|path[:line]。 */
export function repoCheckID(check: Pick<RepoDependencyCheck, 'kind' | 'path' | 'line'>): string {
  return check.kind + '|' + check.path + (check.line != null ? `:${check.line}` : '');
}

export const DEPENDENCY_FILE_NAMES: ReadonlySet<string> = new Set([
  'requirements.txt', 'environment.yml', 'environment.yaml', 'conda.yml', 'conda.yaml',
  'setup.py', 'pyproject.toml', 'pipfile', 'pipfile.lock', 'package.json',
]);

export const DATA_URL_HINTS: readonly string[] = [
  'drive.google.com', 'zenodo', 'huggingface.co', 'figshare', 'dropbox.com', 'gdown',
];

export const WEIGHT_HINTS: readonly string[] = ['checkpoint', 'weights', 'pretrained', '.pth', '.ckpt'];

/**
 * 对应 Swift `RepoAudit.checks(from:)`。
 *
 * 从代码快照提取依赖声明文件与数据/权重下载指引。纯函数，供回归测试与 UI 复用：
 * 不执行任何仓库代码、不发任何网络请求。
 */
export function repoAuditChecks(snapshot: CodeSnapshot): RepoDependencyCheck[] {
  const out: RepoDependencyCheck[] = [];
  for (const file of snapshot.files) {
    const segments = file.path.split('/');
    const name = (segments[segments.length - 1] ?? '').toLowerCase();
    if (DEPENDENCY_FILE_NAMES.has(name)) {
      out.push({
        path: file.path,
        kind: '依赖',
        detail: '发现依赖声明文件，需与论文环境声明核对并实际安装验证。',
        line: null,
        id: repoCheckID({ kind: '依赖', path: file.path, line: null }),
      });
    }
    for (let offset = 0; offset < file.lines.length; offset++) {
      const rawLine = file.lines[offset];
      // 超长行（压缩过的 js、base64）不参与扫描，避免把整包内容当依赖。
      if (rawLine.length >= 500) continue;
      const line = rawLine.replace(/^\s+|\s+$/g, '');
      const lower = line.toLowerCase();
      if (!lower.includes('http')) continue;
      const isWeight = WEIGHT_HINTS.some((hint) => lower.includes(hint));
      const isData = DATA_URL_HINTS.some((hint) => lower.includes(hint)) ||
        (lower.includes('download') && (lower.includes('data') || lower.includes('dataset')));
      if (isWeight) {
        out.push(mkCheck(file.path, '权重', '疑似权重/检查点下载指引：' + line.slice(0, 160), offset + 1));
      } else if (isData) {
        out.push(mkCheck(file.path, '数据', '疑似数据集下载指引：' + line.slice(0, 160), offset + 1));
      }
    }
  }
  const seen = new Set<string>();
  const deduped: RepoDependencyCheck[] = [];
  for (const c of out) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deduped.push(c);
    if (deduped.length >= 12) break; // 清单只做「核对提示」，不做穷举
  }
  return deduped;
}

function mkCheck(path: string, kind: '数据' | '权重', detail: string, line: number): RepoDependencyCheck {
  return { path, kind, detail, line, id: repoCheckID({ kind, path, line }) };
}

/** 对应 Swift `RepoAudit.checks(from:)`（方法名别名）。 */
export const RepoAudit = {
  dependencyFileNames: DEPENDENCY_FILE_NAMES,
  dataURLHints: DATA_URL_HINTS,
  weightHints: WEIGHT_HINTS,
  checks: repoAuditChecks,
};
