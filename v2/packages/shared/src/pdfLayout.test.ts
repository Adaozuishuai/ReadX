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
  assert.match(layout.blocks[0]!.text, /Left.*Left/);
  assert.match(layout.blocks[1]!.text, /Right.*Right/);
  assert.equal(layout.blocks[0]!.height, 23);
  assert.equal(layout.blocks[2]!.text, 'Method');
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
