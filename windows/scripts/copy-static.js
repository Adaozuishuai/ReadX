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
