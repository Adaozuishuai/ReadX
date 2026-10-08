// 对比布局与可比性回归：逐条对应 native/Sources/CBCTReading/CompareModels.swift。
// 每条断言都能真正失败（不存在恒真断言）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  orderedKeys, isPinned, toggled, reconciled,
  checkedRows, warnings, defaultCompareSession, CompareRow,
} from '../core/compare';

// ---------- CompareLayout ----------

test('orderedKeys：被固定的列移到最前，其余保持相对顺序', () => {
  assert.deepEqual(orderedKeys(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(orderedKeys(['a', 'b', 'c'], 'c'), ['c', 'a', 'b']);
  assert.deepEqual(orderedKeys(['a', 'b', 'c'], 'a'), ['a', 'b', 'c']);
});

test('orderedKeys：pinned 为 null 或不在 keys 中时视为未固定，原样返回', () => {
  assert.deepEqual(orderedKeys(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(orderedKeys(['a', 'b'], 'zzz'), ['a', 'b']);
  assert.deepEqual(orderedKeys([], 'a'), []);
  // 原样返回的是同一内容，不做去重/排序
  assert.deepEqual(orderedKeys(['b', 'a'], 'b'), ['b', 'a']);
});

test('isPinned：仅与 pinned 完全相等才为真', () => {
  assert.equal(isPinned('a', 'a'), true);
  assert.equal(isPinned('a', 'b'), false);
  assert.equal(isPinned('a', null), false);
});

test('toggled：同一列再点一次即取消固定', () => {
  assert.equal(toggled('a', null), 'a');
  assert.equal(toggled('a', 'b'), 'a');
  assert.equal(toggled('a', 'a'), null);
});

test('reconciled：清理已不在选中集合中的失效固定', () => {
  assert.equal(reconciled(['a', 'b'], 'a'), 'a');
  assert.equal(reconciled(['a', 'b'], 'zzz'), null);
  assert.equal(reconciled(['a', 'b'], null), null);
  assert.equal(reconciled([], 'a'), null);
});

test('CompareSession 默认值：空选择、未固定', () => {
  assert.deepEqual(defaultCompareSession(), { selected: [], pinned: null });
});

// 场景串联：固定 b → 取消选中 b → 固定失效
test('固定列在选中集合变化后被清理（端到端场景）', () => {
  let selected = ['a', 'b', 'c'];
  let pinned: string | null = toggled('b', null);
  assert.equal(pinned, 'b');
  assert.equal(isPinned('b', pinned), true);
  assert.deepEqual(orderedKeys(selected, pinned), ['b', 'a', 'c']);

  selected = selected.filter((k) => k !== 'b');
  pinned = reconciled(selected, pinned);
  assert.equal(pinned, null);
  assert.deepEqual(orderedKeys(selected, pinned), ['a', 'c']);
});

// ---------- Comparability ----------

test('checkedRows 恰为三个维度', () => {
  assert.deepEqual([...checkedRows].sort(), ['几何', '数据集', '视角数'].sort());
  assert.equal(checkedRows.size, 3);
});

test('两个不同的已知值 → 给出警示，文案一致', () => {
  const out = warnings([['几何', ['360° 圆轨迹', '180° 半扫描']]]);
  assert.equal(out.length, 1);
  assert.equal(out[0], '几何不一致（2 种已知设置）：不同实验协议的指标不能直接排名，请核对采集条件后再比较。');
});

test('一个已知值 + 一个「论文未说明」→ 不警示（未知不参与判断，不误报）', () => {
  assert.deepEqual(warnings([['几何', ['360° 圆轨迹', '论文未说明']]]), []);
  assert.deepEqual(warnings([['数据集', ['Walnut（论文未说明细节）', 'Walnut']]]), []);
  // 全部未知同样不警示
  assert.deepEqual(warnings([['视角数', ['论文未说明', '尚未抽取']]]), []);
});

test('值相同（大小写/空白不同）→ 不警示', () => {
  assert.deepEqual(warnings([['数据集', ['Walnut', 'walnut']]]), []);
  assert.deepEqual(warnings([['数据集', ['Walnut', ' Wal nut ']]]), []);
});

test("去掉 ' [研究笔记，需核对]' 后缀后相同 → 不警示", () => {
  assert.deepEqual(warnings([['几何', ['360° 圆轨迹', '360° 圆轨迹 [研究笔记，需核对]']]]), []);
  // 去掉后缀后确实不同 → 仍然警示
  const out = warnings([['几何', ['180° 半扫描 [研究笔记，需核对]', '360° 圆轨迹']]]);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('几何不一致（2 种已知设置）'), out[0]);
});

test('非 checkedRows 的行不参与检查', () => {
  assert.deepEqual(warnings([
    ['方法', ['Implicit', 'Explicit']],
    ['备注', ['a', 'b']],
  ]), []);
});

test('三种以上已知设置时警示里报告 distinct 数量', () => {
  const out = warnings([['视角数', ['8 views', '16 views', '32 views', ' 8 Views ']]]);
  assert.equal(out.length, 1);
  assert.ok(out[0].includes('视角数不一致（3 种已知设置）'), out[0]);
});

test('多个维度的警示按行顺序输出', () => {
  const rows: Array<[string, string[]]> = [
    ['视角数', ['8', '16']],
    ['方法', ['a', 'b']],
    ['数据集', ['Walnut', 'LUNA16']],
  ];
  const out = warnings(rows);
  assert.deepEqual(out.map((s) => s.slice(0, 3)), ['视角数', '数据集']);
});

test('CompareRow 结构与 warnings 输入对齐', () => {
  const row: CompareRow = { label: '几何', values: ['a', 'b'] };
  assert.deepEqual(warnings([[row.label, row.values]]).length, 1);
});
