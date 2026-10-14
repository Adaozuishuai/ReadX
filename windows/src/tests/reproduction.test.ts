// 移植保真度回归：ReproductionModels.swift 的断言逐条翻成 TS。
// 任何一条失败都说明移植改变了语义，而不是「测试太严」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';

import { validateExtraction } from '../core/evidence';
import { findRoot } from '../core/store';
import {
  ReproductionAnalysis, ReproductionItem, CodeSnapshot,
  reproductionGroups, reproductionItemTitle, reproductionItemIsUnknown,
  reproductionItemCount, reproductionUnknownCount, fingerprint, decodeReproductionAnalysis,
  validateReproductionAnalysis,
  REPRODUCTION_TASK_STATUS_LABEL, REPRODUCTION_TASK_STATUSES,
  defaultReproductionChecklist, checklistTask, ReproductionChecklist,
  repoAuditChecks, repoCheckID, RepoAudit, DEPENDENCY_FILE_NAMES,
} from '../core/reproduction';

const SOURCE = '=== Page 3 ===\nReported time is 10-40 minutes for one case.\n\n=== Page 4 ===\nWe train using 50 views with fixed geometry.';

function known(): ReproductionItem {
  return {
    finding: { k: 'views', v: '50 views', page: 4, excerpt: 'We train using 50 views' },
    assessment: 'Control the acquisition protocol',
    action: 'Check geometry and views before evaluation',
  };
}

function unknown(over: Partial<ReproductionItem> = {}): ReproductionItem {
  return {
    finding: { k: 'Dependency version', v: '论文未说明', page: null, excerpt: null },
    assessment: 'Version compatibility needs testing',
    action: 'Check supplementary material and pinned dependencies',
    ...over,
  };
}

function fixture(): ReproductionAnalysis {
  return {
    resources: [unknown()],
    environment: [unknown()],
    cost: [unknown()],
    missing: [known()],
    risks: [unknown()],
  };
}

test('ReproductionItem：title = finding.k，isUnknown = page == null', () => {
  assert.equal(reproductionItemTitle(known()), 'views');
  assert.equal(reproductionItemIsUnknown(known()), false);
  assert.equal(reproductionItemIsUnknown(unknown()), true);
  assert.equal(reproductionItemIsUnknown({
    finding: { k: 'k', v: 'v' }, assessment: 'a', action: 'b',
  }), true); // page 省略等价于 nil
});

test('ReproductionAnalysis.groups：五组顺序与中文标题与 Swift 一致', () => {
  const groups = reproductionGroups(fixture());
  assert.deepEqual(groups.map(([key]) => key), ['resources', 'environment', 'cost', 'missing', 'risks']);
  assert.deepEqual(groups.map(([, label]) => label), [
    '资源 · 数据 / 代码 / 权重', '环境 · 依赖 / 特殊算子', '训练成本 · 时间 / 显存',
    '关键缺失 · 几何 / 预处理 / 参数', '风险 · 实现 / 评测协议',
  ]);
});

test('itemCount / unknownCount：未知项仍计入总数与未知数', () => {
  const analysis = fixture();
  assert.equal(reproductionItemCount(analysis), 5);
  assert.equal(reproductionUnknownCount(analysis), 4);
});

test('decode：剥掉 ```json 围栏', () => {
  const raw = JSON.stringify(fixture());
  const parsed = decodeReproductionAnalysis('```json\n' + raw + '\n```');
  assert.equal(reproductionItemCount(parsed), 5);
  assert.equal(parsed.missing[0].finding.v, '50 views');
});

// ---------- fingerprint ----------

function sortedJSON(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => JSON.parse(sortedJSON(v))));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = JSON.parse(sortedJSON((value as Record<string, unknown>)[key]));
    }
    return JSON.stringify(out);
  }
  return JSON.stringify(value);
}

test('fingerprint：同一内容、字段顺序不同 → 指纹相同（必须 sortedKeys）', () => {
  const analysis = fixture();
  const shuffled = JSON.parse(JSON.stringify({
    risks: analysis.risks,
    missing: analysis.missing,
    cost: analysis.cost,
    // 每项内部字段顺序也颠倒
    environment: analysis.environment.map((it) => ({
      action: it.action, assessment: it.assessment,
      finding: { excerpt: it.finding.excerpt, page: it.finding.page, v: it.finding.v, k: it.finding.k },
    })),
    resources: analysis.resources,
  })) as ReproductionAnalysis;
  assert.notDeepEqual(Object.keys(shuffled), Object.keys(analysis)); // 确认顺序确实不同
  assert.equal(fingerprint(shuffled), fingerprint(analysis));
});

