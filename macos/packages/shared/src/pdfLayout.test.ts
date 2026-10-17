import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPDFLayout, fitPDFWidth, paragraphAt } from './pdfLayout.js';
import { typesetPDFTranslation } from './pdfTypesetting.js';

test('two columns and table cells retain separate geometry despite interleaved PDF text', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'Left paragraph first line', x: 40, y: 100, width: 230, height: 10 },
    { text: 'Right paragraph first line', x: 330, y: 100, width: 230, height: 10 },
    { text: 'Left paragraph second line', x: 40, y: 113, width: 230, height: 10 },
    { text: 'Right paragraph second line', x: 330, y: 113, width: 230, height: 10 },
    { text: 'Method', x: 40, y: 200, width: 35, height: 10 },
    { text: 'Score', x: 150, y: 200, width: 30, height: 10 },
    { text: '123.4', x: 150, y: 213, width: 30, height: 10 },
  ]);
  assert.equal(layout.blocks.length, 4);
  // 阅读顺序按栏推进：左栏正文、左栏表格单元，最后才是右栏，而不是 PDF 文本层的交错顺序。
  assert.match(layout.blocks[0]!.text, /Left.*Left/);
  assert.equal(layout.blocks[1]!.text, 'Method');
  assert.equal(layout.blocks[2]!.text, 'Score');
  assert.match(layout.blocks[3]!.text, /Right.*Right/);
  assert.equal(layout.blocks[0]!.height, 23);
  assert.ok(layout.blocks.every((block) => !(block.text.includes('Left') && block.text.includes('Right'))));
});

test('fractional resize measurements settle on an integer fit width', () => {
  assert.equal(fitPDFWidth(600.3), fitPDFWidth(600.8));
  assert.equal(fitPDFWidth(32), 1);
});

test('centered wrapped titles combine; standalone equations stay on the PDF canvas', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'A long centered title about reconstruction', x: 100, y: 50, width: 400, height: 16 },
    { text: 'from sparse views', x: 200, y: 70, width: 200, height: 16 },
    { text: 'f(x) = sin(x) + cos(x)', x: 200, y: 120, width: 200, height: 12 },
  ]);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0]!.x, 100);
  assert.equal(layout.blocks[0]!.height, 36);
  assert.match(layout.blocks[0]!.text, /reconstruction from sparse views/);
});

test('narrow journal column gutters never join left and right prose', () => {
  const items = [0, 1, 2, 3].flatMap((row) => [
    { text: `Left column line ${row}`, x: 47, y: 180 + row * 12, width: 252, height: 10 },
    { text: `Right column line ${row}`, x: 313, y: 181 + row * 12, width: 252, height: 11 },
  ]);
  const layout = buildPDFLayout(612, 792, items);
  assert(layout.blocks.every((block) => block.width < 300));
  assert(layout.blocks.every((block) => !(block.text.includes('Left') && block.text.includes('Right'))));
});

test('paragraph hit testing stays inside the correct column and ignores page whitespace', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'Left paragraph', x: 40, y: 100, width: 220, height: 30 },
    { text: 'Right paragraph', x: 330, y: 100, width: 220, height: 30 },
  ]);
  assert.equal(paragraphAt(layout, 100 / 600, 115 / 800), 0);
  assert.equal(paragraphAt(layout, 400 / 600, 115 / 800), 1);
  assert.equal(paragraphAt(layout, 300 / 600, 115 / 800), null);
  assert.equal(paragraphAt(layout, 100 / 600, 300 / 800), null);
});

test('translation typesetting joins an indented opening line without changing source/cache segments', () => {
  const source = { width: 600, height: 800, blocks: [
    { text: 'An indented opening line continues', x: 56, y: 100, width: 214, height: 10, fontSize: 10 },
    { text: 'in the rest of the same source paragraph.'.repeat(4), x: 40, y: 113, width: 230, height: 50, fontSize: 10 },
    { text: 'Right column remains separate.', x: 330, y: 100, width: 230, height: 50, fontSize: 10 },
    { text: 'A new indented paragraph.', x: 56, y: 178, width: 214, height: 10, fontSize: 10 },
  ] };
  const before = structuredClone(source);
  const result = typesetPDFTranslation(source, ['首行译文', '后续译文', '右栏译文', '下一段译文']);
  assert.deepEqual(source, before);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0]!.sourceIndexes, [0, 1]);
  assert.equal(result[0]!.target, '首行译文后续译文');
  assert.equal(result[0]!.indent, 16);
  assert.equal(result[0]!.height, 63);
  assert.equal(result[0]!.width, 230);
  assert.equal(result[1]!.x, 330);
  assert.equal(result[2]!.y, 178);
});

