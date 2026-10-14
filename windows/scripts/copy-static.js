// 把渲染层的静态资源复制到 dist/renderer，让 index.html 与 app.js 同级。
// 只复制显式列出的文件，不做目录递归。
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');
const assets = ['index.html', 'style.css'];

fs.mkdirSync(outDir, { recursive: true });
for (const name of assets) {
  const from = path.join(srcDir, name);
  if (!fs.existsSync(from)) throw new Error(`缺少渲染层静态资源：${from}`);
  fs.copyFileSync(from, path.join(outDir, name));
}
console.log(`copied ${assets.length} static asset(s) -> dist/renderer/`);

// 品牌字体：Instrument Sans（Qoder 同款项，OFL-1.1 许可），本地打包以满足 CSP font-src 'self'。
const fontsDir = path.join(outDir, 'fonts');
fs.mkdirSync(fontsDir, { recursive: true });
const fontFrom = path.join(srcDir, 'fonts', 'InstrumentSans.ttf');
if (!fs.existsSync(fontFrom)) throw new Error(`缺少渲染层字体文件：${fontFrom}`);
fs.copyFileSync(fontFrom, path.join(fontsDir, 'InstrumentSans.ttf'));
console.log('copied InstrumentSans.ttf -> dist/renderer/fonts/');

// pdfjs worker：渲染进程光栅化 PDF 页面时需要，随包分发到同目录（CSP worker-src 'self' 允许）。
const workerFrom = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
if (fs.existsSync(workerFrom)) {
  fs.copyFileSync(workerFrom, path.join(outDir, 'pdf.worker.min.mjs'));
  console.log('copied pdfjs worker -> dist/renderer/');
}
