import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition} from '@remotion/renderer';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outputDir = resolve(root, '..', '..', 'output', 'ReadX-绿色宣传图');
const cards = [
  ['00-封面.jpg', 40],
  ['01-文献库.jpg', 160],
  ['02-导入论文.jpg', 280],
  ['03-处理进度.jpg', 400],
  ['04-双语阅读.jpg', 520],
  ['05-高亮与批注.jpg', 640],
  ['06-AI助教.jpg', 760],
  ['07-精读五重奏.jpg', 880],
  ['08-论文演示稿.jpg', 1000],
  ['09-AI助手设置.jpg', 1120],
];
const selectedCards = process.argv.includes('--cover') ? cards.slice(0, 1) : cards;

mkdirSync(outputDir, {recursive: true});
const serveUrl = await bundle({entryPoint: resolve(root, 'src/index.ts')});
const composition = await selectComposition({serveUrl, id: 'ReadXEditorialPromo', logLevel: 'error'});

for (const [filename, frame] of selectedCards) {
  const output = resolve(outputDir, filename);
  await renderStill({
    composition,
    serveUrl,
    frame,
    output,
    imageFormat: 'jpeg',
    jpegQuality: 96,
    overwrite: true,
    logLevel: 'error',
  });
  console.log(`Rendered ${filename}`);
}

console.log(outputDir);
