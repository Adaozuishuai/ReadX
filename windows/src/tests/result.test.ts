// 结果表校验回归。核心是**列置换必须被拒绝**：
// 集合语义（数字 ∈ 该行数字集合）挡不住转置，必须靠位置敏感校验。
//
// 注意：用例必须让「正确赋值」能通过，否则会因别的原因被拒、测不到顺序校验本身。
// 这条坑在 Swift 版出现过（早期用例被 rows.count >= 2 之类的无关守卫挡住而假通过）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

import {
  ResultsAnalysis, ResultTable, ResultColumn, ResultRow, ResultCell,
  validateResults, validateBindings, decodeResultsAnalysis, cellValue,
  calculateDifference, relativePercent, discussionGroups,
} from '../core/result';
import { ExperimentField } from '../core/types';
import { findRoot, Paths } from '../core/store';

const ROOT = findRoot(__dirname);
const paths = new Paths(ROOT);

function field(k: string, v: string, quote: string, page = 1): ExperimentField {
  return { k, v, page, excerpt: quote };
}

function resultFixture(): { analysis: ResultsAnalysis; source: string } {
  const source = '=== Page 1 ===\nTable 1: Brain results. PSNR (dB) and SSIM (dimensionless).\nA 33.05 .96\nB 22.89 .78';
  const header = field('Header', 'Brain PSNR and SSIM', 'Brain results. PSNR (dB) and SSIM (dimensionless).');
  const columns: ResultColumn[] = [
    { id: 'p', label: 'Brain', metric: 'PSNR', unit: 'dB', context: header },
    { id: 's', label: 'Brain', metric: 'SSIM', unit: 'dimensionless', context: header },
  ];
  const rows: ResultRow[] = [
    {
      id: 'a', method: 'A', evidence: field('A', 'A 33.05 .96', 'A 33.05 .96'),
      cells: [{ columnID: 'p', valueText: '33.05' }, { columnID: 's', valueText: '.96' }],
    },
    {
      id: 'b', method: 'B', evidence: field('B', 'B 22.89 .78', 'B 22.89 .78'),
      cells: [{ columnID: 'p', valueText: '22.89' }, { columnID: 's', valueText: '.78' }],
    },
  ];
  const table: ResultTable = {
    id: 't', caption: field('Caption', 'Brain results', 'Table 1: Brain results.'),
    header, protocol: { k: 'Protocol', v: '论文未说明', page: null, excerpt: null },
    columns, rows,
  };
  return {
    analysis: { tables: [table], stability: [], ablation: [], generalization: [], efficiency: [], statistics: [], missing: ['Protocol unconfirmed'] },
    source,
  };
}

test('合规结果表通过校验', () => {
  const { analysis, source } = resultFixture();
  validateResults(analysis, source);
});

test('伪造单元格数值被拒绝（数字必须在该行摘录里）', () => {
  const { analysis, source } = resultFixture();
  analysis.tables[0].rows[0].cells[0].valueText = '99.99';
  assert.throws(() => validateResults(analysis, source));
});

test('改变数字记法也被拒绝（.96 不得写成 0.96）', () => {
  const { analysis, source } = resultFixture();
  analysis.tables[0].rows[0].cells[1].valueText = '0.96';
  assert.throws(() => validateResults(analysis, source));
});

test('单元格引用不存在的列被拒绝', () => {
  const { analysis, source } = resultFixture();
  analysis.tables[0].rows[0].cells[0].columnID = 'invented';
  assert.throws(() => validateResults(analysis, source));
});

test('单位必须被摘录支持（dB -> GB 被拒）', () => {
  const { analysis, source } = resultFixture();
  analysis.tables[0].columns[0].unit = 'GB';
  assert.throws(() => validateResults(analysis, source));
});

test('行证据页码不存在被拒绝', () => {
  const { analysis, source } = resultFixture();
  analysis.tables[0].rows[0].evidence.page = 99;
  assert.throws(() => validateResults(analysis, source));
});

test('统计字段的数字不被摘录支持时被拒绝', () => {
  const { analysis, source } = resultFixture();
  analysis.statistics = [field('p', 'p=0.01', 'Brain results. PSNR (dB)')];
  assert.throws(() => validateResults(analysis, source));
});

// ---------- 列置换（最关键） ----------

function transpositionAnalysis(naf: [string, string], sart: [string, string]): { analysis: ResultsAnalysis; src: string } {
  const quote = 'NAF 33.05 .96 | SART 32.12 .95';
  const f = (k: string, v: string): ExperimentField => ({ k, v, page: 1, excerpt: quote });
  const cols: ResultColumn[] = [
    { id: 'p', label: 'PSNR', metric: 'PSNR', unit: '论文未说明', context: f('h', quote) },
    { id: 's', label: 'SSIM', metric: 'SSIM', unit: '论文未说明', context: f('h', quote) },
  ];
  const row = (id: string, method: string, cells: [string, string], ex: string): ResultRow => ({
    id, method, evidence: { k: method, v: method, page: 1, excerpt: ex },
    cells: [{ columnID: 'p', valueText: cells[0] }, { columnID: 's', valueText: cells[1] }],
  });
  const table: ResultTable = {
    id: 't', caption: f('c', 'Table'), header: f('h', quote),
    protocol: { k: 'P', v: '论文未说明', page: null, excerpt: null },
    columns: cols,
    rows: [row('naf', 'NAF', naf, 'NAF 33.05 .96'), row('sart', 'SART', sart, 'SART 32.12 .95')],
  };
  return {
    analysis: { tables: [table], stability: [], ablation: [], generalization: [], efficiency: [], statistics: [], missing: [] },
    src: '=== Page 1 ===\n' + quote,
  };
}

