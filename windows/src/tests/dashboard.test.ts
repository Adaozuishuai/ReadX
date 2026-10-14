// 工作台聚合与 Baseline 卡片的回归（复刻 macOS 版语义）。
//
// 这些是「显示给用户的派生量」，算错会直接误导：连续天数、今日推荐、主题分组
// 都必须与 macOS 版同口径；Baseline 卡片必须标来源、不确定的留待核对、不补造。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streak, weekDays, computeToday, topicMatches, followedTopics, groupByTopic, localDay, EXPLORATION_TOPIC, ProgressMap } from '../core/dashboard';
import { BASELINE_CARDS, matchBaselines, baselineRelation, baselineMatchKey, isNeuralNetwork } from '../core/baseline';
import { defaultLibraryState, QueueEntry } from '../core/types';

const P = (doneAt: string | null) => ({ doneAt } as any);

test('连续阅读：今天未读则从昨天起数；连续区间正确', () => {
  const today = new Date(2026, 9, 10); // 2026-10-10
  const prog: ProgressMap = {};
  // 10-08, 10-09 已完成，今天还没读 -> 应算 2（从昨天往前）
  prog.a = P('2026-10-09T10:00:00');
  prog.b = P('2026-10-08T10:00:00');
  assert.equal(streak(prog, today), 2);
});

test('连续阅读：断链即停', () => {
  const today = new Date(2026, 9, 10);
  const prog: ProgressMap = { a: P('2026-10-10T09:00:00'), b: P('2026-10-08T09:00:00') };
  // 今天已完成，但 10-09 缺失 -> 只算 1
  assert.equal(streak(prog, today), 1);
});

test('连续阅读：完全没有记录为 0', () => {
  assert.equal(streak({}, new Date(2026, 9, 10)), 0);
  assert.equal(streak({ a: P(null) }, new Date(2026, 9, 10)), 0);
});

test('本周格子：周一起算，7 天，标出完成情况', () => {
  const week = weekDays({ a: P('2026-10-08T00:00:00') }, new Date(2026, 9, 10)); // 2026-10-10 是周六
  assert.equal(week.length, 7);
  assert.equal(week[0].label, '一');
  assert.equal(week[6].label, '日');
  // 周一 2026-10-05，周四 2026-10-08 完成
  assert.equal(week[0].day, '2026-10-05');
  assert.equal(week[3].day, '2026-10-08');
  assert.equal(week[3].done, true);
  assert.equal(week[0].done, false);
});

