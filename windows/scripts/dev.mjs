/**
 * v2 开发/启动编排。
 *
 *   npm run dev          → Go server + Vite + Electron（热更新，三进程）
 *   npm run dev -- --built → 先构建前端与 server，再由 Electron 托管 server 直接跑 dist
 *
 * 顺序有讲究：Vite 的 dev proxy 在**启动时**读取 server 写出的 dev-info.json，
 * 所以必须等 server 就绪再起 Vite，否则 /v1 代理为空、页面报 401。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { runGo, v2Paths } from './go.mjs';
import { prepareServerRuntime } from './server-runtime.mjs';

const built = process.argv.includes('--built');
const VITE_PORT = Number(process.env.CBCT_VITE_PORT ?? 5183);
const READY_PREFIX = 'CBCT_V2_READY ';
const children = [];
let exiting = false;

process.on('SIGINT', () => void teardown(130));
process.on('SIGTERM', () => void teardown(143));

try {
  await main();
} catch (error) {
  console.error('[dev] 启动失败:', error instanceof Error ? error.message : error);
  await teardown(1);
}

async function main() {
  if (built) {
    const { status } = await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, ['scripts/ensure-built.mjs'], { cwd: v2Paths.root, stdio: 'inherit', windowsHide: true }));
    if (status !== 0) throw new Error('构建失败');
  } else buildServer();

  if (built) {
    if (!fs.existsSync(path.join(v2Paths.webDist, 'index.html'))) {
      console.log('[dev] 前端未构建，先跑 vite build');
      await runNpm(['run', 'build', '-w', '@cbct/web'], v2Paths.root);
    }
    // 托管模式：server 由 Electron 壳负责拉起与回收，编排脚本只启动壳。
    await launchDesktop({ ELECTRON_START_URL: '', CBCT_V2_SERVER: prepareServerRuntime(v2Paths.serverBin) });
    return;
  }

  fs.rmSync(v2Paths.devInfo, { force: true });
  const info = await startServer();
  console.log(`[dev] server 就绪：http://${info.host}:${info.port}`);

  const vite = runNpm(['run', 'dev', '-w', '@cbct/web'], v2Paths.root, { CBCT_VITE_PORT: String(VITE_PORT) });
  await waitForPort(VITE_PORT, 60_000);
  console.log(`[dev] vite 就绪：http://127.0.0.1:${VITE_PORT}`);

  await launchDesktop({
    CBCT_V2_ATTACH: '1',
    CBCT_V2_SERVER: v2Paths.serverBin,
    CBCT_DATA_ROOT: dataRootOf(info),
    ELECTRON_START_URL: `http://127.0.0.1:${VITE_PORT}`,
  });
}

function buildServer() {
  console.log('[dev] go build → apps/server/bin');
  const result = runGo(['build', '-trimpath', '-o', v2Paths.serverBin, './cmd/server'], {
    cwd: v2Paths.serverDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`go build 失败（exit ${result.status}）`);
}

function startServer() {
  const child = spawn(
    prepareServerRuntime(v2Paths.serverBin),
    ['--exit-on-stdin-eof', '--dev-info', v2Paths.devInfo, '--port', '0'],
    { stdio: ['pipe', 'pipe', 'inherit'], cwd: v2Paths.serverDir, windowsHide: true, env: process.env },
  );
  track(child, 'server');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 server 就绪超时')), 30_000);
    child.stdout.setEncoding('utf8');
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.startsWith(READY_PREFIX)) return;
      clearTimeout(timer);
      lines.close();
      try {
        resolve(JSON.parse(line.slice(READY_PREFIX.length)));
      } catch (error) {
        reject(new Error(`就绪信息解析失败: ${error}`));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前退出（code ${code}）`));
    });
  });
}

function launchDesktop(env) {
  console.log('[dev] electron 壳启动中…');
  const child = runNpm(['run', 'start', '-w', '@cbct/desktop'], v2Paths.desktopDir, env);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      console.log(`[dev] electron 退出（code ${code}），关闭其余进程`);
      void teardown(code ?? 0, resolve);
    });
  });
}

function runNpm(args, cwd, env = {}) {
  // Windows 上 npm 是 .cmd：Node 20+ 不允许不带 shell 直接 spawn 它（EINVAL），
  // 而带 shell 时参数必须自己拼成一条命令串。
  const isWin = process.platform === 'win32';
  const command = isWin ? `npm ${args.join(' ')}` : 'npm';
  const child = spawn(command, isWin ? [] : args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: isWin,
    env: { ...process.env, ...env },
  });
  track(child, `npm ${args.join(' ')}`);
  return child;
}

function track(child, label) {
  children.push({ child, label });
  child.on('error', (error) => console.error(`[dev] ${label} 进程错误:`, error.message));
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`端口 ${port} 在 ${timeoutMs / 1000}s 内没有监听`));
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

function dataRootOf(info) {
  return typeof info.dataRoot === 'string' ? info.dataRoot : path.resolve(v2Paths.root, '..');
}

async function teardown(code, done) {
  if (exiting) return;
  exiting = true;
  for (const { child, label } of children) {
    if (child.killed || child.exitCode !== null) continue;
    try {
      // 关 stdin 让 Go server 走优雅关闭；其余进程直接终止。
      child.stdin?.end();
      setTimeout(() => child.kill(), label.startsWith('server') ? 2000 : 200).unref();
    } catch (error) {
      console.error(`[dev] 关闭 ${label} 失败:`, error.message);
    }
  }
  fs.rmSync(v2Paths.devInfo, { force: true });
  if (done) done();
  else process.exit(code);
}
