/** Browser fallback for machines where the Electron runtime cannot start. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createServer } from 'vite';
import { v2Paths } from './go.mjs';
import { prepareServerRuntime } from './server-runtime.mjs';

const port = Number(process.env.CBCT_VITE_PORT ?? 5183);
const url = `http://127.0.0.1:${port}`;
const dataRoot = path.resolve(process.env.CBCT_DATA_ROOT || path.join(v2Paths.root, '..'));
let backend;
let frontend;
let stopping = false;

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));

try {
  const existing = await fetch(`${url}/v1/meta`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok ? response.json() : null).catch(() => null);
  if (existing?.app === 'cbct-reading-v2' && path.resolve(existing.dataRoot).toLowerCase() === dataRoot.toLowerCase()) {
    openBrowser();
  } else {
    const build = spawnSync(process.execPath, ['scripts/build-server.mjs'], {
      cwd: v2Paths.root, stdio: 'inherit', windowsHide: true,
    });
    if (build.status !== 0) throw new Error('本地服务构建失败');

    const info = await startBackend();
    // Keep the token in this process; it is never put in a URL or written to disk.
    frontend = await createServer({
      root: v2Paths.webDir,
      configFile: path.join(v2Paths.webDir, 'vite.config.ts'),
      server: {
        host: '127.0.0.1', port, strictPort: true, open: false,
        proxy: {
          '/v1': {
            target: `http://127.0.0.1:${info.port}`,
            changeOrigin: false,
            headers: { Authorization: `Bearer ${info.token}` },
          },
          '/healthz': { target: `http://127.0.0.1:${info.port}`, changeOrigin: false },
        },
      },
    });
    await frontend.listen();
    console.log(`CBCT browser ready: ${url}`);
    openBrowser();
  }
} catch (error) {
  console.error('[browser]', error instanceof Error ? error.message : String(error));
  await stop(1);
}

function startBackend() {
  backend = spawn(prepareServerRuntime(v2Paths.serverBin), ['--exit-on-stdin-eof', '--data-root', dataRoot], {
    cwd: v2Paths.root, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待本地服务启动超时')), 30_000);
    const lines = readline.createInterface({ input: backend.stdout });
    backend.once('error', (error) => { clearTimeout(timer); reject(error); });
    backend.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`本地服务已退出 (${code})`));
      if (!stopping && frontend) void stop(1);
    });
    lines.on('line', (line) => {
      if (!line.startsWith('CBCT_V2_READY ')) return;
      clearTimeout(timer);
      lines.close();
      try { resolve(JSON.parse(line.slice('CBCT_V2_READY '.length))); }
      catch { reject(new Error('本地服务启动信息无效')); }
    });
  });
}

function openBrowser() {
  // Service-only restarts can refresh the backend without opening a browser window.
  if (process.argv.includes('--no-open')) return;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Google/Chrome/Application/chrome.exe'),
  ];
  const executable = candidates.find((file) => fs.existsSync(file));
  const child = spawn(executable || 'explorer.exe', executable ? [`--app=${url}`] : [url], {
    detached: true, stdio: 'ignore', windowsHide: false,
  });
  child.on('error', (error) => console.error('打开浏览器失败:', error.message));
  child.unref();
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  await frontend?.close();
  if (backend && backend.exitCode === null) {
    backend.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { backend.kill(); resolve(); }, 3000);
      backend.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  process.exit(code);
}
