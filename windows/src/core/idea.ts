// 研究想法（Idea）与迁移分析（Reproduction 的「应用到我的研究」一侧）。
//
// 逐条对应早期 macOS（Swift）版 IdeaModels.swift。移植纪律：
// 这里每个「刻意不做 X」的注释都继承自 Swift 版，改动前先读
// 对应早期 macOS（Swift）版 ResearchTests.swift 的回归用例。

import { randomUUID } from 'node:crypto';

import { ExperimentField } from './types';
import { normalized, pages, validateExtraction } from './evidence';

/** 对应 Swift `IdeaStatus`：五个状态与中文 label。 */
export type IdeaStatus = 'Idea' | 'Planned' | 'Running' | 'Rejected' | 'Adopted';

export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  Idea: '想法',
  Planned: '待实验',
  Running: '实验中',
  Rejected: '已否定',
  Adopted: '已采纳',
};

export const IDEA_STATUSES: readonly IdeaStatus[] = ['Idea', 'Planned', 'Running', 'Rejected', 'Adopted'];

/**
 * 对应 Swift `EvidenceOrigin`。
 * 只有「论文原文」是必须可回到页码 + 逐字摘录的硬证据；其余三种是模型/人的推断，
 * 允许没有页码（但也因此不得冒充原文事实）。
 */
export type EvidenceOrigin = '论文原文' | 'AI 解释' | '研究建议' | '个人笔记';

export const EVIDENCE_ORIGINS: readonly EvidenceOrigin[] = ['论文原文', 'AI 解释', '研究建议', '个人笔记'];

export interface IdeaEvidence {
  id: string;
  paperKey: string;
  paperTitle: string;
  origin: EvidenceOrigin;
  page?: number | null;
  excerpt: string;
  verifiedAt?: string | null;
}

/** Swift: `IdeaEvidence(paperKey:paperTitle:origin:page:excerpt:)`，id/verifiedAt 取默认值。 */
export function createIdeaEvidence(
  fields: Omit<IdeaEvidence, 'id' | 'verifiedAt'> & Partial<Pick<IdeaEvidence, 'id' | 'verifiedAt'>>,
): IdeaEvidence {
  return {
    id: fields.id ?? randomUUID(),
    paperKey: fields.paperKey,
    paperTitle: fields.paperTitle,
    origin: fields.origin,
    page: fields.page ?? null,
    excerpt: fields.excerpt,
    verifiedAt: fields.verifiedAt ?? null,
  };
}

/**
 * 对应 Swift `IdeaEvidence.validate(source:)`。
 *
 * 关键取舍（继承自 Swift）：**只有 origin === '论文原文' 才校验**。
 * AI 解释 / 研究建议 / 个人笔记本来就不是原文，强制它们提供逐字摘录只会
 * 逼模型编造页码；它们的可信度由 origin 标签本身披露。因此其余 origin 直接通过。
 */
export function validateIdeaEvidence(evidence: IdeaEvidence, source: string): void {
  if (evidence.origin !== '论文原文') return;

  const page = evidence.page ?? null;
  const pageText = page != null ? pages(source).find((p) => p.number === page)?.text : undefined;
  const quote = evidence.excerpt ?? '';
  const ok = page != null && pageText !== undefined &&
    normalized(quote).length >= 8 &&
    normalized(pageText).includes(normalized(quote));
  if (!ok) {
    throw new Error('原文证据须包含有效页码和该页至少 8 个非空白字符的逐字摘录。');
  }
}

export interface ResearchIdea {
  id: string;
  question: string;
  observation: string;
  hypothesis: string;
  method: string;
  experiment: string;
  status: IdeaStatus;
  evidence: IdeaEvidence[];
  createdAt: string;
  updatedAt: string;
}

/** ISO8601DateFormatter().string(from:) 不带毫秒；保持一致以免同一秒出现两种写法。 */
function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 对应 Swift `ResearchIdea()` 的默认值。 */
export function defaultResearchIdea(): ResearchIdea {
  const now = nowISO();
  return {
    id: randomUUID(),
    question: '',
    observation: '',
    hypothesis: '',
    method: '',
    experiment: '',
    status: 'Idea',
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };
}