test('translation typography distinguishes centered titles, section headings and captions', () => {
  const layout = { width: 600, height: 800, blocks: [
    { text: 'A centered paper title', x: 100, y: 50, width: 400, height: 40, fontSize: 18 },
    { text: '2.1 Reconstruction method', x: 40, y: 160, width: 200, height: 12, fontSize: 11 },
    { text: 'Ordinary scientific prose paragraph. '.repeat(10), x: 40, y: 180, width: 230, height: 100, fontSize: 10 },
    { text: 'Fig. 1. Original caption describing the figure.', x: 40, y: 500, width: 230, height: 30, fontSize: 9 },
  ] };
  const result = typesetPDFTranslation(layout, ['论文标题', '重建方法', '译文正文', '图注']);
  assert.equal(result[0]!.role, 'title');
  assert.equal(result[0]!.align, 'center');
  assert.equal(result[1]!.role, 'heading');
  assert.equal(result[2]!.role, 'body');
  assert.equal(result[2]!.align, 'justify');
  assert(result[2]!.lineHeight >= 1.4);
  assert.equal(result[3]!.role, 'caption');
  assert.equal(result[3]!.y, 500, 'caption must stay below the original figure');
});

test('translation grouping keeps completed sentences and table cells separate', () => {
  const layout = { width: 600, height: 800, blocks: [
    { text: 'A complete standalone paragraph.', x: 56, y: 100, width: 214, height: 10, fontSize: 10 },
    { text: 'Another full paragraph', x: 40, y: 113, width: 230, height: 10, fontSize: 10 },
    { text: 'Method', x: 40, y: 300, width: 40, height: 10, fontSize: 10 },
    { text: 'Score', x: 170, y: 300, width: 35, height: 10, fontSize: 10 },
  ] };
  const result = typesetPDFTranslation(layout, ['独立段落', '下一段', '方法', '评分']);
  assert.equal(result.length, layout.blocks.length);
  assert(result.every(block => block.sourceIndexes.length === 1));
  assert.equal(result[2]!.role, 'label');
});

test('translation font uses the PDF em size while retaining source segmentation and glyph masks', () => {
  const items = [0, 1, 2].map(row => ({text: 'Scientific source prose '.repeat(3), x: 40, y: 100 + row * 16, width: 230, height: 14}));
  const legacy = buildPDFLayout(600, 800, items);
  const measured = buildPDFLayout(600, 800, items.map(item => ({...item, textFontSize: 10})));
  assert.deepEqual(measured.blocks.map(block => block.text), legacy.blocks.map(block => block.text), 'font measurement must not invalidate cached translations');
  assert.deepEqual(measured.blocks.map(block => [block.x,block.y,block.width,block.height]), legacy.blocks.map(block => [block.x,block.y,block.width,block.height]));
  const translated = typesetPDFTranslation(measured, ['中文段落']);
  assert.equal(translated[0]!.fontSize, 9.8);
  assert.equal(translated[0]!.textFontSize, 10);
});

test('段落末行（短行）并入上一段，不再被切成独立段落', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'Sparse-view CBCT reconstruction remains an ill-posed inverse problem that', x: 47, y: 180, width: 252, height: 10 },
    { text: 'needs strong priors; we introduce a learned attenuation field', x: 47, y: 192, width: 252, height: 10 },
    { text: 'trained without external data.', x: 47, y: 204, width: 120, height: 10 },
  ]);
  assert.equal(layout.blocks.length, 1, '末行短不代表另起一段');
  assert.match(layout.blocks[0]!.text, /trained without external data\.$/);
});

test('首行缩进的段首与齐左续行合并成同一段', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'The proposed method represents attenuation with a coordinate', x: 63, y: 100, width: 236, height: 10 },
    { text: 'network trained without external data.', x: 47, y: 112, width: 200, height: 10 },
  ]);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0]!.x, 47);
  assert.equal(layout.blocks[0]!.text, 'The proposed method represents attenuation with a coordinate network trained without external data.');
});

test('换字号、换行距的短行（图注/脚注）不会被并入正文', () => {
  const tightButSmaller = buildPDFLayout(600, 800, [
    { text: 'A full body line that spans the whole column width here', x: 40, y: 100, width: 250, height: 10 },
    { text: 'Fig. 1. Reconstruction pipeline overview.', x: 40, y: 112, width: 180, height: 9 },
  ]);
  assert.equal(tightButSmaller.blocks.length, 2, '字号变小即为图注，不并入正文');

  const looser = buildPDFLayout(600, 800, [
    { text: 'A full body line that spans the whole column width here', x: 40, y: 100, width: 250, height: 10 },
    { text: 'Footnote text set apart from the paragraph above.', x: 40, y: 132, width: 200, height: 10 },
  ]);
  assert.equal(looser.blocks.length, 2, '行距变大即段落已闭合');
});

