// 结果表的结构化抽取与校验。移植自 native/Sources/CBCTReading/ResultModels.swift。
//
// 这是 evidence-first 里最严的一段，核心是三层校验：
//   1) 每个单元格的数字必须出现在「该行摘录」里（集合语义）；
//   2) 但集合语义挡不住**列置换**——一行 2×N 个数字时任意排列都满足它；
//      因此再加一条**位置敏感**校验：按表头定义的列顺序取出单元格，
//      要求它们在行摘录中**按先后顺序**逐字出现，从而拦住列错位；
//   3) 单位是「被报告的事实」，不能从指标名推断——必须被其摘录支持。

import { ExperimentField, ExperimentExtraction } from './types';
import { normalized, numbers, validateExtraction } from './evidence';

export interface ResultColumn {
  id: string;
  label: string;
  metric: string;
  /** 未知单位必须保留原样，不得推测量纲。 */
  unit: string;
  context: ExperimentField;
  unitEvidence?: ExperimentField | null;
}

export interface ResultCell {
  columnID: string;
  valueText: string;
  uncertaintyText?: string | null;
}

/** 严格数值解析：只接受纯数字记法，且必须是有限值。 */
export function cellValue(cell: ResultCell): number | null {
  const t = cell.valueText;
  if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export interface ResultRow {
  id: string;
  method: string;
  evidence: ExperimentField;
  cells: ResultCell[];
}

export interface ResultTable {
  id: string;
  caption: ExperimentField;
  header: ExperimentField;
  protocol: ExperimentField;
  columns: ResultColumn[];
  rows: ResultRow[];
  primaryMethodID?: string | null;
}

export interface ResultDiscussion {
  evidence: ExperimentField;
  interpretation: string;
  tableID?: string | null;
  visualID?: string | null;
}

export interface ResultsAnalysis {
  tables: ResultTable[];
  stability: ResultDiscussion[];
  ablation: ResultDiscussion[];
  generalization: ResultDiscussion[];
  efficiency: ResultDiscussion[];
  /** 只允许「作者报告过的」统计检验；绝不生成 p 值。 */
  statistics: ExperimentField[];
  missing: string[];
}

export function discussionGroups(a: ResultsAnalysis): Array<[string, ResultDiscussion[]]> {
  return [
    ['稳定性 / 多数据集', a.stability],
    ['消融', a.ablation],
    ['泛化', a.generalization],
    ['效率', a.efficiency],
  ];
}

export function allDiscussions(a: ResultsAnalysis): ResultDiscussion[] {
  return discussionGroups(a).flatMap(([, g]) => g);
}

const RESULTS_ARRAY_KEYS = ['tables', 'stability', 'ablation', 'generalization', 'efficiency', 'statistics', 'missing'] as const;

/**
 * 去掉 ``` 围栏后解析 JSON，并检查必需字段。
 *
 * 与 reproduction.ts 同一原因：Swift 用 JSONDecoder 解码非可选字段，缺字段会以
 * keyNotFound 失败；JSON.parse 则把它变成 undefined，让 validateResults 崩在
 * `a.statistics is not iterable` 这类 TypeError 上。这里补回解码期检查。
 */
export function decodeResultsAnalysis(raw: string): ResultsAnalysis {
  let text = raw.trim();
  if (text.startsWith('```')) text = text.split('\n').slice(1, -1).join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('结果分析不是合法 JSON：' + (error instanceof Error ? error.message : String(error)));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('结果分析必须是一个 JSON 对象。');
  }
  const obj = parsed as Record<string, unknown>;
  const missing = RESULTS_ARRAY_KEYS.filter((k) => !Array.isArray(obj[k]));
  if (missing.length) {
    throw new Error('结果分析缺少必需的字段（或不是数组）：' + missing.join('、') + '。');
  }
  return parsed as ResultsAnalysis;
}

/** 每条解读必须绑定一张**实际存在**的表或图，且表不能没有解读。 */
export function validateBindings(a: ResultsAnalysis, visuals: Array<{ id: string; kind: string }>): void {
  const tables = new Set(a.tables.map((t) => t.id));
  const figures = new Set(visuals.filter((v) => v.kind === 'figure').map((v) => v.id));
  for (const item of allDiscussions(a)) {
    const hasTable = item.tableID != null;
    const hasVisual = item.visualID != null;
    const boundExists = hasTable ? tables.has(item.tableID!) : (hasVisual ? figures.has(item.visualID!) : false);
    if (hasTable === hasVisual || !boundExists) {
      throw new Error('每条结果解读必须绑定一张实际存在的表或图，不能悬空或同时绑定多个对象。');
    }
  }
  const boundTables = new Set(allDiscussions(a).map((d) => d.tableID).filter((x): x is string => x != null));
  for (const t of tables) {
    if (!boundTables.has(t)) throw new Error('结果表缺少紧邻该表的解读。');
  }
}

