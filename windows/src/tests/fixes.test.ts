// 缺陷回归：历次审查修复的「能跑但结果错 / 会丢数据」缺陷，每个都先复现再修。
//
// 1) noteForQueue 用未归一化的 arxiv 比较 -> 带版本号的队列条目匹配不到笔记；
// 2) 空 scope（论文没有该章节 / scope 值无法识别）-> 把空材料交给模型，无原文作答；
// 3) reading/results 保存时损坏文件被 {} 覆盖；
// 4) library.json 损坏时静默当空对象 -> 下一次写入把整库状态覆盖成空；
// 5-7) 2026-10-12 审查：IPC key 原型污染/路径穿越、queue/progress/config 损坏覆盖、
//      mathTypeset flatten 静默丢上下标（见下方分节注释）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { noteForQueue } from '../core/notes';
import { preparePaperMaterial } from '../main/ai';
import { LibraryStore } from '../core/libraryState';
import { saveJSON, readJSON, readJSONStrict, isSafeObjectKey, isSafePathKey, Paths } from '../core/store';
import { reproductionPath } from '../core/persist';
import { parseMath } from '../core/mathTypeset';

function tmpFile(name: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbct-fix-'));
  return { file: path.join(dir, name), dir };
}

// ---------- 缺陷 1 ----------

test('缺陷1：队列 arxiv 带版本号也能匹配到笔记（版本号必须归一化）', () => {
  const notes = [{ id: '2022-naf', file: '2022-naf.md', meta: { arxiv: '2209.14540' }, sections: {} }];
  // arXiv 官方 feed 的 id 带版本号；笔记 frontmatter 通常不带。修复前这里返回 null，
  // 论文会在库里丢掉「有全文缓存 / 已精读」标记。
  assert.ok(noteForQueue(notes, { arxiv: '2209.14540v2' }), '带版本号必须匹配');
  assert.ok(noteForQueue(notes, { arxiv: '2209.14540' }), '不带版本号仍要匹配');
  assert.ok(noteForQueue(notes, { arxiv: 'https://arxiv.org/abs/2209.14540v3' }), 'URL 形式也要匹配');
  assert.equal(noteForQueue(notes, { arxiv: '9999.99999' }), null, '不同论文不得误配');
});

// ---------- 缺陷 2 ----------

const PAPER = [
  '=== Page 1 ===', '1. Introduction', 'We study CBCT.',
  '=== Page 2 ===', '2. Method', 'Our method uses hash encoding.',
  '=== Page 3 ===', '3. Experiments', 'We report PSNR.',
].join('\n');

test('缺陷2：没有全文缓存时拒绝做事实问答', () => {
  const r = preparePaperMaterial(null, 'PSNR 是多少', '全文');
  assert.equal(r.ok, false);
  const r2 = preparePaperMaterial('   ', 'x', '全文');
  assert.equal(r2.ok, false);
});

test('缺陷2：该 scope 选不出内容时必须停止，而不是把空材料交给模型', () => {
  // 这篇论文没有 Appendix；修复前会返回 {ok:true, material:''}，模型凭记忆作答。
  const r = preparePaperMaterial(PAPER, 'x', 'Appendix');
  assert.equal(r.ok, false, '空材料必须被拒绝');
  if (!r.ok) assert.match(r.error, /没有选到任何内容/);
  // 无法识别的 scope 同理
  assert.equal(preparePaperMaterial(PAPER, 'x', 'Bogus').ok, false);
});

test('缺陷2：正常 scope 仍返回材料与页码覆盖', () => {
  const r = preparePaperMaterial(PAPER, 'psnr', '全文');
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(r.material.includes('=== Page 1 ==='));
    assert.ok(r.total >= 3);
  }
});

// ---------- 缺陷 3 ----------