test('双栏页面按「左栏读完再读右栏」输出段落顺序', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'Left one line one continues here', x: 40, y: 100, width: 230, height: 10 },
    { text: 'left one line two.', x: 40, y: 112, width: 120, height: 10 },
    { text: 'Left two starts after a gap.', x: 40, y: 140, width: 230, height: 10 },
    { text: 'Right one line one continues here', x: 330, y: 100, width: 230, height: 10 },
    { text: 'right one line two.', x: 330, y: 112, width: 120, height: 10 },
    { text: 'Right two starts after a gap.', x: 330, y: 140, width: 230, height: 10 },
  ]);
  assert.deepEqual(layout.blocks.map((block) => block.text.split(' ')[0]), ['Left', 'Left', 'Right', 'Right']);
  assert.equal(layout.blocks[0]!.text, 'Left one line one continues here left one line two.');
});

test('续行连字符：字母续行拼回一个词，数字续行保留连字符', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: 'parameterized by a fully-connected deep neu-', x: 40, y: 100, width: 250, height: 10 },
    { text: 'ral network trained on 50 views, IEEE-', x: 40, y: 112, width: 250, height: 10 },
    { text: '2026 standard data.', x: 40, y: 124, width: 120, height: 10 },
  ]);
  assert.equal(layout.blocks.length, 1);
  // 真实连字符后接数字时必须保留连字符，不能粘成 "IEEE2026"。
  assert.match(layout.blocks[0]!.text, /neural network trained on 50 views, IEEE-2026 standard data\.$/);
});

test('中文段落的续行之间不插入空格', () => {
  const layout = buildPDFLayout(600, 800, [
    { text: '锥形束 CT 重建是病态逆问题，本文提出一种隐式神经表示', x: 40, y: 100, width: 520, height: 10 },
    { text: '方法，无需外部训练数据。', x: 40, y: 112, width: 300, height: 10 },
  ]);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0]!.text, '锥形束 CT 重建是病态逆问题，本文提出一种隐式神经表示方法，无需外部训练数据。');
});

test('视觉版式计划：按分组合并、按角色覆盖、丢弃页眉', () => {
  const layout = { width: 600, height: 800, blocks: [
    { text: 'Sparse-view CBCT reconstruction', x: 47, y: 100, width: 252, height: 10, fontSize: 10 },
    { text: 'remains ill-posed.', x: 47, y: 114, width: 120, height: 10, fontSize: 10 },
    { text: 'IEEE TRANSACTIONS ON MEDICAL IMAGING', x: 47, y: 40, width: 252, height: 9, fontSize: 9 },
    { text: '2.1 Reconstruction', x: 47, y: 200, width: 200, height: 11, fontSize: 11 },
  ] };
  const targets = ['译文一', '译文二', '页眉', '方法标题'];
  const plan = { groups: [{ from: 0, to: 1, role: 'body' as const }, { from: 2, to: 2 }, { from: 3, to: 3, role: 'heading' as const }], drop: [2] };
  const result = typesetPDFTranslation(layout, targets, plan);
  assert.equal(result.length, 2, '被丢弃的页眉不输出译文');
  assert.deepEqual(result[0]!.sourceIndexes, [0, 1]);
  assert.equal(result[0]!.target, '译文一译文二', '中文译文之间的空格会被排版规则去掉');
  assert.equal(result[0]!.role, 'body');
  assert.equal(result[1]!.role, 'heading', '计划里的角色覆盖几何启发式');

  // 计划不可用（越界 / 未覆盖全部块）时整体回退几何判读，绝不半信半疑。
  const broken = typesetPDFTranslation(layout, targets, { groups: [{ from: 0, to: 9, role: 'body' }] });
  assert.equal(broken.length, layout.blocks.length);
  const gap = typesetPDFTranslation(layout, targets, { groups: [{ from: 0, to: 1 }, { from: 3, to: 3 }] });
  assert.equal(gap.length, layout.blocks.length);
});

test('decorative drop caps do not leave a large English initial in the Chinese paragraph', () => {
  const layout = {width:600,height:800,ornaments:[{text:'A',x:40,y:100,width:26,height:32}],blocks:[
    {text:'s an example of a scientific opening paragraph that continues',x:70,y:100,width:200,height:25,fontSize:11,textFontSize:10},
    {text:'on the subsequent lines of the same paragraph.',x:40,y:128,width:230,height:30,fontSize:11,textFontSize:10},
    {text:'I. INTRODUCTION',x:40,y:200,width:130,height:11,fontSize:11,textFontSize:9},
  ]};
  const result = typesetPDFTranslation(layout,['开头部分','后续部分','引言']);
  assert.equal(result.length,2);
  assert.equal(result[0]!.x,40);
  assert.equal(result[0]!.width,230);
  assert.equal(result[0]!.indent,0);
  assert.equal(result[1]!.role,'heading');
  assert.equal(layout.blocks.length,3,'cached source paragraphs remain intact');
});
