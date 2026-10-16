import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = path.join(root, '.build-fingerprint');
const hash = createHash('sha256');
const excluded = new Set(['node_modules', 'dist', 'bin', 'pdfjs', '.git']);
function visit(relative) {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) return;
  if (fs.statSync(absolute).isDirectory()) {
    for (const name of fs.readdirSync(absolute).sort()) {
      if (!excluded.has(name)) visit(path.join(relative, name));
    }
  } else if (/\.(?:tsx?|css|html|json|mjs|go|mod|sum|sql|svg|png|ico|ttf)$/.test(relative)) {
    hash.update(relative);
    hash.update(fs.readFileSync(absolute));
  }
}
for (const entry of ['apps/web/src', 'apps/web/public', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/vite.config.ts', 'apps/web/tsconfig.json', 'apps/web/tsconfig.node.json', 'apps/desktop/src', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/server/cmd', 'apps/server/internal', 'apps/server/go.mod', 'apps/server/go.sum', 'packages/shared/src', 'packages/shared/package.json', 'packages/shared/tsconfig.json', 'scripts', 'package.json', 'package-lock.json']) visit(entry);
const fingerprint = hash.digest('hex');
const outputs = ['apps/web/dist/index.html', 'apps/desktop/dist/main.js', 'packages/shared/dist/index.js', `apps/server/bin/server${process.platform === 'win32' ? '.exe' : ''}`];
if (outputs.every((file) => fs.existsSync(path.join(root, file))) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === fingerprint) {
  console.log('CBCT: build is up to date.');
} else {
  console.log('CBCT: source changed; building once…');
  const result = spawnSync(process.platform === 'win32' ? 'npm run build' : 'npm', process.platform === 'win32' ? [] : ['run', 'build'], {
    cwd: root, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  fs.writeFileSync(stamp, fingerprint);
}
