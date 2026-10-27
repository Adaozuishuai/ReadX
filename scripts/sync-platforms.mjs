// Windows is the canonical implementation; macOS mirrors core sources byte for byte.
// Keep only packaging, launchers and platform documentation outside this manifest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const ignored = new Set(['node_modules', '__pycache__', '.codex-preview']);
const trees = ['apps/server', 'apps/web', 'apps/desktop/src', 'apps/desktop/test', 'packages/shared', 'resources', 'vendor'];
const files = ['apps/desktop/tsconfig.json', 'config.example.json', 'package-lock.json',
  ...['build-server.mjs', 'dev.mjs', 'ensure-built.mjs', 'gen-fixtures.mjs', 'go.mjs',
    'prepare-pdf.mjs', 'render-translated-pdf.cjs', 'server-runtime.mjs', 'import-smoke.cjs', 'update-smoke.jsx', 'latex-state.test.cjs',
    'desktop-smoke.cjs', 'launcher-smoke.cjs', 'run-desktop-smoke.mjs', 'import-smoke.jsx', 'platform-runtime.mjs', 'runtime-check.mjs', 'book-sources.test.cjs', 'margin-note.test.cjs', 'processing-jobs.test.cjs'].map(name => `scripts/${name}`)];
const differences = [];
let checked = 0;

function list(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'data' && dir.endsWith(path.join('vendor', 'retainpdf'))) return [];
    if ((entry.name === 'bin' && dir.endsWith(path.join('apps', 'server'))) ||
      (entry.name === 'dist' && ['apps/web', 'apps/desktop', 'packages/shared'].some(part => dir.endsWith(path.join(...part.split('/'))))) ||
      (entry.name === 'pdfjs' && dir.endsWith(path.join('apps', 'web', 'public')))) return [];
    if (ignored.has(entry.name) || /(?:\.py[co]|\.log|\.db(?:-shm|-wal)?|dev-info\.json(?:\.tmp)?)$/.test(entry.name)) return [];
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? list(path.join(dir, entry.name), relative) : [relative];
  });
}
function mirror(relative) {
  const source = path.join(root, 'windows', relative);
  const target = path.join(root, 'macos', relative);
  checked++;
  if (fs.existsSync(target) && fs.readFileSync(source).equals(fs.readFileSync(target))) return;
  differences.push(relative);
  if (!check) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}
for (const tree of trees) {
  const sourceFiles = list(path.join(root, 'windows', tree));
  const sourceSet = new Set(sourceFiles);
  for (const name of sourceFiles) mirror(path.join(tree, name));
  for (const name of list(path.join(root, 'macos', tree))) {
    if (sourceSet.has(name)) continue;
    differences.push(`obsolete: ${tree}/${name}`);
    if (!check) fs.unlinkSync(path.join(root, 'macos', tree, name));
  }
}
for (const file of files) mirror(file);
// Platform build targets differ; core dependency versions and contracts must not.
for (const relative of ['package.json', 'apps/desktop/package.json']) {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'windows', relative), 'utf8'));
  const targetFile = path.join(root, 'macos', relative);
  const target = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  let changed = false;
  for (const key of ['name', 'version', 'author', 'dependencies', 'devDependencies', 'engines', 'workspaces', 'allowScripts']) {
    if (JSON.stringify(source[key]) === JSON.stringify(target[key])) continue;
    differences.push(`${relative}:${key}`);
    changed = true;
    if (source[key] === undefined) delete target[key]; else target[key] = source[key];
  }
  if (changed && !check) fs.writeFileSync(targetFile, JSON.stringify(target, null, 2) + '\n');
}
if (check && differences.length) {
  console.error(`Platform drift (${differences.length} files). Run node scripts/sync-platforms.mjs:\n${differences.slice(0, 30).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`${checked} core files ${check ? 'verified identical' : `synchronized (${differences.length} changes)`}.`);
}
