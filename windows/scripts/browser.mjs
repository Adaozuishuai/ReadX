/** Browser fallback for machines where the Electron runtime cannot start. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
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
  // 先构建再判断：源码改过而旧实例还在跑时，二进制必须已经是新的，
  // 否则「比对构建指纹」永远相等，改动要等用户手动重启才生效。
  buildServer();
  const expectedBuild = binaryBuild();
  const existing = await probe();
  if (existing && sameDataRoot(existing) && existing.build !== expectedBuild) {
    await stopStale(existing, expectedBuild);
  }
  const still = await probe();
  if (still && sameDataRoot(still)) {
    if (still.build !== expectedBuild) {
      throw new Error('旧版本的 ReadX 仍在运行（可能是旧启动器拉起的），请关闭它的窗口后重试');
    }
    // 同一份构建已经在跑：直接开窗口，别起第二套后端去抢同一个 SQLite。
    openBrowser();
  } else {
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
    console.log(`CBCT browser ready: ${url} (build ${expectedBuild.slice(0, 8)})`);
    openBrowser();
  }
} catch (error) {
  console.error('[browser]', error instanceof Error ? error.message : String(error));
  await stop(1);
}

function buildServer() {
  const build = spawnSync(process.execPath, ['scripts/build-server.mjs'], {
    cwd: v2Paths.root, stdio: 'inherit', windowsHide: true,
  });
  if (build.status !== 0) throw new Error('本地服务构建失败');
}

// 与 prepareServerRuntime 的目录名同源：同一份可执行文件 → 同一个指纹。
function binaryBuild() {
  return createHash('sha256').update(fs.readFileSync(v2Paths.serverBin)).digest('hex');
}

function sameDataRoot(info) {
  return info.app === 'cbct-reading-v2'
    && path.resolve(info.dataRoot).toLowerCase() === dataRoot.toLowerCase();
}

async function probe() {
  return fetch(`${url}/v1/meta`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.ok ? response.json() : null).catch(() => null);
}

/**
 * 停掉旧构建留下的实例。
 *
 * 旧后端是被旧启动器当子进程拉起来的：杀掉它，旧启动器的 `exit` 处理会关掉自己
 * 的 Vite 并退出，5183 随之释放。这里只是「通知」，不接管旧进程树——如果它没退，
 * 后面的 listen 会报端口占用，用户能看到明确原因。
 */
async function stopStale(existing, expectedBuild) {
  const from = (existing.build || 'unknown').slice(0, 8);
  console.log(`[browser] 检测到旧后端（build ${from}），重启到 ${expectedBuild.slice(0, 8)}`);
  if (existing.pid) {
    try {
      process.kill(existing.pid);
    } catch (error) {
      console.error('[browser] 无法结束旧后端:', error instanceof Error ? error.message : String(error));
    }
  } else {
    // 升级前的后端不会在 /v1/meta 里报 pid；按命令行里的数据根反查，免得用户
    // 每次都必须先手动关掉旧窗口才能用上新构建。
    killLegacyServers();
  }
  // 旧进程退出要一点时间：先等它释放端口，再交给下面的启动流程。
  if (await waitForPort(port, false, 8000)) return;
  console.error('[browser] 旧实例没有在 8s 内释放端口，请手动关闭 ReadX 后重试');
}

function killLegacyServers() {
  const script = [
    "$root = $env:CBCT_STALE_ROOT;",
    "Get-CimInstance Win32_Process -Filter \"Name='server.exe'\" |",
    "Where-Object { $_.CommandLine -like ('*--data-root*' + $root + '*') } |",
    "ForEach-Object { Write-Output ('[browser] 停止旧后端 pid=' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }",
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CBCT_STALE_ROOT: dataRoot },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) console.error('[browser] 反查旧后端失败:', result.stderr?.trim() ?? result.status);
}

function waitForPort(targetPort, expectOpen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port: targetPort });
      const settle = (open) => {
        socket.destroy();
        if (open === expectOpen) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(attempt, 150);
      };
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.setTimeout(1000, () => settle(false));
    };
    attempt();
  });
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