test('localDay 用本地日期，不受时区偏移影响跨日', () => {
  assert.equal(localDay(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(localDay(new Date(2026, 11, 31)), '2026-12-31');
});

test('今日推荐：优先未完成的有笔记论文，按 dateRead 最早', () => {
  const notes = [
    { id: 'n2', key: 'b', title: 'B', venue: '', dateRead: '2026-02-01' },
    { id: 'n1', key: 'a', title: 'A', venue: '', dateRead: '2026-01-01' },
  ];
  const t = computeToday(notes, [], () => defaultLibraryState(), {});
  assert.equal(t?.key, 'a', '应取 dateRead 最早的未完成笔记');
  assert.equal(t?.hasNote, true);
});

test('今日推荐：已完成的笔记被跳过，退到评分最高的未读论文', () => {
  const notes = [{ id: 'n1', key: 'a', title: 'A', venue: '', dateRead: '2026-01-01' }];
  const ranked = [{ key: 'x', title: 'X', venue: '' }];
  const t = computeToday(notes, ranked, () => defaultLibraryState(), { a: P('2026-10-10T00:00:00') });
  assert.equal(t?.key, 'x');
  assert.equal(t?.hasNote, false);
});

test('今日推荐：忽略/已读的笔记不算；全无则 null', () => {
  const notes = [{ id: 'n1', key: 'a', title: 'A', venue: '', dateRead: '2026-01-01' }];
  const ignored = () => ({ ...defaultLibraryState(), status: 'ignored' as const });
  assert.equal(computeToday(notes, [], ignored, {}), null);
});

test('主题匹配与关注主题排序', () => {
  const paper: QueueEntry = { title: 'Sparse-view CBCT with diffusion prior', abstract: '' };
  assert.equal(topicMatches(paper, 'Sparse-view'), true);
  assert.equal(topicMatches(paper, '4D-CBCT'), false);
  const topics = followedTopics({ 'Sparse-view': 3, 'Low-dose': 0, Diffusion: 1, Implicit: 2 });
  assert.deepEqual(topics, ['Sparse-view', 'Implicit', 'Diffusion'], '权重降序，0 权重排除');
});

test('主题流分组：每篇归入权重最高的匹配主题，都不匹配进领域探索', () => {
  const ranked = [
    { paper: { title: 'sparse-view CBCT', abstract: '' } as QueueEntry },
    { paper: { title: '扩散模型', abstract: 'diffusion model for CT' } as QueueEntry },
    { paper: { title: '完全无关' , abstract: '' } as QueueEntry },
  ];
  const groups = groupByTopic(ranked, ['Sparse-view', 'Diffusion']);
  const byName = Object.fromEntries(groups.map(([t, items]) => [t, items.length]));
  assert.equal(byName['Sparse-view'], 1);
  assert.equal(byName['Diffusion'], 1);
  assert.equal(byName[EXPLORATION_TOPIC], 1);
});

// ---------- Baseline 卡片 ----------

test('Baseline 卡片覆盖 PRD 点名的 6 个方法 + IntraTomo3D', () => {
  const ids = BASELINE_CARDS.map((c) => c.id);
  for (const id of ['fdk', 'sart', 'asd-pocs', 'dudonet', 'c2rv', 'nerp', 'trans2-cbct', 'intratomo3d']) {
    assert.ok(ids.includes(id), `缺少 baseline 卡片：${id}`);
  }
});

test('Baseline 类别正确：FDK/SART/ASD-POCS 不是神经网络', () => {
  assert.equal(isNeuralNetwork(BASELINE_CARDS.find((c) => c.id === 'fdk')!.kind), false);
  assert.equal(isNeuralNetwork(BASELINE_CARDS.find((c) => c.id === 'sart')!.kind), false);
  assert.equal(isNeuralNetwork(BASELINE_CARDS.find((c) => c.id === 'nerp')!.kind), true);
});

test('Baseline 匹配键：C²RV 的 ² 与 2 等价，空格与连字符被忽略', () => {
  assert.equal(baselineMatchKey('C²RV'), baselineMatchKey('C2RV'));
  assert.equal(baselineMatchKey('Trans²-CBCT'), baselineMatchKey('trans2cbct'));
});

test('Baseline 匹配：从论文基线名找到卡片，去重', () => {
  const m = matchBaselines(['FDK', 'filtered back-projection', 'NeRP', '未知方法X']);
  const ids = m.map((x) => x.card.id);
  assert.ok(ids.includes('fdk'));
  assert.ok(ids.includes('nerp'));
  assert.equal(ids.filter((x) => x === 'fdk').length, 1, '别名命中同一卡片只出现一次');
});

test('Baseline 关系：只报提及与否，不做优劣推断', () => {
  const fdk = BASELINE_CARDS.find((c) => c.id === 'fdk')!;
  assert.match(baselineRelation(fdk, ['FDK']), /包含 FDK/);
  assert.match(baselineRelation(fdk, ['NeRP']), /未见 FDK/);
});

test('Baseline 卡片不编造：不确定的 origin 为 null 且标待核对', () => {
  const c2rv = BASELINE_CARDS.find((c) => c.id === 'c2rv')!;
  assert.equal(c2rv.origin, null);
  assert.equal(c2rv.source, '待核对');
});
