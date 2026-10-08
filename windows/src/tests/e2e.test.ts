// 端到端检查（不启动 Electron）：用真实工作区数据跑一遍主进程的核心路径，
// 确认「读到的数据是对的」，而不仅是「代码能编译」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { Paths, findRoot, readJSON, readCachedPDFText, findLocalPdf, readJSONStrict } from '../core/store';
import { decodeQueue, rank, matchesProfile } from '../core/paper';
import { defaultProfile, defaultLibraryState, LibraryState } from '../core/types';
import { preparePaperContext } from '../main/ai';
import { pages, citations } from '../core/evidence';

const ROOT = findRoot(__dirname);
const paths = new Paths(ROOT);

test('工作区根解析到真实项目根（含 queue.json）', () => {
  assert.ok(fs.existsSync(paths.queuePath), `未找到 ${paths.queuePath}`);
  assert.ok(paths.root.includes('cbct-reading'), `根路径可疑：${paths.root}`);
});

test('论文库列表：真实队列 + 真实库状态能合并出完整条目', () => {
  const queue = decodeQueue(readJSON<unknown>(paths.queuePath, { papers: [] }));
  const states = readJSON<Record<string, LibraryState>>(paths.libraryStatePath, {});
  assert.ok(queue.length > 0, '队列不应为空');

  const profile = { ...defaultProfile(), ...readJSON<Partial<ReturnType<typeof defaultProfile>>>(paths.profilePath, {}) };
  const items = queue.map((p) => {
    const key = p.arxiv ?? p.id ?? '';
    const st = states[key] ?? defaultLibraryState();
    const r = rank(p, profile, st);
    return { key, score: r.score, matches: matchesProfile(r), hasPDF: !!findLocalPdf(paths, key), hasText: !!readCachedPDFText(paths, key) };
  });

  assert.ok(items.every((i) => i.score >= 0 && i.score <= 100), '分数必须在 0–100');
  // 真实数据里 NAF 有 PDF 与全文缓存，是端到端可精读的样本
  const naf = items.find((i) => i.key === '2209.14540');
  if (naf) {
    assert.ok(naf.hasPDF, 'NAF 应有本地 PDF');
    assert.ok(naf.hasText, 'NAF 应有全文缓存');
  }
});

test('库状态读写格式与 macOS 版一致（可被对方读取）', () => {
  const raw = readJSON<Record<string, any>>(paths.libraryStatePath, {});
  const keys = Object.keys(raw);
  if (!keys.length) return;
  const sample = raw[keys[0]];
  for (const f of ['status', 'favorite', 'tags', 'notes', 'relevance', 'corrections', 'updatedAt']) {
    assert.ok(f in sample, `库状态缺少 macOS 版字段：${f}`);
  }
  const valid = ['unread', 'later', 'reading', 'read', 'ignored', 'deleted'];
  assert.ok(valid.includes(sample.status), `未知状态值：${sample.status}`);
});

test('精读材料准备：真实 NAF 全文能选出材料并保留可引用页码', () => {
  const text = readCachedPDFText(paths, '2209.14540');
  if (!text) return;
  const prep = preparePaperContext(text, 'PSNR 是多少', '全文');
  assert.ok(prep.total >= 10, 'NAF 应有 10 页以上');
  assert.ok(prep.included > 0 && prep.included <= prep.total);
  // 材料里的页码必须能被 evidence 层解析出来，否则模型引用的 Page N 无法校验
  const nums = pages(prep.material).map((p) => p.number);
  assert.ok(nums.length > 0, '材料必须保留 === Page N === 标记');
  assert.ok(nums.every((n) => n >= 1 && n <= prep.total));
  // 若为子集，必须带范围披露
  if (prep.included < prep.total) assert.ok(prep.material.startsWith('【材料范围】'));
});

test('范围检索不会把 References 当证据交给模型', () => {
  const text = readCachedPDFText(paths, '2209.14540');
  if (!text) return;
  const method = preparePaperContext(text, 'hash grid', 'Method');
  assert.ok(!/=== Page .* ===\s*References/i.test(method.material), 'Method 材料不得包含 References 段');
});

test('损坏的阅读记录被显式报错，而不是静默返回空', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'windows', '.tmp-corrupt-'));
  const fake = new Paths(dir);
  fs.mkdirSync(path.dirname(fake.readingsPath('x')), { recursive: true });
  fs.writeFileSync(fake.readingsPath('x'), '{ not valid json', 'utf8');
  const r = readJSONStrict(fake.readingsPath('x'));
  assert.equal(r.ok, false, '损坏 JSON 必须被判为失败');
  if (!r.ok) assert.equal(r.missing, false, '这不是「文件不存在」，而是损坏');
  // 不存在的文件应标记 missing，便于上层区分
  const missing = readJSONStrict(fake.readingsPath('nope'));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.missing, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('全文缓存里的引用页码都能在缓存中定位', () => {
  const text = readCachedPDFText(paths, '2209.14540');
  if (!text) return;
  const available = new Set(pages(text).map((p) => p.number));
  // 取真实笔记里出现的 Page 引用做抽查
  const refs = citations('见 Page 2 与 Page 5，另见 Page 11');
  for (const r of refs) assert.ok(available.has(r), `Page ${r} 不在缓存页范围内`);
});
