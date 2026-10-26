import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Build macOS releases on macOS.');
const stage = path.join(root, '.release-staging', 'resources');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const pythonRoot = path.join(root, '.retain-python');
const installed = fs.existsSync(pythonRoot) && fs.readdirSync(pythonRoot).find(name => name.startsWith('cpython-3.12.14-'));
if (!installed) throw new Error('Run npm run setup:runtime before packaging.');
fs.cpSync(path.join(pythonRoot, installed), path.join(stage, 'python'), { recursive: true, dereference: false, verbatimSymlinks: true });
const venvSite = path.join(root, '.retain-runtime', 'lib', 'python3.12', 'site-packages');
fs.cpSync(venvSite, path.join(stage, 'python', 'lib', 'python3.12', 'site-packages'), { recursive: true });
for (const [from, to] of [
  ['vendor/retainpdf/backend', 'vendor/retainpdf/backend'],
  ['resources/rendering-engine', 'rendering-engine'], ['resources/fonts', 'fonts'],
  ['resources/realtime-tex', 'realtime-tex'],
  ['.retain-runtime/typst', 'typst'], ['scripts/render-translated-pdf.cjs', 'scripts/render-translated-pdf.cjs'],
  ['vendor/retainpdf/LICENSE', 'licenses/retainpdf-LICENSE'],
]) {
  fs.mkdirSync(path.dirname(path.join(stage, to)), { recursive: true });
  fs.cpSync(path.join(root, from), path.join(stage, to), {
    recursive: true, filter: file => !['__pycache__', 'node_modules', '.git'].includes(path.basename(file)),
  });
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ private: true, dependencies: {
  fontkit: '2.0.4', 'mathjax-full': '3.2.1', 'pdf-lib': '1.17.1',
} }, null, 2));
const result = spawnSync('npm', ['install', '--prefix', stage, '--omit=dev', '--no-audit', '--no-fund'], { stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('Installing release Node dependencies failed.');
// Reject missing binary dependencies before producing an installer.
const probe = spawnSync(path.join(stage, 'python', 'bin', 'python3'), ['-c', 'import PIL, fitz, pikepdf, requests; print("Bundled Python OK")'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) throw new Error(probe.stderr || probe.error?.message);
console.log(probe.stdout.trim());
console.log(`Release runtime prepared: ${stage}`);
