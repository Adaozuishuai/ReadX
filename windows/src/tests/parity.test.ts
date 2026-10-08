// 移植保真度回归：把 Swift 版 native/Tests/CBCTReadingTests/ 的断言逐条翻成 TS。
// 任何一条失败都说明移植改变了语义，而不是「测试太严」。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { parseMarkdown, MDBlock, isHorizontalRule, inlineHTML } from '../core/markdown';
import { MarkdownTable, parseTable, splitRow, isDelimiterRow, plainText } from '../core/markdownTable';
import { Typography } from '../core/typography';
import {
  pages, citations, normalized, numbers, selectWithMeta, scopingNote,
  validateEvidence, validateExtraction, matchingQuoteFragment,
} from '../core/evidence';
import {
  arxivKey, doiKey, deduplicate, decodeQueue, rank, sameEntry, mergedFirstSeen,
} from '../core/paper';
import { defaultProfile, defaultLibraryState, QueueEntry } from '../core/types';
import { findRoot, Paths } from '../core/store';

// 用与运行时相同的方式定位工作区根：从本文件向上找 queue.json。
// 这样测试验证的就是真实的路径解析逻辑，而不是硬编码的相对层数。
const ROOT = findRoot(__dirname);

function blockKinds(src: string): string[] {
  return parseMarkdown(src).map((b: MDBlock) => {
    switch (b.kind) {
      case 'heading': return `h${b.level}:${b.text}`;
      case 'paragraph': return 'p:' + b.lines.join(' ');
      case 'quote': return 'q:' + b.lines.join(' ');
      case 'bullets': return 'ul:' + b.items.join('|');
      case 'ordered': return 'ol:' + b.items.join('|');
      case 'table': return `table:${b.table.header.length}x${b.table.rows.length}`;
      case 'rule': return 'rule';
      case 'mathBlock': return 'math:' + b.latex;
    }
  });
}

function firstTable(src: string): MarkdownTable {
  const b = parseMarkdown(src).find((x) => x.kind === 'table');
  assert.ok(b && b.kind === 'table', '未解析为表格');
  return (b as { kind: 'table'; table: MarkdownTable }).table;
}

// ---------- Markdown 表格 ----------

