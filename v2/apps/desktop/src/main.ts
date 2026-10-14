import { app, BrowserWindow, dialog } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { BootstrapInfo, ReadyInfo } from '@cbct/shared';

/**
 * Electron 壳只做三件事：拉起 Go server、等就绪、把本地 token 交给渲染进程。
 * 业务逻辑一律在 server 与 web 里，壳保持可替换（这也是 v2 相对旧版的主要结构变化）。
 */

// 与 packages/shared 的 READY_PREFIX 同值。这里刻意不 import 运行时模块：
// 本文件编译为 CommonJS，而 shared 只发 ESM，类型用 import type、常量本地重复。
const READY_PREFIX = 'CBCT_V2_READY ';
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 4_000;

interface ServerHandle {
  info: ReadyInfo;
  child: ChildProcessWithoutNullStreams | null;
}

let mainWindow: BrowserWindow | null = null;
let server: ServerHandle | null = null;
let allowedOrigin = '';
let stopping = false;
let stopRequested = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // 页面内任何跳转与新窗口都不允许离开本地阅读页。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, target) => {
      if (!sameOrigin(target)) {
        event.preventDefault();
        void dialog.showMessageBox({
          type: 'warning',
          message: '已阻止离开本地阅读页的跳转',
          detail: target,
        });
      }
    });
  });

  try {
    server = await startServer();
    allowedOrigin = originOf(startUrl(server));
  } catch (error) {
    dialog.showErrorBox('CBCT 精读 v2 启动失败', describe(error));
    app.quit();
    return;
  }

  createWindow();

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (mainWindow === null && server) createWindow();
  });
  app.on('before-quit', (event) => {
    if (!server || stopRequested) return;
    // 先拦住退出：子进程没关干净就 quit，会留下占着 SQLite 与端口的孤儿进程。
    event.preventDefault();
    stopRequested = true;
    void stopServer().finally(() => {
      stopping = true;
      app.quit();
    });
  });
}

async function startServer(): Promise<ServerHandle> {
  // attached 模式：dev.mjs 已经起了 server（Vite proxy 要读它的 dev-info.json），壳只连接。
  if (process.env.CBCT_V2_ATTACH === '1') {
    const info = readDevInfo();
    if (!info) {
      throw new Error('CBCT_V2_ATTACH=1 但缺少 apps/server/dev-info.json，请用 npm run dev 启动。');
    }
    return { info, child: null };
  }

  const binary = serverBinary();
  const args: string[] = ['--exit-on-stdin-eof'];
  const dataRoot = process.env.CBCT_DATA_ROOT;
  if (dataRoot) args.push('--data-root', dataRoot);

  const webDist = path.resolve(app.getAppPath(), '..', 'web', 'dist');
  // dev 下前端由 Vite 提供；只有直接跑壳（npm start / 打包）才让 server 托管静态页。
  if (!process.env.ELECTRON_START_URL && fs.existsSync(webDist)) args.push('--static', webDist);

  const child = spawn(binary, args, {
    cwd: dataRoot ?? app.getAppPath(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: process.env,
  });

  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => process.stderr.write(`[server] ${chunk}`));
  child.stdout?.setEncoding('utf8');
  child.on('error', (error) => {
    if (!stopping) void reportServerLost(`无法启动 ${binary}：${error.message}`);
  });

  const info = await waitForReady(child);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    void reportServerLost(`Go server 意外退出（code=${code ?? 'null'} signal=${signal ?? 'none'}）`);
  });
  return { info, child };
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<ReadyInfo> {
  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error('Go server 没有 stdout 管道，无法读取就绪信息'));

  return new Promise<ReadyInfo>((resolve, reject) => {
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`等待就绪超时（${READY_TIMEOUT_MS / 1000}s）：检查 ${serverBinary()} 是否能独立运行`));
    }, READY_TIMEOUT_MS);

    const onClose = () => {
      clearTimeout(timer);
      reject(new Error('Go server 在打印就绪信息前就退出了，请查看 [server] 日志'));
    };
    stdout.once('close', onClose);

    lines.on('line', (line) => {
      if (!line.startsWith(READY_PREFIX)) return;
      clearTimeout(timer);
      stdout.removeListener('close', onClose);
      lines.close();
      try {
        resolve(JSON.parse(line.slice(READY_PREFIX.length)) as ReadyInfo);
      } catch (error) {
        reject(new Error(`就绪信息不是合法 JSON：${describe(error)}`));
      }
    });
  });
}

async function stopServer(): Promise<void> {
  const child = server?.child;
  if (!child) return;
  // 关 stdin 触发 server 的 --exit-on-stdin-eof，走优雅关闭（flush SQLite）。
  child.stdin?.end();
  const exited = await waitForExit(child, SHUTDOWN_GRACE_MS);
  if (!exited) child.kill('SIGTERM');
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function reportServerLost(message: string): Promise<void> {
  stopping = true;
  await dialog.showMessageBox({ type: 'error', message: '本地服务已停止', detail: message });
  app.quit();
}

function createWindow(): void {
  if (!server) return;
  const url = startUrl(server);
  const injected: BootstrapInfo = { apiBase: originOf(url), token: server.info.token };

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 660,
    show: false,
    backgroundColor: '#f6f2ea',
    title: 'CBCT 精读 v2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // token 只经主进程进渲染进程，不进 URL、不落磁盘。
      additionalArguments: [`--cbct-api-base=${injected.apiBase}`, `--cbct-token=${injected.token}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(url);
}

function startUrl(handle: ServerHandle): string {
  return process.env.ELECTRON_START_URL || `http://${handle.info.host}:${handle.info.port}/`;
}

function sameOrigin(target: string): boolean {
  try {
    return originOf(target) === allowedOrigin;
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  const parsed = new URL(value);
  return `${parsed.protocol}//${parsed.host}`;
}

function serverBinary(): string {
  const name = process.platform === 'win32' ? 'server.exe' : 'server';
  const candidates = [
    process.env.CBCT_V2_SERVER,
    path.resolve(app.getAppPath(), '..', 'server', 'bin', name),
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', name) : '',
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 Go server 可执行文件。请先执行 npm run build:go，或设置 CBCT_V2_SERVER。\n已尝试：\n${candidates.join('\n')}`);
}

function readDevInfo(): ReadyInfo | null {
  const file = path.resolve(app.getAppPath(), '..', 'server', 'dev-info.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReadyInfo>;
    if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || typeof parsed.host !== 'string') {
      return null;
    }
    return parsed as ReadyInfo;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
