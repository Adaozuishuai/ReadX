import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, ['scripts/ensure-built.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.status !== 0) process.exit(build.status ?? 1);
const prepared = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/prepare-electron-runtime.ps1')], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (prepared.status !== 0) throw new Error(prepared.stderr || '无法准备桌面运行时');
const executable = prepared.stdout.trim();
const env = { ...process.env, CBCT_DATA_ROOT: process.env.CBCT_DATA_ROOT || path.resolve(root, '..') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_START_URL;
delete env.CBCT_V2_ATTACH;
delete env.CBCT_V2_BROWSER_PROXY;
const proxy = `http://127.0.0.1:${Number(process.env.CBCT_VITE_PORT ?? 5183)}`;
const meta = await fetch(`${proxy}/v1/meta`, { signal: AbortSignal.timeout(2_000) }).then(response => response.ok ? response.json() : null).catch(() => null);
if (meta?.app === 'cbct-reading-v2' && path.resolve(meta.dataRoot).toLowerCase() === path.resolve(env.CBCT_DATA_ROOT).toLowerCase()) {
  env.CBCT_V2_BROWSER_PROXY = proxy;
  console.log('复用正在运行的本机书库服务。');
}
const logDir = path.join(root, '.tmp-smoke', 'launcher');
fs.mkdirSync(logDir, { recursive: true });
const log = fs.openSync(path.join(logDir, 'desktop-launch.log'), 'a');
const child = spawn(executable, [path.join(root, 'apps', 'desktop')], {
  cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
fs.closeSync(log);
console.log(`ReadX 桌面版已启动（PID ${child.pid}）。`);