test('fingerprint：内容不同 → 指纹不同', () => {
  const analysis = fixture();
  const changed = fixture();
  changed.missing[0] = { ...changed.missing[0], finding: { ...changed.missing[0].finding, v: 'New analysis value' } };
  assert.notEqual(fingerprint(changed), fingerprint(analysis));
  // 只改一个未知项的分析文字也必须换指纹
  const changedNote = fixture();
  changedNote.resources[0] = { ...changedNote.resources[0], assessment: 'Different note' };
  assert.notEqual(fingerprint(changedNote), fingerprint(analysis));
});

test('fingerprint：等于「按键名排序后的 JSON」的 SHA256（与 Swift sortedKeys 编码一致）', () => {
  const analysis = fixture();
  const expected = createHash('sha256').update(sortedJSON(analysis), 'utf8').digest('hex');
  assert.equal(fingerprint(analysis), expected);
  assert.match(fingerprint(analysis), /^[0-9a-f]{64}$/);
});

// ---------- validate ----------

test('validate：合规分析通过，未知项（page=null 但 action 非空）是合法的', () => {
  assert.doesNotThrow(() => validateReproductionAnalysis(fixture(), SOURCE));
});

test('validate：某组 0 项时抛「须有 1–4 项，未知也须给出核对行动」', () => {
  const bad = fixture();
  bad.environment = [];
  assert.throws(() => validateReproductionAnalysis(bad, SOURCE),
    /环境 · 依赖 \/ 特殊算子：须有 1–4 项，未知也须给出核对行动/);
});

test('validate：某组 5 项时抛「须有 1–4 项」', () => {
  const bad = fixture();
  bad.risks = [1, 2, 3, 4, 5].map((i) => unknown({
    finding: { k: `risk-${i}`, v: '论文未说明', page: null, excerpt: null },
  }));
  assert.throws(() => validateReproductionAnalysis(bad, SOURCE), /风险 · 实现 \/ 评测协议：须有 1–4 项/);
});

test('validate：同组字段标题重复时抛「字段标题重复」', () => {
  const bad = fixture();
  bad.cost = [
    unknown({ finding: { k: 'time', v: '论文未说明', page: null, excerpt: null } }),
    unknown({ finding: { k: 'time', v: '论文未说明', page: null, excerpt: null }, assessment: '另一条' }),
  ];
  assert.throws(() => validateReproductionAnalysis(bad, SOURCE), /训练成本 · 时间 \/ 显存：字段标题重复/);
});

test('validate：assessment 或 action 为空白时抛「缺少字段、分析或核对行动」', () => {
  const blankAssessment = fixture();
  blankAssessment.missing = [{ ...known(), assessment: '   ' }];
  assert.throws(() => validateReproductionAnalysis(blankAssessment, SOURCE),
    /views：缺少字段、分析或核对行动/);

  // 关键点：未知项也不许空白 action——「不知道」必须给出核对行动。
  const blankAction = fixture();
  blankAction.resources = [unknown({ action: ' ' })];
  assert.throws(() => validateReproductionAnalysis(blankAction, SOURCE),
    /Dependency version：缺少字段、分析或核对行动/);

  const blankTitle = fixture();
  blankTitle.missing = [{ ...known(), finding: { k: '', v: '50 views', page: 4, excerpt: 'We train using 50 views' } }];
  assert.throws(() => validateReproductionAnalysis(blankTitle, SOURCE), /缺少字段、分析或核对行动/);
});

test('validate：finding 证据不成立时把 validateExtraction 的错误并入问题', () => {
  const bad = fixture();
  bad.missing = [{
    finding: { k: 'views', v: '100 views', page: 4, excerpt: 'We train using 50 views' },
    assessment: 'Control the acquisition protocol',
    action: 'Check geometry',
  }];
  assert.throws(() => validateReproductionAnalysis(bad, SOURCE), /未被所附摘录支持/);
});

test('validate：分析或行动引用了不存在的页码时抛错', () => {
  const bad = fixture();
  bad.risks = [unknown({ action: 'Check Page 999' })];
  assert.throws(() => validateReproductionAnalysis(bad, SOURCE),
    /Dependency version：分析或行动引用了不存在的页码/);
});