test('缺陷3：阅读记录损坏时保存被拒绝，且不覆盖原文件', () => {
  const { file, dir } = tmpFile('x.json');
  const broken = '{ not valid json';
  fs.writeFileSync(file, broken, 'utf8');
  // 复刻 reading:save 的守卫：损坏（非 missing）时必须拒绝
  const cur = readJSONStrict<Record<string, unknown>>(file);
  assert.equal(cur.ok, false);
  assert.equal(cur.ok === false && cur.missing, false, '应判定为损坏而非不存在');
  // 修复前会 base={} 然后写入，把损坏文件覆盖掉
  assert.equal(fs.readFileSync(file, 'utf8'), broken, '损坏文件必须原样保留，等待人工修复');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 缺陷 4 ----------

test('缺陷4：library.json 损坏时写入被拒绝，不把整库覆盖成空', () => {
  const { file, dir } = tmpFile('library.json');
  const broken = JSON.stringify({ A: { status: 'read', notes: '重要笔记' } }).slice(0, 8) + 'BROKEN';
  fs.writeFileSync(file, broken, 'utf8');
  const store = new LibraryStore(file, 10);

  const r = store.set('A', { notes: '新笔记' });
  assert.equal(r.ok, false, '损坏时必须拒绝写入');
  if (!r.ok) assert.match(r.error, /已损坏/);
  assert.equal(store.remove('A').ok, false, '删除也必须拒绝');

  store.flush();
  // 关键断言：文件没有被 {} 覆盖
  assert.equal(fs.readFileSync(file, 'utf8'), broken, '损坏文件不得被空状态覆盖');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺陷4：文件不存在时按空处理，正常写入可用（首次使用不是错误）', async () => {
  const { file, dir } = tmpFile('library.json');
  const store = new LibraryStore(file, 10);
  assert.equal(store.error(), null);
  const r = store.set('A', { notes: 'x' });
  assert.equal(r.ok, true);
  store.flush();
  assert.equal(readJSON<any>(file, {}).A.notes, 'x');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺陷4：正常文件下节流窗口内「删除」不被在途草稿回滚（原缺陷回归）', async () => {
  const { file, dir } = tmpFile('library.json');
  saveJSON(file, { A: { notes: '' }, B: { status: 'reading' } });
  const store = new LibraryStore(file, 80);
  store.set('A', { notes: 'v1' });
  store.set('A', { notes: 'v2' });
  store.remove('B');
  await new Promise((r) => setTimeout(r, 160));
  const disk = readJSON<any>(file, {});
  assert.equal(disk.B.status, 'deleted', '删除不得被旧快照覆盖（论文复活）');
  assert.equal(disk.A.notes, 'v2', '草稿必须同时保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 2026-10-12 审查修复 ----------
//
// 5) IPC key 无校验 -> 原型污染（__proto__）与路径穿越（../../queue）；
// 6) queue.json / progress.json / config.json 损坏时静默当空再整文件覆盖（H9 复发面）；
// 7) \mathrm/\text 参数含上下标或分数时 flatten 静默丢内容（x^2 -> "x"）却标 supported。

test('缺陷5：isSafeObjectKey / isSafePathKey 拦截保留名与路径穿越，放行全部合法 key 形态', () => {
  for (const bad of ['__proto__', 'constructor', 'prototype', '', 'a\0b', null, undefined, 123, {}]) {
    assert.equal(isSafeObjectKey(bad), false, `${String(bad)} 必须被拒`);
  }
  for (const good of ['2209.14540', '2022-naf', 's2-abc123', 'intratomo-2021']) {
    assert.equal(isSafeObjectKey(good), true);
    assert.equal(isSafePathKey(good), true);
  }
  for (const bad of ['../../queue', '../evil', '/etc/passwd', 'C:\\secrets', '\\\\server\\share', 'a..b']) {
    assert.equal(isSafePathKey(bad), false, `${bad} 必须被拒`);
  }
});

test('缺陷5：路径构造对穿越 key 抛错，对合法 key 正常', () => {
  const p = new Paths(path.join(os.tmpdir(), 'cbct-root'));
  assert.match(p.readingsPath('2022-naf'), /readings[\\/]2022-naf\.json$/);
  assert.match(p.pdfTextPath('2209.14540'), /2209\.14540-v3\.txt$/);
  assert.throws(() => p.readingsPath('../../queue'), /非法/);
  assert.throws(() => p.pdfTextPath('__proto__'), /非法/);
  assert.throws(() => p.indexPath('..\\..\\evil'), /非法/);
  assert.throws(() => reproductionPath(p, '../evil'), /非法/);
});

test('缺陷5：LibraryStore 拒绝 __proto__ key，不污染 Object.prototype、不落盘', () => {
  const { file, dir } = tmpFile('library.json');
  const store = new LibraryStore(file, 10);
  const r = store.set('__proto__', { notes: 'pwned' } as any);
  assert.equal(r.ok, false);
  assert.equal(({} as any).notes, undefined, 'Object.prototype 不得被污染');
  assert.equal(store.remove('__proto__').ok, false);
  assert.equal(store.restore('constructor').ok, false);
  assert.equal(store.purge('prototype').ok, false);
  store.flush();
  assert.equal(fs.existsSync(file), false, '全部拒绝时不得写盘');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺陷6：queue/progress/config 共用的 readJSONStrict 对损坏文件报 ok:false（拒写前提）', () => {
  // main.ts 的 progress:save / ensureInQueue / config:set 现在都以此为准入门槛：
  // 损坏 -> ok:false 且 missing:false -> 拒绝保存；不存在 -> missing:true -> 允许按空起步。
  const { file, dir } = tmpFile('queue.json');
  fs.writeFileSync(file, '{"papers":[ {"id":"manual"} ] BROKEN', 'utf8');
  const broken = readJSONStrict(file);
  assert.equal(broken.ok, false);
  assert.equal(broken.ok === false && broken.missing, false, '损坏必须与「不存在」区分开');
  const missing = readJSONStrict<unknown>(path.join(dir, 'no-such-file.json'));
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.missing, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('缺陷7：\\mathrm/\\text 参数含上下标或分数时整式降级，绝不静默丢内容', () => {
  // 修复前：\mathrm{x^2} flatten 成 "x"、\text{H_2O} 成 "HO"，且 supported:true 不触发降级，
  // 残缺公式被渲染得像对的——与本文件「绝不半渲染半猜测」纪律冲突。
  assert.equal(parseMath('\\mathrm{x^2}').supported, false);
  assert.equal(parseMath('\\text{H_2O}').supported, false);
  assert.equal(parseMath('\\text{\\frac{a}{b}}').supported, false);
  assert.equal(parseMath('\\mathbb{R^2}').supported, false);
  // 正常纯文本参数不受影响
  assert.equal(parseMath('\\mathrm{PSNR}').supported, true);
  assert.equal(parseMath('\\text{chest}').supported, true);
  assert.equal(parseMath('\\mathbb{R}').supported, true);
});

// ---------- 2026-10-13 解析可靠性（真实 API 复现的两类系统性误拒） ----------

test('缺陷8：numbers() 统一「符号+空格+数字」形态（5×10 - 4 与 5×10-4 同 token）', () => {
  const { numbers } = require('../core/evidence') as typeof import('../core/evidence');
  assert.ok(numbers('the learning rate is set to 5×10 - 4').has('-4'), '拆开的负指数应归一为 -4');
  assert.deepEqual(
    [...numbers('5×10 - 4')].sort(), [...numbers('5×10-4')].sort(),
    'v 与摘录两侧 token 必须一致，否则数字子集校验误拒');
  // 不影响正常记法
  assert.ok(numbers('34.45/.95').has('34.45'));
  assert.ok(numbers('Adam 1e-3 → 1e-4').has('-4'));
});

test('缺陷9：v 里的文内引用号 [42] 不算测量值；未知声明的近似措辞放行', () => {
  const { validateExtraction } = require('../core/evidence') as typeof import('../core/evidence');
  const source = '=== Page 6 ===\nThe loss function is optimized using the Adam method with a learning rate of 1e-4 for 250 epochs.';
  // 引用号在摘录之外：修复前 42 被判「未被摘录支持」
  validateExtraction({ dataset: [], acquisition: [], training: [
    { k: 'optimizer', v: 'Adam method[42]', page: 6, excerpt: 'The loss function is optimized using the Adam method' },
  ], loss: [], metrics: [], results: [] } as any, source);
  // 未知声明近似措辞 + page/excerpt 为 null：修复前精确匹配表太窄被拒
  validateExtraction({ dataset: [{ k: '统计检验', v: '论文未报告显著性检验', page: null, excerpt: null } as any],
    acquisition: [], training: [], loss: [], metrics: [], results: [] } as any, source);
  // 但带数字的无摘录事实仍必须被拒（没有放松反编造约束）
  assert.throws(() => validateExtraction({ dataset: [{ k: 'x', v: 'PSNR 42.5', page: null, excerpt: null } as any],
    acquisition: [], training: [], loss: [], metrics: [], results: [] } as any, source));
});

// ---------- 2026-10-13 兜底修剪（pruneGenerated） ----------

const PRUNE_SRC = '=== Page 6 ===\nThe volume size is 128x128x128. Adam optimizer with lr 1e-3. Five datasets are used: chest, jaw, foot, abdomen, aorta.';

test('兜底修剪：实验配置逐字段降级后必然通过校验，降级清单如实记录', () => {
  const { pruneGenerated, validateGeneratedOutput } = require('../main/ai.js');
  const bad = JSON.stringify({
    dataset: [{ k: 'datasets', v: 'Five datasets are used: chest, jaw, foot, abdomen, aorta.', page: 6, excerpt: 'Five datasets are used: chest, jaw, foot, abdomen, aorta.' }],
    acquisition: [{ k: 'volume', v: '体积 512³（编造）', page: 6, excerpt: '完全不相干的摘录文字xyz' }],
    training: [{ k: 'optimizer', v: 'Adam lr 1e-3', page: 6, excerpt: 'Adam optimizer with lr 1e-3' }],
    loss: [], metrics: [], results: [{ k: 'psnr', v: '34.45 dB', page: 6, excerpt: 'irrelevant' }], baselines: [],
  });
  assert.throws(() => validateGeneratedOutput('experiment', bad, PRUNE_SRC));
  const r = pruneGenerated('experiment', bad, PRUNE_SRC);
  assert.ok(r, '修剪必须收敛');
  assert.equal(validateGeneratedOutput('experiment', r.value, PRUNE_SRC), undefined, '修剪后必须通过校验');
  assert.equal(r.demoted.length, 2, '一条降级 + results 清空');
  const obj = JSON.parse(r.value);
  assert.equal(obj.acquisition[0].v, '论文未说明', '无法核验的字段被标为未知');
  assert.equal(obj.results.length, 0, '结果数值移出实验配置');
  assert.equal(obj.dataset[0].v, 'Five datasets are used: chest, jaw, foot, abdomen, aorta.', '可核验的事实原样保留');
});

test('兜底修剪：结果分析按报错删行/删解读后收敛，可核验内容保留', () => {
  const { pruneGenerated, validateGeneratedOutput } = require('../main/ai.js');
  const src = '=== Page 7 ===\nTable 2 reports PSNR and SSIM. NAF 34.45 .95 on abdomen. SART 31.38 .91 on abdomen. ASD 30.10 .88 on abdomen. The method achieves best on all five datasets.';
  const bad = JSON.stringify({
    tables: [{ id: 't2',
      caption: { k: 'cap', v: 'Table 2', page: 7, excerpt: 'Table 2 reports PSNR and SSIM.' },
      header: { k: 'hdr', v: 'PSNR SSIM', page: 7, excerpt: 'Table 2 reports PSNR and SSIM.' },
      protocol: { k: 'proto', v: '论文未说明', page: null, excerpt: null },
      columns: [{ id: 'p', label: 'PSNR', metric: 'PSNR', unit: '论文未说明', context: { k: 'ctx', v: 'PSNR', page: 7, excerpt: 'Table 2 reports PSNR and SSIM.' } }],
      rows: [
        { id: 'naf', method: 'NAF', evidence: { k: 'NAF', v: 'NAF 34.45 .95', page: 7, excerpt: 'NAF 34.45 .95 on abdomen.' }, cells: [{ columnID: 'p', valueText: '34.45' }] },
        { id: 'sart', method: 'SART', evidence: { k: 'SART', v: 'SART 99.99', page: 7, excerpt: 'SART 31.38 .91 on abdomen.' }, cells: [{ columnID: 'p', valueText: '99.99' }] },
        { id: 'asd', method: 'ASD', evidence: { k: 'ASD', v: 'ASD 30.10 .88', page: 7, excerpt: 'ASD 30.10 .88 on abdomen.' }, cells: [{ columnID: 'p', valueText: '30.10' }] },
      ] }],
    stability: [{ evidence: { k: 'st', v: 'best', page: 7, excerpt: 'The method achieves best on all five datasets.' }, interpretation: '五数据集全部最佳', tableID: 't2', visualID: null }],
    ablation: [], generalization: [], efficiency: [], statistics: [], missing: [],
  });
  assert.throws(() => validateGeneratedOutput('results', bad, src));
  const r = pruneGenerated('results', bad, src);
  assert.ok(r, '修剪必须收敛');
  assert.equal(validateGeneratedOutput('results', r.value, src), undefined);
  const obj = JSON.parse(r.value);
  assert.equal(obj.tables[0].rows.length, 2, '编造数字的行被剔除，其余行保留');
  assert.ok(!obj.tables[0].rows.some((x: any) => x.id === 'sart'));
  assert.equal(obj.stability.length, 1, '可核验的解读保留');
});
