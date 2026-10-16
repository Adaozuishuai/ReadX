import assert from 'node:assert/strict';
import test from 'node:test';

import { collapseInlineWhitespace, isStructuralLine, pageParagraphs, paragraphizePage, reflowPaperText, splitParagraphs } from './text.js';

test('reflow：同段续行合并成一行', () => {
  const input = 'NAF: Neural Attenuation Fields for Sparse-View\nCBCT Reconstruction\n\nAbstract text.';
  assert.equal(reflowPaperText(input), 'NAF: Neural Attenuation Fields for Sparse-View CBCT Reconstruction\n\nAbstract text.');
});

test('reflow：英文断词连字符直接拼接', () => {
  assert.equal(reflowPaperText('attenu-\nation'), 'attenuation');
  // 大写开头说明是新句/新词，不是断词，保留连字符。
  assert.equal(reflowPaperText('sparse-view\nCBCT'), 'sparse-view CBCT');
});

test('reflow：结构性行不参与合并', () => {
  const input = ['# 标题\n正文第一行', '- 列表项一\n- 列表项二', '| a | b |\n| 1 | 2 |', '> 引用\n继续引用', '$$\nE=mc^2\n$$'].join('\n\n');
  const output = reflowPaperText(input);
  assert.match(output, /# 标题\n正文第一行/);
  assert.match(output, /- 列表项一\n- 列表项二/);
  assert.match(output, /\| a \| b \|\n\| 1 \| 2 \|/);
  assert.match(output, /> 引用\n继续引用/);
  assert.match(output, /\$\$\nE=mc\^2\n\$\$/);
});

test('reflow：页标记不被并入正文', () => {
  const output = reflowPaperText('上一页结尾\n=== Page 2 ===\n新页开头');
  assert.equal(output, '上一页结尾\n=== Page 2 ===\n新页开头');
  assert.ok(isStructuralLine('=== Page 2 ==='));
});

test('reflow：行尾空白与制表被吃掉，不留下双空格', () => {
  assert.equal(reflowPaperText('a   \nb'), 'a b');
});

test('splitParagraphs：页标记单独成段并带页号', () => {
  const blocks = splitParagraphs('=== Page 1 ===\n\n第一段\n\n第二段');
  assert.equal(blocks[0]?.kind, 'page');
  assert.equal(blocks[0]?.page, 1);
  assert.equal(blocks[1]?.text, '第一段');
  assert.equal(blocks[2]?.text, '第二段');
});

test('splitParagraphs：页标记与正文同块时也能拆开', () => {
  const blocks = splitParagraphs('=== Page 3 ===\nWe train using 50 views.');
  assert.deepEqual(
    blocks.map((b) => [b.kind, b.page ?? null]),
    [
      ['page', 3],
      ['paragraph', null],
    ],
  );
  assert.equal(blocks[1]?.text, 'We train using 50 views.');
});

test('splitParagraphs：空文本不产生空段', () => {
  assert.deepEqual(splitParagraphs('   \n\n  '), []);
});

test('collapseInlineWhitespace：只压行内空白，不动换行', () => {
  assert.equal(collapseInlineWhitespace('a  b\t\tc\nd  e'), 'a b c\nd e');
});

test('paragraphize：段末短行 + 句末标点 → 开新段', () => {
  const wide = 'x'.repeat(70);
  const page = [
    `${wide.slice(0, 69)}a.`,
    `${wide.slice(0, 69)}b.`,
    'Short closing line of paragraph one.',
    `${wide.slice(0, 69)}c.`,
    `${wide.slice(0, 69)}d.`,
  ].join('\n');
  const paragraphs = paragraphizePage(page).split('\n\n');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[1], `${wide.slice(0, 69)}c. ${wide.slice(0, 69)}d.`);
});

test('paragraphize：填满列宽的行不会误断段', () => {
  const wide = 'y'.repeat(70);
  const page = [`${wide}.`, `${wide}.`, `${wide}.`].join('\n');
  assert.equal(paragraphizePage(page).split('\n\n').length, 1);
});