test('validate：引用真实存在的页码是允许的', () => {
  const ok = fixture();
  ok.risks = [unknown({ action: 'Check Page 3 geometry notes' })];
  assert.doesNotThrow(() => validateReproductionAnalysis(ok, SOURCE));
});

test('validate：跨页拼接的摘录（页内不存在）必须被拒绝', () => {
  const page = 'method can reconstruct a detailed CT model within 10-40 minutes, which is comparable to iterative methods.';
  const crossPage = 'While most INR approaches take hours for training, our ' + page;
  const analysis: ReproductionAnalysis = {
    resources: [unknown()], environment: [unknown()], cost: [unknown()],
    missing: [known()],
    risks: [{
      finding: { k: 'time', v: '10-40 minutes', page: 3, excerpt: crossPage },
      assessment: 'Reported time only',
      action: 'Profile separately',
    }],
  };
  assert.throws(() => validateReproductionAnalysis(analysis, '=== Page 3 ===\n' + page),
    /缺少对应页的逐字摘录；引用单页不可拼接跨页文字/);
});

test('validate：多个问题合并抛出', () => {
  const bad = fixture();
  bad.environment = [];
  bad.risks = [unknown({ action: 'Check Page 999' })];
  try {
    validateReproductionAnalysis(bad, SOURCE);
    assert.fail('应当抛错');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /须有 1–4 项/);
    assert.match(message, /引用了不存在的页码/);
    assert.match(message, /；/); // 合并分隔符
  }
});

// ---------- 任务状态与 checklist ----------

test('ReproductionTaskStatus 三值与中文 label 与 Swift 一致', () => {
  assert.deepEqual([...REPRODUCTION_TASK_STATUSES], ['todo', 'verified', 'blocked']);
  assert.deepEqual(REPRODUCTION_TASK_STATUS_LABEL, { todo: '待核对', verified: '已核对', blocked: '受阻' });
});

test('ReproductionChecklist：缺省任务为待核对，不同 revision 的核对结果互不影响', () => {
  const checklist: ReproductionChecklist = defaultReproductionChecklist('a');
  // 全新 checklist 没有任务 → 默认
  assert.deepEqual(checklistTask(checklist, 'rev1', 'missing:0'), { status: 'todo', note: '', updatedAt: null });

  checklist.revisions['rev1'] = {
    'missing:0': { status: 'verified', note: '核对过 Page 4', updatedAt: null },
  };

  // 同一个 revision 能读回
  assert.equal(checklistTask(checklist, 'rev1', 'missing:0').status, 'verified');
  assert.equal(checklistTask(checklist, 'rev1', 'missing:0').note, '核对过 Page 4');
  // 同 revision 的其它 item 仍是默认
  assert.equal(checklistTask(checklist, 'rev1', 'missing:9').status, 'todo');

  // 新版分析（不同 fingerprint / revision）不得继承旧核对结果
  assert.equal(checklistTask(checklist, 'rev2', 'missing:0').status, 'todo');
  assert.notEqual(fingerprint(fixture()), fingerprint((() => {
    const changed = fixture();
    changed.missing[0] = { ...changed.missing[0], finding: { ...changed.missing[0].finding, v: 'New analysis value' } };
    return changed;
  })()));
});

// ---------- R-11 RepoAudit ----------

function file(p: string, text: string): { path: string; lines: string[] } {
  return { path: p, lines: text.split('\n') };
}

function snapshot(files: Array<{ path: string; lines: string[] }>): CodeSnapshot {
  return { files };
}

test('RepoAudit：dependencyFileNames 集合与 Swift 一致（大小写不敏感，取最后一段）', () => {
  assert.deepEqual([...DEPENDENCY_FILE_NAMES].sort(), [
    'conda.yaml', 'conda.yml', 'environment.yaml', 'environment.yml',
    'package.json', 'pipfile', 'pipfile.lock', 'pyproject.toml', 'requirements.txt', 'setup.py',
  ].sort());
  const checks = repoAuditChecks(snapshot([
    file('scripts/REQUIREMENTS.TXT', 'torch>=1.12\nnumpy\n'),
    file('deep/nested/Environment.YML', 'name: naf\n'),
  ]));
  assert.equal(checks.filter((c) => c.kind === '依赖').length, 2);
  assert.ok(checks.some((c) => c.kind === '依赖' && c.path === 'scripts/REQUIREMENTS.TXT'));
});

