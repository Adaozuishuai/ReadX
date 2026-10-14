// 实验配置抽取的结构化解码（对齐 macOS ResultModels/ReproductionModels 的解码期检查）。
//
// 与 reproduction.ts / result.ts 同一原因：Swift 的 JSONDecoder 在缺字段时会以
// keyNotFound 失败；JSON.parse 只把它变成 undefined，让后续校验崩在 `undefined.length`
// 之类的 TypeError 上。这里补回解码期的结构检查，使两边行为对齐、错误可读。

import { ExperimentExtraction } from './types';

function stripFence(text: string): string {
  let raw = text.trim();
  if (raw.startsWith('```')) raw = raw.split('\n').slice(1, -1).join('\n');
  return raw;
}

const GROUPS = ['dataset', 'acquisition', 'training', 'loss', 'metrics', 'results'] as const;

export function decodeExperiment(text: string): ExperimentExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch (error) {
    throw new Error('实验抽取不是合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('实验抽取必须是一个 JSON 对象。');
  }
  const obj = parsed as Record<string, unknown>;
  const missing = GROUPS.filter((k) => !Array.isArray(obj[k]));
  if (missing.length) {
    // baselines 与 macOS 一致为**可选**（缺省按空数组处理），故只校验这六组必需字段。
    throw new Error('实验抽取缺少必需的组（或不是数组）：' + missing.join('、') + '。（baselines 可选，其余六组都必须给出）');
  }
  return parsed as ExperimentExtraction;
}