test('paragraphize：全大写短行按标题另起一段', () => {
  const wide = 'z'.repeat(70);
  const page = [`${wide}.`, 'ABSTRACT', `${wide}.`].join('\n');
  const blocks = paragraphizePage(page).split('\n\n');
  assert.deepEqual(blocks, [`${wide}.`, 'ABSTRACT', `${wide}.`]);
});

test('paragraphize：断词连字符合并，页标记单独成块', () => {
  const page = ['=== Page 1 ===', 'attenu-', 'ation is hard', '', 'Next para.'].join('\n');
  const blocks = paragraphizePage(page).split('\n\n');
  assert.equal(blocks[0], '=== Page 1 ===');
  assert.equal(blocks[1], 'attenuation is hard');
  assert.equal(blocks[2], 'Next para.');
});

test('paragraphize：真实 NAF 第 1 页能分出多段', () => {
  // 结构取自 library/text/2209.14540-v3.txt 第 1 页：整页几乎不含空行，
  // 若沿用旧版 reflow 会得到一整块墙字；这里要求至少把编号小节切出来。
  const lines = [
    '=== Page 1 ===',
    'NAF: Neural Attenuation Fields for Sparse-View',
    'CBCT Reconstruction',
    'Ruyi Zha , Yanhao Zhang, and Hongdong Li',
    'Australian National University, Canberra, Australia',
    'Abstract. This paper proposes a novel and fast self-supervised solu-',
    'tion for sparse-view CBCT reconstruction (Cone Beam Computed To-',
    'mography) that requires no external training data. Specifically, the de-',
    'sired attenuation coefficients are represented as a continuous function',
    'of 3D spatial coordinates, parameterized by a fully-connected deep neu-',
    'ral network. Code available at https://github.com/Ruyi-Zha/naf_cbct .',
    'Keywords: CBCT · Sparse View · Implicit Neural Representation',
    '1 Introduction Cone Beam Computed Tomography (CBCT) is an emerg-',
    'ing medical imaging technique to examine the internal structure of a',
    'subject noninvasively. Compared with the conventional Fan Beam CT',
    '(FBCT), CBCT enjoys the benefits of high spatial resolution and fast',
    'scanning speed [19].',
  ];
  const page = lines.join('\n');
  assert.ok(reflowPaperText(page).split('\n\n').length <= 1, '旧版 reflow 应仍是整块（parity 基线）');

  const paragraphs = paragraphizePage(page).split('\n\n').filter((block) => block.trim());
  assert.ok(paragraphs.length >= 2, `应至少分出 2 段，实际 ${paragraphs.length}`);
  const introduction = paragraphs.find((block) => block.startsWith('1 Introduction'));
  assert.ok(introduction, '编号小节标题应自成新段（PDF 常把它并进上一段末尾）');
  assert.ok(!paragraphs.some((block) => block.includes('Representation 1 Introduction')), '标题不得留在上一段里');
  // 已知局限：段末行若被 URL 填满列宽，「短行 + 句末标点」判据失效，Keywords 仍会挂在上一段。
  // 这也是 S5 段落翻译要按「行宽 + 标点」双判据继续打磨的原因。
});

test('pageParagraphs：剔除页标记与空段，供译文对照按序对齐', () => {
  const page = '=== Page 1 ===\nFirst body paragraph here.\nSecond paragraph follows.\n\nThird block after gap.';
  const paragraphs = pageParagraphs(page);
  // 页标记不是段落：译文对照里它不该占位，否则索引会整体错开一位。
  assert.ok(!paragraphs.some((block) => block.includes('=== Page')), '页标记不应出现在段落列表里');
  assert.equal(paragraphs[0], 'First body paragraph here. Second paragraph follows.');
  assert.ok(paragraphs.length >= 2);
  assert.deepEqual(pageParagraphs('=== Page 1 ===\n'), []);
});