test('RepoAudit：requirements.txt 识别为依赖；普通代码行不误报', () => {
  const checks = repoAuditChecks(snapshot([
    file('requirements.txt', 'torch>=1.12\nnumpy\n'),
    file('train.py', "print('hello')\n"),
  ]));
  assert.deepEqual(checks.map((c) => c.kind), ['依赖']);
  assert.equal(checks[0].detail, '发现依赖声明文件，需与论文环境声明核对并实际安装验证。');
  assert.equal(checks[0].line, null);
});

test('RepoAudit：含 huggingface.co 的行识别为数据；只有 http 但不含提示的行不算', () => {
  const checks = repoAuditChecks(snapshot([
    file('download_data.sh', 'pip install -q https://huggingface.co/datasets/x\n'),
    file('readme.md', 'see https://example.org/paper for details\n'),
  ]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, '数据');
  assert.equal(checks[0].path, 'download_data.sh');
  assert.equal(checks[0].line, 1);
  assert.equal(checks[0].detail, '疑似数据集下载指引：pip install -q https://huggingface.co/datasets/x');
});

test('RepoAudit：含 .pth 的行识别为权重（line 从 1 开始）', () => {
  const checks = repoAuditChecks(snapshot([
    file('download_weights.sh', 'echo start\ncurl -O https://example.org/checkpoints/naf.pth\n'),
  ]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, '权重');
  assert.equal(checks[0].line, 2);
  assert.equal(checks[0].id, '权重|download_weights.sh:2');
});

test('RepoAudit：download + data 组合也算数据，无 http 的行不算', () => {
  const checks = repoAuditChecks(snapshot([
    file('get.sh', 'wget http://mirror.local/download/dataset-v1.zip\n'),
    file('bad.sh', 'gdown 本地复制 ./download/data.zip\n'),
  ]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].kind, '数据');
});

test('RepoAudit：同一行即使同时命中权重与数据提示也只计一次（权重优先）', () => {
  const checks = repoAuditChecks(snapshot([
    file('mix.sh', 'gdown https://drive.google.com/uc?id=abc -O ema.pth\n'),
  ]));
  assert.equal(checks.filter((c) => c.line === 1).length, 1);
  assert.equal(checks[0].kind, '权重');
});

test('RepoAudit：同一 (kind|path|line) 不重复计入', () => {
  // 快照里出现同路径同内容的两份文件：id 相同必须去重。
  const checks = repoAuditChecks(snapshot([
    file('scripts/download.sh', 'gdown https://drive.google.com/uc?id=abc\n'),
    file('scripts/download.sh', 'gdown https://drive.google.com/uc?id=abc\n'),
  ]));
  assert.equal(checks.length, 1);
  assert.equal(new Set(checks.map((c) => c.id)).size, checks.length);
});

test('RepoAudit：detail 截断到 160 字符，超出部分丢弃', () => {
  const long = 'https://huggingface.co/datasets/x?token=' + 'a'.repeat(300);
  const checks = repoAuditChecks(snapshot([file('d.sh', long + '\n')]));
  assert.equal(checks.length, 1);
  const expected = '疑似数据集下载指引：' + long.trim().slice(0, 160);
  assert.equal(checks[0].detail, expected);
  assert.equal(checks[0].detail.length, '疑似数据集下载指引：'.length + 160);
});

test('RepoAudit：行长度 >= 500 不扫描，499 仍然扫描', () => {
  const body = 'https://huggingface.co/x ';
  const line499 = body + 'a'.repeat(499 - body.length);
  const line500 = body + 'a'.repeat(500 - body.length);
  assert.equal(line499.length, 499);
  assert.equal(line500.length, 500);
  const checks = repoAuditChecks(snapshot([
    file('a499.sh', line499 + '\n'),
    file('a500.sh', line500 + '\n'),
  ]));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].path, 'a499.sh');
});

test('RepoAudit：最多 12 条（清单只做提示不做穷举）', () => {
  const noisy = Array.from({ length: 40 }, (_, i) => file(`scripts/d${i}.sh`, `gdown https://drive.google.com/uc?id=${i}\n`));
  const checks = repoAuditChecks(snapshot(noisy));
  assert.equal(checks.length, 12);
  // 确定性：同快照两次扫描结果一致（清单键稳定）
  assert.deepEqual(checks.map((c) => c.id), repoAuditChecks(snapshot(noisy)).map((c) => c.id));
});