export interface ApplicationAdvice {
  title: string;
  suggestion: string;
  constraint: string;
  verification: string;
  evidence: ExperimentField[];
}

export interface ResearchApplication {
  reusable: ApplicationAdvice[];
  adaptation: ApplicationAdvice[];
  conflicts: ApplicationAdvice[];
  validation: ApplicationAdvice[];
}

/** 对应 Swift `ResearchApplication.groups`：四类的稳定顺序与中文标题。 */
export function researchApplicationGroups(
  x: ResearchApplication,
): Array<[string, string, ApplicationAdvice[]]> {
  return [
    ['reusable', '可直接复用 · 仍需确认前提', x.reusable],
    ['adaptation', '需要适配', x.adaptation],
    ['conflicts', '存在冲突 / 潜在冲突', x.conflicts],
    ['validation', '需要验证', x.validation],
  ];
}

const APPLICATION_GROUP_KEYS = ['reusable', 'adaptation', 'conflicts', 'validation'] as const;

/**
 * 对应 Swift `ResearchApplication.decode(_:)`：剥掉模型常见的 ``` 围栏。
 *
 * 同 reproduction.ts：Swift 的 JSONDecoder 会在缺字段时 keyNotFound 失败，
 * JSON.parse 不会，于是 validate 会崩在 `undefined.title` 上。这里补回结构检查。
 */
export function decodeResearchApplication(text: string): ResearchApplication {
  const raw = stripFence(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('迁移建议不是合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('迁移建议必须是一个 JSON 对象。');
  }
  const obj = parsed as Record<string, unknown>;
  const missing = APPLICATION_GROUP_KEYS.filter((k) => !Array.isArray(obj[k]));
  if (missing.length) {
    throw new Error('迁移建议缺少必需的组（或该组不是数组）：' + missing.join('、') + '。四组都必须给出。');
  }
  return parsed as ResearchApplication;
}

function stripFence(text: string): string {
  let raw = text.trim();
  if (raw.startsWith('```')) raw = raw.split('\n').slice(1, -1).join('\n');
  return raw;
}

/**
 * 对应 Swift `ResearchApplication.validate(source:)`。
 *
 * 每条建议必须同时给出：研究约束（constraint）、验证实验（verification）
 * 和可回到原文的 evidence。只有「未知字段」（page 全为 null）不被接受——
 * 迁移建议必须有原文依据，否则无法区分「论文真的说了」与模型编的。
 */
export function validateResearchApplication(application: ResearchApplication, source: string): void {
  const items = researchApplicationGroups(application).flatMap(([, , list]) => list);
  if (items.length === 0) throw new Error('迁移分析没有返回建议。');

  const problems: string[] = [];
  for (const item of items) {
    if (!item.title || !item.suggestion || !item.constraint || !item.verification || !item.evidence?.length) {
      problems.push(`${item.title}：缺少依据、研究约束或验证实验`);
      continue;
    }
    // 复用 evidence.ts 的 validateExtraction（即 Swift 的 ExperimentExtraction.validate(source:)），
    // 不在这里重写一套抽取值校验。
    try {
      validateExtraction(
        { dataset: item.evidence, acquisition: [], training: [], loss: [], metrics: [], results: [] },
        source,
      );
    } catch (error) {
      problems.push(`${item.title}：${error instanceof Error ? error.message : String(error)}`);
    }
    // validateExtraction 对「论文未说明」这类未知字段是放行的；但迁移建议整条都只有
    // 未知字段时等于没有原文依据，必须拒绝，否则「附了 evidence」会变成空壳。
    if (!item.evidence.some((f) => f.page != null)) {
      problems.push(`${item.title}：只有未知字段，没有原文依据`);
    }
  }
  if (problems.length) throw new Error(problems.join('；'));
}
