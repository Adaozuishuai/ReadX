// 论文↔代码映射的回归（复刻 macOS RepositoryService / CodeModels 语义）。
//
// 重点是「不猜、不越界」：仓库 URL 必须是无凭据的公开地址；行范围与逐字摘录、
// symbol 必须真的在代码里；置信度与页码必须有；密钥类文件绝不读取。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRepository, repoSlug, fileCategory, eligible, selectFiles,
  codeNormalized, decodeCodeMapping, validateCodeMapping, mappingID, fileURL,
  CodeSnapshot, TreeItem, CodeMappingAnalysis,
} from '../core/codeMapping';

test('仓库 URL 解析：标准形式通过，去 .git', () => {
  assert.deepEqual(parseRepository('https://github.com/Ruyi-Zha/naf_cbct'), { owner: 'Ruyi-Zha', name: 'naf_cbct' });
  assert.deepEqual(parseRepository('https://github.com/owner/repo.git'), { owner: 'owner', name: 'repo' });
  assert.equal(repoSlug(parseRepository('https://github.com/a/b')), 'a/b');
});

test('仓库 URL 解析：拒绝凭据、非 https、查询串、多余路径、非法字符', () => {
  for (const bad of [
    'https://user:pass@github.com/a/b',
    'http://github.com/a/b',
    'https://gitlab.com/a/b',
    'https://github.com/a/b?x=1',
    'https://github.com/a/b#frag',
    'https://github.com/a/b/c',
    'https://github.com/a',
    'not a url',
    'https://github.com/../b',
  ]) {
    assert.throws(() => parseRepository(bad), /GitHub|URL/, bad);
  }
});

test('文件分类与 macOS 一致', () => {
  assert.equal(fileCategory('README.md'), 'README / 许可');
  assert.equal(fileCategory('LICENSE'), 'README / 许可');
  assert.equal(fileCategory('requirements.txt'), '环境 / 依赖');
  assert.equal(fileCategory('configs/default.yaml'), '配置');
  assert.equal(fileCategory('data/dataset.py'), 'Dataset / 预处理');
  assert.equal(fileCategory('losses/loss.py'), 'Loss');
  assert.equal(fileCategory('train.py'), '训练入口');
  assert.equal(fileCategory('infer.py'), '推理 / 评测');
  assert.equal(fileCategory('models/network.py'), '模型 / 几何');
});

test('可读文件筛选：排除密钥、依赖目录、二进制、超大文件', () => {
  const item = (path: string, over: Partial<TreeItem> = {}): TreeItem => ({ path, mode: '100644', type: 'blob', sha: 'x', size: 100, ...over });
  assert.equal(eligible(item('src/model.py')), true);
  assert.equal(eligible(item('README.md')), true);
  assert.equal(eligible(item('.env')), false, '密钥文件不得读取');
  assert.equal(eligible(item('config/secret.yaml')), false);
  assert.equal(eligible(item('node_modules/foo.py')), false);
  assert.equal(eligible(item('.git/config')), false);
  assert.equal(eligible(item('image.png')), false, '非文本扩展名');
  assert.equal(eligible(item('huge.py', { size: 200_000 })), false, '超大文件');
  assert.equal(eligible(item('dir/file.py', { type: 'tree' })), false, '只取 blob');
});

test('往返选文件：类别轮流，限制数量，README 优先', () => {
  const items: TreeItem[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ path: `config/c${i}.yaml`, mode: '100644', type: 'blob', sha: 'x', size: 10 })),
    { path: 'models/network.py', mode: '100644', type: 'blob', sha: 'x', size: 10 },
    { path: 'README.md', mode: '100644', type: 'blob', sha: 'x', size: 10 },
  ];
  const picked = selectFiles(items, 6);
  assert.equal(picked.length, 6);
  assert.ok(picked.some((f) => f.path === 'README.md'), 'README 应被选中');
  assert.ok(picked.some((f) => f.path === 'models/network.py'), '模型文件不应被 config 挤掉');
});

test('codeNormalized：忽略缩进、保留运算符与字符串', () => {
  assert.equal(codeNormalized('    x = a + b\n'), 'x = a + b');
  assert.equal(codeNormalized('if (a) { b(); }'), 'if (a) { b(); }');
  assert.equal(codeNormalized('a\r\nb'), 'a\nb');
});

// ---------- 映射校验 ----------

function snapshot(): CodeSnapshot {
  const text = ['import torch', 'def forward(self, x):', '    return self.net(x)'].join('\n');
  return {
    paperKey: 'naf', repository: { owner: 'o', name: 'r' }, commit: 'a'.repeat(40),
    scannedAt: '2026-01-01', paths: ['model.py'], warnings: [],
    files: [{ path: 'model.py', sha: 's', category: '模型 / 几何', text, truncated: false }],
  };
}
const mk = (over: Partial<any> = {}): CodeMappingAnalysis => ({
  mappings: [{
    concept: '前向传播', paper: { k: '方法', v: 'MLP 前向', page: 3, excerpt: 'a' }, path: 'model.py',
    startLine: 2, endLine: 3, codeExcerpt: 'def forward(self, x):\n    return self.net(x)',
    symbol: 'forward', reasoning: '对应网络前向', confidence: 0.8, id: '',
    ...over,
  }],
  missing: [],
});

test('映射校验：合法映射通过', () => {
  assert.doesNotThrow(() => validateCodeMapping(mk(), snapshot()));
});

test('映射校验：行号越界被拒', () => {
  assert.throws(() => validateCodeMapping(mk({ endLine: 99 }), snapshot()), /行号超出范围|不存在/);
});

test('映射校验：摘录不在该行范围内被拒', () => {
  assert.throws(() => validateCodeMapping(mk({ codeExcerpt: 'return self.other(x)' }), snapshot()), /未匹配代码范围/);
});

test('映射校验：symbol 不存在于文件被拒', () => {
  assert.throws(() => validateCodeMapping(mk({ symbol: '不存在的名字' }), snapshot()), /未匹配代码范围/);
});

test('映射校验：symbol 为未知放行', () => {
  assert.doesNotThrow(() => validateCodeMapping(mk({ symbol: '未知' }), snapshot()));
});

test('映射校验：缺页码或置信度越界被拒', () => {
  assert.throws(() => validateCodeMapping(mk({ paper: { k: 'x', v: 'y', page: null } }), snapshot()), /缺少论文依据/);
  assert.throws(() => validateCodeMapping(mk({ confidence: 1.5 }), snapshot()), /缺少论文依据|置信度/);
});

test('映射校验：重复映射被拒', () => {
  const a = mk();
  const dup: CodeMappingAnalysis = { mappings: [...a.mappings, { ...a.mappings[0] }], missing: [] };
  assert.throws(() => validateCodeMapping(dup, snapshot()), /重复映射/);
});

test('decode：从夹带说明的回复里抽出 JSON，缺 mappings 报错', () => {
  const ok = decodeCodeMapping('这是结果：\n{"mappings":[],"missing":[]}\n完');
  assert.deepEqual(ok.mappings, []);
  assert.throws(() => decodeCodeMapping('{"a":1}'), /缺少 mappings/);
});

test('fileURL：固定 commit + 行号，越界路径返回 null', () => {
  const s = snapshot();
  const u = fileURL(s, 'model.py', 3);
  assert.ok(u && u.includes('/blob/' + s.commit + '/model.py#L3'));
  assert.equal(fileURL(s, 'nonexistent.py'), null);
  assert.equal(fileURL(s, '../etc/passwd'), null);
});