test('RepoAudit：依赖文件 + 数据 + 权重的组合顺序稳定', () => {
  const checks = repoAuditChecks(snapshot([
    file('requirements.txt', 'torch>=1.12\n'),
    file('download_data.sh', 'gdown https://drive.google.com/uc?id=abc\ncurl -O https://example.org/checkpoints/naf.pth\n'),
    file('train.py', "print('hello')\n"),
  ]));
  assert.deepEqual(checks.map((c) => [c.kind, c.path, c.line]), [
    ['依赖', 'requirements.txt', null],
    ['数据', 'download_data.sh', 1],
    ['权重', 'download_data.sh', 2],
  ]);
  assert.deepEqual(checks.map(repoCheckID), RepoAudit.checks(snapshot([
    file('requirements.txt', 'torch>=1.12\n'),
    file('download_data.sh', 'gdown https://drive.google.com/uc?id=abc\ncurl -O https://example.org/checkpoints/naf.pth\n'),
    file('train.py', "print('hello')\n"),
  ])).map(repoCheckID));
});

// ---------- 真实 NAF 全文缓存端到端 ----------

const ROOT = findRoot(__dirname);

test('端到端：真实 NAF 页面文字构造的字段通过 evidence 校验，伪造文字失败', () => {
  const textPath = path.join(ROOT, 'library', 'text', '2209.14540-v3.txt');
  // 该缓存由应用运行时生成、且被 .gitignore 排除；全新克隆里不存在，跳过而不是失败。
  if (!fs.existsSync(textPath)) return;
  const source = fs.readFileSync(textPath, 'utf8');

  // 取自 library/text/2209.14540-v3.txt Page 4 的真实句子（跨换行也应按原文核对）。
  const realQuote = 'We sample N points at the parts where rays intersect the cube';
  const field = { k: '采样策略', v: '在射线与立方体相交处采样 N 个点', page: 4, excerpt: realQuote };

  assert.doesNotThrow(() => validateExtraction(
    { dataset: [field], acquisition: [], training: [], loss: [], metrics: [], results: [] }, source,
  ));

  const faked = { ...field, excerpt: 'We sample 99 points at random positions inside the cube' };
  assert.throws(() => validateExtraction(
    { dataset: [faked], acquisition: [], training: [], loss: [], metrics: [], results: [] }, source,
  ), /证据校验未通过/);

  // 真实页面对应的 ReproductionItem 也应通过五组校验
  const analysis: ReproductionAnalysis = {
    resources: [{
      finding: field,
      assessment: '采样密度决定重建质量，需保持 N 大于目标 CT 尺寸 (Page 4)',
      action: '核对代码中 N 的默认值',
    }],
    environment: [unknown()],
    cost: [unknown()],
    missing: [unknown({ finding: { k: 'bin 数量', v: '论文未说明', page: null, excerpt: null } })],
    risks: [unknown()],
  };
  assert.doesNotThrow(() => validateReproductionAnalysis(analysis, source));
});

// ---------- 解码期结构校验（补回 Swift JSONDecoder 的保证）----------
// Swift 的 JSONDecoder 解码非可选数组字段时，缺字段会 keyNotFound 失败；
// JSON.parse 只会得到 undefined，让 validate 崩成 TypeError。
// 这组用例锁住「缺字段必须给出可读错误，而不是 TypeError」。

test('decode：缺组时给出可读错误，而不是 undefined.length 崩溃', () => {
  const { decodeReproductionAnalysis } = require('../core/reproduction') as typeof import('../core/reproduction');
  assert.throws(
    () => decodeReproductionAnalysis('{"resources":[]}'),
    (e: Error) => /缺少必需的组/.test(e.message) && !/Cannot read properties/.test(e.message),
    '缺组必须是可读的校验消息',
  );
});

test('decode：五组齐全时正常解析', () => {
  const { decodeReproductionAnalysis } = require('../core/reproduction') as typeof import('../core/reproduction');
  const ok = decodeReproductionAnalysis(JSON.stringify({
    resources: [], environment: [], cost: [], missing: [], risks: [],
  }));
  assert.deepEqual(ok.risks, []);
});

test('decode：非对象 / 非法 JSON 都给出可读错误', () => {
  const { decodeReproductionAnalysis } = require('../core/reproduction') as typeof import('../core/reproduction');
  assert.throws(() => decodeReproductionAnalysis('[1,2]'), /必须是一个 JSON 对象/);
  assert.throws(() => decodeReproductionAnalysis('not json'), /不是合法 JSON/);
});