test('正确列序通过（先确认用例不是因为无关原因才被拒）', () => {
  const { analysis, src } = transpositionAnalysis(['33.05', '.96'], ['32.12', '.95']);
  validateResults(analysis, src);
});

test('列置换被拒绝：数字仍在同一行摘录里，但顺序与表头不符', () => {
  const { analysis, src } = transpositionAnalysis(['.96', '33.05'], ['.95', '32.12']);
  assert.throws(
    () => validateResults(analysis, src),
    /列错位|列顺序/,
    '集合语义挡不住转置，必须由位置敏感校验拒绝',
  );
});

test('位置校验确实独立生效：只有顺序错、集合仍成立时才抛错', () => {
  const { analysis, src } = transpositionAnalysis(['.96', '33.05'], ['.95', '32.12']);
  // 先证明集合语义成立——两行摘录里都同时含这两个数字
  const { numbers } = require('../core/evidence') as typeof import('../core/evidence');
  for (const r of analysis.tables[0].rows) {
    const rowNums = numbers(r.evidence.excerpt ?? '');
    for (const c of r.cells) {
      for (const n of numbers(c.valueText)) assert.ok(rowNums.has(n), '集合语义应成立');
    }
  }
  // 但顺序校验必须仍然拒绝
  assert.throws(() => validateResults(analysis, src));
});

// ---------- 差值计算 ----------

test('差值计算与相对变化', () => {
  const { analysis } = resultFixture();
  const table = analysis.tables[0];
  const psnr = calculateDifference(table, 'p', 'a', 'b')!;
  assert.ok(Math.abs(psnr.absolute - 10.16) < 1e-10);
  assert.ok(Math.abs(relativePercent(psnr)! - (psnr.a - psnr.b) / Math.abs(psnr.b) * 100) < 1e-10);

  const ssim = calculateDifference(table, 's', 'a', 'b')!;
  assert.ok(Math.abs(ssim.absolute - 0.18) < 1e-10);
  assert.ok(Math.abs(relativePercent(ssim)! - 23.0769230769) < 1e-8);

  // 同一行不能自比
  assert.equal(calculateDifference(table, 's', 'a', 'a'), null);
  // 不存在的列
  assert.equal(calculateDifference(table, 'invented', 'a', 'b'), null);
});

test('分母为 0 时不给相对百分比（避免除零/无穷）', () => {
  const { analysis } = resultFixture();
  const table = analysis.tables[0];
  table.rows[1].cells[1].valueText = '0';
  assert.equal(relativePercent(calculateDifference(table, 's', 'a', 'b')!), null);
});

test('NaN / 溢出数值不被当作有效值', () => {
  assert.equal(cellValue({ columnID: 's', valueText: 'NaN' }), null);
  assert.equal(cellValue({ columnID: 's', valueText: '1e9999' }), null);
  assert.equal(cellValue({ columnID: 's', valueText: '.958' }), 0.958);
  assert.equal(cellValue({ columnID: 's', valueText: '1e308' }), 1e308);
});

test('极大值相减溢出时不返回差值', () => {
  const { analysis } = resultFixture();
  const table = analysis.tables[0];
  table.rows[0].cells[0].valueText = '1e308';
  table.rows[1].cells[0].valueText = '-1e308';
  assert.equal(calculateDifference(table, 'p', 'a', 'b'), null);
});

// ---------- 绑定与解码 ----------

test('解读必须绑定真实存在的表或图', () => {
  const { analysis, source } = resultFixture();
  const visuals = [
    { id: 'table1', kind: 'table' }, { id: 'fig2', kind: 'figure' },
  ];
  const ev = analysis.tables[0].rows[0].evidence;
  analysis.stability = [{ evidence: ev, interpretation: '仅支持当前数据集对比。', tableID: 't' }];
  validateBindings(analysis, visuals);

  // 悬空绑定
  analysis.stability[0].tableID = 'absent';
  assert.throws(() => validateBindings(analysis, visuals));
  // 同时绑定表与图
  analysis.stability[0].tableID = 't';
  analysis.stability[0].visualID = 'fig2';
  assert.throws(() => validateBindings(analysis, visuals));
  // 有表但没有解读
  analysis.stability = [];
  assert.throws(() => validateBindings(analysis, visuals));
});

test('解码支持 ``` 围栏与裸 JSON', () => {
  const { analysis } = resultFixture();
  const raw = JSON.stringify(analysis);
  assert.equal(decodeResultsAnalysis(raw).tables[0].rows.length, 2);
  assert.equal(decodeResultsAnalysis('```json\n' + raw + '\n```').tables[0].rows.length, 2);
});

test('分组标题齐全（UI 依赖这四组）', () => {
  const { analysis } = resultFixture();
  assert.deepEqual(discussionGroups(analysis).map(([k]) => k), ['稳定性 / 多数据集', '消融', '泛化', '效率']);
});

// 解码期结构校验：缺字段必须是可读错误，不能崩成 TypeError
test('results decode：缺必需字段时给出可读错误', () => {
  assert.throws(
    () => decodeResultsAnalysis('{"tables":[]}'),
    (e: Error) => /缺少必需的字段/.test(e.message) && !/not iterable/.test(e.message),
  );
  assert.throws(() => decodeResultsAnalysis('[]'), /必须是一个 JSON 对象/);
  assert.throws(() => decodeResultsAnalysis('{bad'), /不是合法 JSON/);
});
