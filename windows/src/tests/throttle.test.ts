// 写盘节流回归：锁住「窗口内的最后一次编辑必须落盘」。
// 这个 bug 的表现是「改完没报错、重启后内容没了」，属于典型的 runs-but-wrong。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThrottledWriter } from '../core/throttle';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('首写立即执行（不等窗口结束）', () => {
  const w = new ThrottledWriter(50);
  let disk = '';
  w.schedule('k', () => { disk = 'a'; });
  assert.equal(disk, 'a', '首写必须立即落盘，避免进程被杀丢数据');
});

test('窗口内的多次编辑最终写入最新值，不能被丢弃', async () => {
  const w = new ThrottledWriter(60);
  let disk = '';
  w.schedule('k', () => { disk = 'v1'; });      // 立即写 v1
  w.schedule('k', () => { disk = 'v2'; });      // 窗口内，应被合并
  w.schedule('k', () => { disk = 'v3'; });      // 最新值
  await sleep(120);
  assert.equal(disk, 'v3', '窗口结束必须写入最新值，否则用户编辑静默丢失');
});

test('窗口结束后重新开始一个新的窗口', async () => {
  const w = new ThrottledWriter(40);
  const writes: string[] = [];
  w.schedule('k', () => writes.push('first'));
  await sleep(80);
  w.schedule('k', () => writes.push('second'));
  assert.deepEqual(writes, ['first', 'second'], '第二个窗口的首写也应立即执行');
});

test('不同 key 互不影响', async () => {
  const w = new ThrottledWriter(50);
  const disk: Record<string, string> = {};
  w.schedule('a', () => { disk.a = '1'; });
  w.schedule('b', () => { disk.b = '2'; });
  w.schedule('a', () => { disk.a = '1b'; });
  await sleep(100);
  assert.equal(disk.a, '1b');
  assert.equal(disk.b, '2');
});

test('flushAll 在退出前写掉所有待写值', () => {
  const w = new ThrottledWriter(10_000); // 窗口远未结束，模拟「立刻退出」
  const disk: Record<string, string> = {};
  w.schedule('a', () => { disk.a = 'x'; });
  w.schedule('a', () => { disk.a = 'y'; }); // 还在窗口内
  w.schedule('b', () => { disk.b = 'z'; });
  assert.deepEqual(w.pendingKeys().sort(), ['a']); // b 首写已落盘
  w.flushAll();
  assert.equal(disk.a, 'y', '退出时必须写掉窗口内未落盘的最新值');
  assert.deepEqual(w.pendingKeys(), []);
});
