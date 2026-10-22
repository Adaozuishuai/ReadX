import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin') throw new Error('Run this setup on macOS.');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
const uv = process.env.READX_UV || 'uv';
const pythonRoot = path.join(root, '.retain-python');
// uv supplies a relocatable standalone Python, also used for the app bundle.
run(uv, ['python', 'install', '3.12.14', '--install-dir', pythonRoot, '--no-bin']);
const installed = fs.readdirSync(pythonRoot).find(name => name.startsWith('cpython-3.12.14-'));
if (!installed) throw new Error('Standalone Python installation not found.');
const basePython = path.join(pythonRoot, installed, 'bin', 'python3');
const runtime = path.join(root, '.retain-runtime');
run(uv, ['venv', '--allow-existing', '--python', basePython, runtime]);
run(uv, ['pip', 'install', '--python', path.join(runtime, 'bin', 'python3'), '--only-binary', ':all:',
  'Pillow==10.4.0', 'PyMuPDF==1.26.5', 'pikepdf==10.13.0.post1', 'requests==2.32.5', 'urllib3==2.5.0']);

const typstRoot = path.join(runtime, 'typst');
fs.mkdirSync(typstRoot, { recursive: true });
const typst = path.join(typstRoot, 'typst');
if (!fs.existsSync(typst)) {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!arch) throw new Error(`Unsupported architecture ${process.arch}`);
  const name = `typst-${arch}-apple-darwin.tar.xz`;
  // SHA-256 values published with the upstream v0.15.1 release assets:
  // https://github.com/typst/typst/releases/expanded_assets/v0.15.1
  const checksums = {
    aarch64: '48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a',
    x86_64: '7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa',
  };
  const download = await fetch(`https://github.com/typst/typst/releases/download/v0.15.1/${name}`);
  if (!download.ok) throw new Error(`Typst download HTTP ${download.status}`);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== checksums[arch]) throw new Error('Typst checksum mismatch.');
  const archive = path.join(runtime, name);
  fs.writeFileSync(archive, bytes);
  run('tar', ['-xf', archive, '-C', typstRoot, '--strip-components=1']);
  fs.unlinkSync(archive);
}
run(typst, ['--version']);
console.log('macOS Lee runtime ready. Run npm run check:runtime.');