test('GFM 表格被解析为 table 块，而不是字面竖线段落', () => {
  const t = firstTable('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  assert.deepEqual(blockKinds('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |'), ['table:2x2']);
  assert.deepEqual(t.header, ['A', 'B']);
  assert.deepEqual(t.rows, [['1', '2'], ['3', '4']]);
  assert.deepEqual(t.alignments, ['leading', 'leading']);
});

test('真实产物：NAF 几何表完整解析且数值逐字保留', () => {
  const artifact = path.join(ROOT, 'native/acceptance/2026-10-02/verified-v3/NAF-chat-geometry.md');
  if (!fs.existsSync(artifact)) return; // 产物缺失则跳过（与 Swift 版一致）
  const src = fs.readFileSync(artifact, 'utf8');
  const tables = parseMarkdown(src)
    .filter((b) => b.kind === 'table')
    .map((b) => (b as { kind: 'table'; table: MarkdownTable }).table);
  const table = tables.find((t) => t.header.length === 6);
  assert.ok(table, '未找到 6 列表格');
  assert.equal(table!.header[0], 'Dataset');
  assert.equal(table!.rows.length, 5);
  const aorta = table!.rows.find((r) => r[0] === 'Aorta');
  assert.deepEqual(aorta, ['Aorta', '512×512×510', 'GE C-arm', '−103°~93°', '50 (582)', '500×500']);
  for (const r of table!.rows) assert.equal(r.length, table!.header.length);
});

test('对齐由分隔行决定', () => {
  const t = firstTable('| L | C | R |\n|:---|:---:|---:|\n| a | b | c |');
  assert.deepEqual(t.alignments, ['leading', 'center', 'trailing']);
});

test('没有分隔行就不是表格（不把含竖线的普通句子误判）', () => {
  assert.deepEqual(blockKinds('a | b | c'), ['p:a | b | c']);
  assert.deepEqual(blockKinds('| just | a | row |'), ['p:| just | a | row |']);
  assert.deepEqual(blockKinds('| A | B |\n|---|---|'), ['p:| A | B |', 'p:|---|---|']);
});

test('数据行列数不齐：多的丢弃、少的补空，列数永远等于表头', () => {
  const t = firstTable('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |');
  assert.equal(t.header.length, 3);
  assert.deepEqual(t.rows[0], ['1', '2', '']);
  assert.deepEqual(t.rows[1], ['1', '2', '3']);
  for (const r of t.rows) assert.equal(r.length, 3);
});

test('转义管道符留在单元格内', () => {
  const t = firstTable('| A | B |\n|---|---|\n| x \\| y | z |');
  assert.equal(t.rows[0][0], 'x | y');
  assert.equal(t.rows[0][1], 'z');
});

test('表格前后的普通段落保持独立，不被并进表格', () => {
  assert.deepEqual(
    blockKinds('前置说明\n| A | B |\n|---|---|\n| 1 | 2 |\n后置说明'),
    ['p:前置说明', 'table:2x1', 'p:后置说明'],
  );
});

test('水平分隔线不显示为字面量，且不吃掉表格分隔行', () => {
  assert.deepEqual(blockKinds('---'), ['rule']);
  assert.deepEqual(blockKinds('***'), ['rule']);
  assert.deepEqual(blockKinds('___'), ['rule']);
  assert.deepEqual(blockKinds('a\n\n---\n\nb'), ['p:a', 'rule', 'p:b']);
  assert.deepEqual(blockKinds('| A |\n|---|\n| 1 |'), ['table:1x1']);
  assert.deepEqual(blockKinds('----'), ['rule']);
});

test('表格纯文本回退保留列对齐与全部数值', () => {
  const t = firstTable('| Metric | Value |\n|---|---:|\n| PSNR | 34.45 |\n| SSIM | .958 |');
  const text = plainText(t);
  assert.ok(text.includes('Metric'));
  assert.ok(text.includes('34.45'));
  assert.ok(text.includes('.958'));
  for (const line of text.split('\n')) assert.ok(line.startsWith('|'), '回退文本行缺少起始竖线：' + line);
  assert.equal(text.split('\n').length, 4);
});

test('列宽计算不得溢出或小于下限', () => {
  assert.deepEqual(Typography.columnWidths(6, 300), [Typography.minColumnWidth, Typography.minColumnWidth, Typography.minColumnWidth, Typography.minColumnWidth, Typography.minColumnWidth, Typography.minColumnWidth]);
  for (const w of Typography.columnWidths(2, 4000)) assert.equal(w, Typography.maxColumnWidth);
  assert.deepEqual(Typography.columnWidths(0, 500), []);
});

// ---------- Markdown 其它块 ----------

test('小数不会被误判成有序列表（0.5 mm 不得变成 "5 mm"）', () => {
  const kinds = blockKinds('0.5 mm 的探测器像素');
  assert.deepEqual(kinds, ['p:0.5 mm 的探测器像素']);
  // 真正的有序列表仍然识别
  assert.deepEqual(blockKinds('1. 第一步\n2. 第二步'), ['ol:第一步|第二步']);
});

test('行内代码与粗斜体转义为 HTML 且不引入原始 HTML', () => {
  assert.equal(inlineHTML('**a**'), '<strong>a</strong>');
  assert.equal(inlineHTML('`x`'), '<code>x</code>');
  assert.ok(!inlineHTML('<script>alert(1)</script>').includes('<script>'));
});

// ---------- Evidence 校验链 ----------

const SOURCE = [
  '=== Page 1 ===',
  'Abstract. We propose NAF for sparse-view CBCT with 50 views on a GE C-arm.',
  '=== Page 2 ===',
  'Method. The network uses a hash grid. PSNR reaches 34.45 dB and SSIM 0.958.',
  '=== Page 4 ===',
  'Ablation. Removing the hash grid drops PSNR to 31.38 dB.',
  '=== Page 11 ===',
  'References [1] Smith et al.',
].join('\n');

test('页码解析与引用抽取', () => {
  assert.deepEqual(pages(SOURCE).map((p) => p.number), [1, 2, 4, 11]);
  assert.deepEqual(citations('see Page 2 and page 4, also Page 2'), [2, 4]);
});

test('validateEvidence 拒绝无页码与不存在的页码', () => {
  assert.throws(() => validateEvidence('没有引用', SOURCE));
  assert.throws(() => validateEvidence('见 Page 99', SOURCE));
  validateEvidence('见 Page 2', SOURCE); // 有效页码不抛
});

test('selectWithMeta 保留页码，且超限时披露材料为子集', () => {
  const r = selectWithMeta(SOURCE, 'PSNR', '全文', 120);
  assert.ok(r.included <= r.total);
  const note = scopingNote(r);
  if (r.included < r.total) {
    assert.ok(note.startsWith('【材料范围】'), '子集必须披露范围');
    assert.ok(note.includes('不得仅凭本子集断言'));
  }
  // 全域且未超限时原样返回，不加披露
  const full = selectWithMeta(SOURCE, 'PSNR', '全文', 1_000_000);
  assert.equal(full.text, SOURCE);
  assert.equal(scopingNote(full), SOURCE);
});

test('scope 不静默包含其它章节，References 一律排除', () => {
  // 与 Swift testScopeDoesNotSilentlyIncludeOtherSections 同一份文本：
  // 章节必须由 major heading 打开/关闭，否则 active 会一直延续。
  const text = [
    '=== Page 1 ===', '1 Introduction', 'Background',
    '=== Page 2 ===', '2 Method', 'Hash encoder',
    '=== Page 3 ===', '3 Experiments', '50 projections', '4 Conclusion', 'Summary',
  ].join('\n');
  const method = selectWithMeta(text, 'views', 'Method');
  assert.ok(method.text.includes('Hash encoder'), 'Method 应包含方法段落');
  assert.ok(!method.text.includes('50 projections'), 'Method 不得吸入实验段落');
  assert.ok(selectWithMeta(text, 'views', 'Experiment').text.includes('50 projections'));
  assert.equal(selectWithMeta(text, 'appendix', 'Appendix').text, '');
});

test('References 对任何 scope 都强制关闭，不吸进证据范围', () => {
  const text = [
    '=== Page 1 ===', '2 Method', 'Hash encoder',
    '=== Page 2 ===', 'References', '[1] Smith et al. method and experiments',
  ].join('\n');
  const method = selectWithMeta(text, 'method', 'Method');
  assert.ok(method.text.includes('Hash encoder'));
  assert.ok(!method.text.includes('Smith'), 'References 必须被排除，即使正文含 method 字样');
});

test('normalized 处理断词连字符、全角与 Unicode 负号', () => {
  assert.equal(normalized('Hash-\ngrid'), normalized('hashgrid'));
  assert.equal(normalized('−103'), normalized('-103'));
  assert.equal(normalized('Ａ　Ｂ'), normalized('ab'));
});

test('numbers 排除单词中间的用途（IntraTomo3D 的 3），保留型号数字', () => {
  assert.ok(!numbers('IntraTomo3D').has('3'), '方法名中间的 3 不得被当作测量值');
  assert.ok(numbers('NVIDIA RTX3090').has('3090'), '贴在单词后面的型号数字必须保留');
  assert.ok(numbers('1.2GB').has('1.2'));
  assert.ok(numbers('a single RTX').has('1'), '英文数量词要归一成数字');
});

test('matchingQuoteFragment 给出该页内的可修复片段（诊断用，不使无效摘录变有效）', () => {
  const frag = matchingQuoteFragment('the network uses a hash grid', SOURCE);
  assert.ok(frag && frag.includes('hash grid'), '应返回本页内真实存在的片段');
  // 跨页拼接：只取本页片段，不得把下一页的 PSNR 也拼进来
  const crossPage = matchingQuoteFragment('hash grid PSNR reaches 34.45', '=== Page 2 ===\nThe network uses a hash grid.');
  assert.ok(crossPage === null || !crossPage.includes('34.45'), '不得把未在本页出现的数字带进修复片段');
});

test('实验抽取拒绝伪造摘录与页码', () => {
  const good = {
    dataset: [{ k: '数据集', v: '50 views', page: 1, excerpt: 'sparse-view CBCT with 50 views' }],
    acquisition: [], training: [], loss: [], metrics: [],
    results: [
      { k: 'PSNR', v: '34.45', page: 2, excerpt: 'PSNR reaches 34.45 dB' },
      { k: 'SSIM', v: '0.958', page: 2, excerpt: 'SSIM 0.958' },
    ],
  };
  validateExtraction(good, SOURCE);

  // 页码不存在
  assert.throws(() => validateExtraction({
    ...good,
    results: [{ k: 'PSNR', v: '34.45', page: 99, excerpt: 'PSNR reaches 34.45 dB' }],
  }, SOURCE));
  // 摘录不在该页
  assert.throws(() => validateExtraction({
    ...good,
    results: [{ k: 'PSNR', v: '34.45', page: 1, excerpt: 'PSNR reaches 34.45 dB' }],
  }, SOURCE));
  // 数字不被摘录支持（伪造值）
  assert.throws(() => validateExtraction({
    ...good,
    results: [{ k: 'PSNR', v: '99.9', page: 2, excerpt: 'PSNR reaches 34.45 dB' }],
  }, SOURCE));
  // 未知值不要求证据
  validateExtraction({ ...good, loss: [{ k: '损失函数', v: '论文未说明' }] }, SOURCE);
});

// ---------- 论文身份与排序 ----------

test('兼容 { papers: [...] } 与旧数组两种队列格式', () => {
  const arr = decodeQueue([{ arxiv: '2209.14540v2', title: 'A'.repeat(30) }]);
  const env = decodeQueue({ papers: [{ arxiv: '2209.14540v2', title: 'A'.repeat(30) }] });
  assert.equal(arr.length, 1);
  assert.equal(env.length, 1);
  assert.equal(arr[0].arxiv, '2209.14540', '必须剥掉版本号');
});

test('DOI 跨来源去重且保留手工元数据', () => {
  const out = deduplicate([
    { arxiv: '2209.14540', title: 'NAF', why: '手工理由', doi: 'https://doi.org/10.1/x' },
    { id: 'pubmed-1', title: 'NAF', abstract: '来自 PubMed', doi: '10.1/x' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].why, '手工理由', '手工字段不得被覆盖');
  assert.equal(out[0].abstract, '来自 PubMed', '缺失字段应被补齐');
});

test('标题相同但作者无交集不得去重（与 Swift testTitleAuthorDedupAvoidsUnrelatedAuthors 同fixture）', () => {
  const a: QueueEntry = { id: 'a', title: 'Sparse-view CBCT reconstruction using neural fields', authors: ['Alice Zhang'] };
  const b: QueueEntry = { id: 'b', title: 'Sparse view CBCT Reconstruction using Neural Fields!', authors: ['Alice Zhang', 'Bob'] };
  const c: QueueEntry = { id: 'c', title: a.title!, authors: ['Other Person'] };
  assert.equal(deduplicate([a, b, c]).length, 2, 'a 与 b 应合并、c 因作者无交集必须保留');
});

test('arxiv key 剥离内部空白与版本号', () => {
  assert.equal(arxivKey('  2209.14540 v3 '), '2209.14540');
  assert.equal(arxivKey('https://arxiv.org/pdf/2209.14540v1.pdf'), '2209.14540');
  assert.equal(doiKey('https://doi.org/10.1/X'), '10.1/x');
});

test('画像与负反馈改变排序，高权重主题优先', () => {
  const profile = defaultProfile();
  const state = defaultLibraryState();
  const base: QueueEntry = { arxiv: '1', title: 'Sparse-view CBCT reconstruction', abstract: 'sparse-view low-dose' };
  const plain = rank(base, profile, state);
  const negative = rank(base, profile, state, { 'Sparse-view': 3 });
  assert.ok(plain.score > negative.score, '负反馈必须降低分数');
  assert.ok(plain.score <= 100 && plain.score >= 0);
  assert.ok(plain.reasons.length <= 3, '理由最多 3 条');
});

test('首见日期合并：已有记录保持不变，新论文记为当天', () => {
  const papers: QueueEntry[] = [{ arxiv: '2209.14540' }, { arxiv: '2312.15676' }];
  const out = mergedFirstSeen({ '2209.14540': '2026-01-01' }, papers, '2026-10-03');
  assert.equal(out['2209.14540'], '2026-01-01');
  assert.equal(out['2312.15676'], '2026-10-03');
});

// ---------- 路径与真实数据 ----------

test('根目录与本地数据可解析，且与 macOS 版读到同一份 queue.json', () => {
  const paths = new Paths(ROOT);
  assert.ok(fs.existsSync(paths.queuePath), `未找到 queue.json：${paths.queuePath}`);
  const raw = JSON.parse(fs.readFileSync(paths.queuePath, 'utf8'));
  const queue = decodeQueue(raw);
  assert.ok(queue.length > 0, '队列不应为空');
});

test('真实 NAF 全文缓存可被 evidence 层读取并定位页码', () => {
  const paths = new Paths(ROOT);
  const text = fs.existsSync(paths.pdfTextPath('2209.14540'))
    ? fs.readFileSync(paths.pdfTextPath('2209.14540'), 'utf8') : null;
  if (!text) return; // 缓存缺失则跳过
  const p = pages(text);
  assert.ok(p.length >= 10, 'NAF 应有 10 页以上');
  assert.ok(p.some((x) => x.text.includes('NAF') || x.text.includes('Attenuation')));
});

// ---------- 证据链接渲染安全 ----------

test('证据页码链接化不破坏标签结构（不得在 HTML 属性里做替换）', () => {
  const { inlineHTMLWithEvidence } = require('../core/markdown') as typeof import('../core/markdown');

  const html = inlineHTMLWithEvidence('结论见 Page 7，参见 Page 12。');
  assert.ok(html.includes('<a class="ev" data-page="7">Page 7</a>'));
  assert.ok(html.includes('data-page="12"'));

  // 文本里带尖括号/引号时，必须先转义再插链接：结果不能出现裸标签
  const risky = inlineHTMLWithEvidence('<img src=x onerror=alert(1)> Page 3');
  assert.ok(!risky.includes('<img'), '原始 HTML 必须被转义');
  assert.ok(risky.includes('&lt;img'), '尖括号应转义为实体');
  // 页面编号只出现在 data-page 属性里，且每个链接结构完整
  const anchors = risky.match(/<a /g)?.length ?? 0;
  assert.equal(anchors, 1);
  assert.equal((risky.match(/<\/a>/g) ?? []).length, 1);
});

test('用户输入不产生嵌套或破损的 <a> 标签', () => {
  const { inlineHTMLWithEvidence } = require('../core/markdown') as typeof import('../core/markdown');
  // 引号会被转义成实体，因此这里不存在属性上下文；
  // 要保证的是「不出现嵌套 <a>、每段结构闭合」，而不是「不识别 URL 里的 Page N」。
  const cases = ['href="http://x/Page 7" Page 9', '<a href="Page 1">x</a>', 'Page 3 <b>Page 4</b>'];
  for (const src of cases) {
    const out = inlineHTMLWithEvidence(src);
    assert.ok(!/<a[^>]*<a/.test(out), `出现嵌套 <a>：${out}`);
    assert.ok(!/<b>|<\/b>|<a href=/.test(out), `原始标签未被转义：${out}`);
    const open = (out.match(/<a /g) ?? []).length;
    const close = (out.match(/<\/a>/g) ?? []).length;
    assert.equal(open, close, `标签不闭合：${out}`);
  }
});

test('页码锚点只认「整行就是 Page N」的标题', () => {
  const { pageAnchorNumber } = require('../core/markdown') as typeof import('../core/markdown');
  assert.equal(pageAnchorNumber('Page 1'), '1');
  assert.equal(pageAnchorNumber('  Page 12  '), '12');
  // 正文里提到 Page N 的句子不能变成锚点
  assert.equal(pageAnchorNumber('见 Page 3 的说明'), null);
  assert.equal(pageAnchorNumber('Page'), null);
  assert.equal(pageAnchorNumber('Pages 3-5'), null);
  assert.equal(pageAnchorNumber(''), null);
});

test('实验配置章不得混入结果数值（validateConfiguration）', () => {
  const { validateConfiguration } = require('../core/evidence') as typeof import('../core/evidence');
  const base = { dataset: [], acquisition: [], metrics: [], results: [] };
  // 合规：results 为空、无训练时长/公式字段
  validateConfiguration({ ...base, training: [{ k: '训练时长', v: '论文未说明' }], loss: [{ k: '损失类型', v: 'L2' }] });
  // results 混入结果数值 -> 拒绝
  assert.throws(() => validateConfiguration({ ...base, training: [], loss: [], results: [{ k: 'PSNR', v: '34.45' }] }), /不能混入结果数值/);
  // 只报告重建耗时的原文不得标为训练时长
  assert.throws(() => validateConfiguration({
    ...base, loss: [],
    training: [{ k: '训练时长', v: '10 分钟', excerpt: 'reconstruction takes 10 minutes' }],
  }), /只报告重建耗时/);
  // 确实提到训练耗时则放行
  validateConfiguration({
    ...base, loss: [],
    training: [{ k: '训练时长', v: '2 小时', excerpt: 'training takes 2 hours to optimize' }],
  });
  // 公式类字段应在方法章节，不应出现在配置章
  assert.throws(() => validateConfiguration({ ...base, training: [], loss: [{ k: '公式 (3)', v: 'x' }] }), /应在方法对应模块/);
});