export function validateResults(a: ResultsAnalysis, source: string): void {
  const groups = discussionGroups(a);
  let fields: ExperimentField[] = [...a.statistics, ...groups.flatMap(([, g]) => g.map((d) => d.evidence))];

  if (a.tables.length === 0 && fields.length === 0) {
    throw new Error('没有表格或有依据的结果分析');
  }
  if (new Set(a.tables.map((t) => t.id)).size !== a.tables.length) {
    throw new Error('结果表 ID 重复');
  }

  for (const table of a.tables) {
    fields = fields
      .concat([table.caption, table.header, table.protocol])
      .concat(table.columns.map((c) => c.context))
      .concat(table.rows.map((r) => r.evidence))
      .concat(table.columns.map((c) => c.unitEvidence).filter((x): x is ExperimentField => x != null));

    if (table.primaryMethodID != null && !table.rows.some((r) => r.id === table.primaryMethodID)) {
      throw new Error('本文方法不在该表的方法行中：' + table.primaryMethodID);
    }
    const idsUnique = new Set(table.columns.map((c) => c.id)).size === table.columns.length;
    const rowsUnique = new Set(table.rows.map((r) => r.id)).size === table.rows.length;
    if (table.caption.page == null || table.header.page == null || table.columns.length === 0 ||
        table.rows.length < 2 || !idsUnique || !rowsUnique) {
      throw new Error('表格缺少表头、方法行或唯一标识：' + table.id);
    }

    for (const column of table.columns) {
      if (!column.id || !column.label || !column.metric || column.context.page == null) {
        throw new Error('列缺少原文上下文：' + column.id);
      }
      // 单位是被报告的事实，不是从指标名推断的。
      if (column.unit !== '论文未说明') {
        const unitSource = column.unitEvidence ?? column.context;
        if (!normalized(unitSource.excerpt ?? '').includes(normalized(column.unit)) || !column.unit) {
          throw new Error('列单位未被其摘录支持：' + column.id);
        }
      }
    }

    const columnIDs = new Set(table.columns.map((c) => c.id));
    for (const row of table.rows) {
      const cellIDs = new Set(row.cells.map((c) => c.columnID));
      const sameSet = cellIDs.size === columnIDs.size && [...cellIDs].every((x) => columnIDs.has(x));
      if (row.evidence.page == null || !row.method ||
          !normalized(row.evidence.excerpt ?? '').includes(normalized(row.method)) ||
          !sameSet || row.cells.length !== table.columns.length) {
        throw new Error('行标签或单元格不完整：' + row.id);
      }

      const rowNumbers = numbers(row.evidence.excerpt ?? '');
      for (const cell of row.cells) {
        const value = cellValue(cell);
        const cellNumbers = numbers(cell.valueText);
        const supported = cellNumbers.size > 0 && [...cellNumbers].every((n) => rowNumbers.has(n));
        if (value === null || !supported) {
          throw new Error(`单元格数字未匹配方法行：${row.id}/${cell.columnID} = ${cell.valueText}`);
        }
        if (cell.uncertaintyText && cell.uncertaintyText.length > 0) {
          const unsupported = [...numbers(cell.uncertaintyText)].filter((n) => !rowNumbers.has(n));
          if (unsupported.length) throw new Error('不确定性数值未匹配方法行：' + row.id);
        }
      }

      // 位置敏感校验：上面的「数字 ∈ 该行数字集合」是集合语义，一行 2×N 个数字时
      // 任意列置换都满足它（实测转置后可整体通过）。这里按「表头定义的列顺序」取出各行
      // 单元格，要求它们在行摘录中按先后顺序出现，从而拦住列错位。
      // 值必须逐字匹配（保留 .958 这类原记法），与上面的一致性约束一致。
      const excerpt = row.evidence.excerpt ?? '';
      let cursor = 0;
      for (const column of table.columns) {
        const cell = row.cells.find((c) => c.columnID === column.id);
        if (!cell) continue;
        const at = excerpt.indexOf(cell.valueText, cursor);
        if (at < 0) {
          throw new Error(
            `单元格数值未按表头列顺序排列，疑似列错位：${row.id}/${column.id} = ${cell.valueText}。请对照 PDF 原表逐列核对后再输出。`,
          );
        }
        cursor = at + cell.valueText.length;
      }
    }
  }

  const extraction: ExperimentExtraction = {
    dataset: fields, acquisition: [], training: [], loss: [], metrics: [], results: [],
  };
  validateExtraction(extraction, source);
}

export interface ResultDifference {
  a: number;
  b: number;
  unit: string;
  metric: string;
  absolute: number;
}

/** 仅表示报告数值的算术相对变化；对 dB/PSNR 等对数尺度不作物理意义解释。 */
export function relativePercent(d: ResultDifference): number | null {
  if (d.b === 0) return null;
  const result = (d.a - d.b) / Math.abs(d.b) * 100;
  return Number.isFinite(result) ? result : null;
}

export function calculateDifference(
  table: ResultTable, columnID: string, aID: string, bID: string,
): ResultDifference | null {
  if (aID === bID) return null;
  const column = table.columns.find((c) => c.id === columnID);
  if (!column) return null;
  const cellOf = (rowID: string): ResultCell | undefined =>
    table.rows.find((r) => r.id === rowID)?.cells.find((c) => c.columnID === columnID);
  const ac = cellOf(aID);
  const bc = cellOf(bID);
  if (!ac || !bc) return null;
  const a = cellValue(ac);
  const b = cellValue(bc);
  if (a === null || b === null) return null;
  if (!Number.isFinite(a - b)) return null;
  return { a, b, unit: column.unit, metric: column.metric, absolute: a - b };
}
