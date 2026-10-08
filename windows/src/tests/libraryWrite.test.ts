// 论文库状态写入回归：节流草稿写 + 直接写 不能互相覆盖（丢失更新）。
//
// 复现过的真实缺陷：在「打字（节流）」窗口内「移入回收站」，窗口结束时落下的旧快照
// 会把删除回滚掉——论文在约 600ms 后「复活」。修法是所有写入共享同一份内存状态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ThrottledWriter } from '../core/throttle';
import { saveJSON, readJSON } from '../core/store';
import { LibraryState, defaultLibraryState } from '../core/types';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 复刻主进程的写入模型：一份内存权威状态 + 一个节流器。 */
function makeStore(file: string) {
  const writer = new ThrottledWriter(80);
  let cache: Record<string, LibraryState> = readJSON<Record<string, LibraryState>>(file, {});
  const persist = (): void => {
    const snapshot = cache;
    writer.schedule('library', () => saveJSON(file, snapshot));
  };
  return {
    writer,
    set(key: string, patch: Partial<LibraryState>): void {
      cache[key] = { ...(cache[key] ?? defaultLibraryState()), ...patch };
      persist();
    },
    get(key: string): LibraryState {
      return cache[key] ?? defaultLibraryState();
    },
  };
}

function tempFile(): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-write-'));
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, JSON.stringify({ A: { notes: '' }, B: { status: 'reading' } }));
  return { file, dir };
}

test('节流窗口内的草稿编辑不丢（最后一次值落盘）', async () => {
  const { file, dir } = tempFile();
  const s = makeStore(file);
  s.set('A', { notes: 'v1' });   // 首写立即
  s.set('A', { notes: 'v2' });   // 窗口内合并
  s.set('A', { notes: 'v3' });
  await sleep(160);
  assert.equal(readJSON<any>(file, {}).A.notes, 'v3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('打字窗口内「移入回收站」不得被在途快照回滚', async () => {
  const { file, dir } = tempFile();
  const s = makeStore(file);
  s.set('A', { notes: 'v1' });        // 开窗口
  s.set('A', { notes: 'v2' });        // 窗口内待写
  s.set('B', { status: 'deleted' });  // 同一节流器：删除也必须进这份状态
  await sleep(160);
  const disk = readJSON<any>(file, {});
  assert.equal(disk.B.status, 'deleted', '删除不得被旧快照覆盖（会表现为论文复活）');
  assert.equal(disk.A.notes, 'v2', '草稿同时必须保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('连续两次删除都生效（不互相回滚）', async () => {
  const { file, dir } = tempFile();
  fs.writeFileSync(file, JSON.stringify({ A: {}, B: {}, C: {} }));
  const s = makeStore(file);
  s.set('A', { status: 'deleted' });
  s.set('B', { status: 'deleted' });
  s.set('C', { status: 'deleted' });
  await sleep(160);
  const disk = readJSON<any>(file, {});
  assert.equal(disk.A.status, 'deleted');
  assert.equal(disk.B.status, 'deleted');
  assert.equal(disk.C.status, 'deleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('退出前 flush 保证待写草稿落盘', () => {
  const { file, dir } = tempFile();
  const s = makeStore(file);
  s.set('A', { notes: 'x' });
  s.set('A', { notes: 'y' }); // 仍在窗口内
  s.writer.flushAll();
  assert.equal(readJSON<any>(file, {}).A.notes, 'y');
  fs.rmSync(dir, { recursive: true, force: true });
});
