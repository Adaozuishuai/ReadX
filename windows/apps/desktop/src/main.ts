import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { BootstrapInfo, DesktopUpdateStatus, ReadyInfo } from '@cbct/shared';

/**
 * Electron 壳只做三件事：拉起 Go server、等就绪、把本地 token 交给渲染进程。
 * 业务逻辑一律在 server 与 web 里，壳保持可替换（这也是 v2 相对旧版的主要结构变化）。
 */

// 与 packages/shared 的 READY_PREFIX 同值。这里刻意不 import 运行时模块：
// 本文件编译为 CommonJS，而 shared 只发 ESM，类型用 import type、常量本地重复。
const READY_PREFIX = 'CBCT_V2_READY ';
const READY_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 4_000;
let availableUpdateVersion: string | undefined;
let downloadedUpdateReady = false;

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
  setupUpdater();

  // 页面内的应用内跳转一律拦回本地阅读页；但指向外部的 http(s) 链接
  // （如每日推荐的「论文来源」）交给系统浏览器打开——原先 setWindowOpenHandler
  // 一律 deny，导致 target="_blank" 的外链点了完全没反应（连提示都没有）。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      // 外链（target="_blank"）走系统浏览器；其余一律不开新窗口。
      if (isExternalHTTP(url) && !sameOrigin(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, target) => {
      if (sameOrigin(target)) return;
      event.preventDefault();
      // 外链交给系统浏览器，别把阅读页导航走；非 http(s) 仍然只做拦截提示。
      if (isExternalHTTP(target)) {
        void shell.openExternal(target);
        return;
      }
      void dialog.showMessageBox({
        type: 'warning',
        message: '已阻止离开本地阅读页的跳转',
        detail: target,
      });
    });
  });

  try {
    server = await startServer();
    allowedOrigin = originOf(startUrl(server));
  } catch (error) {
    dialog.showErrorBox('ReadX 启动失败', describe(error));
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

function setupUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => publishUpdateStatus({ state: 'checking', currentVersion: app.getVersion() }));
  autoUpdater.on('update-available', (info) => {
    availableUpdateVersion = info.version;
    publishUpdateStatus({
      state: 'available', currentVersion: app.getVersion(), version: info.version,
      releaseNotes: releaseNotesText(info.releaseNotes),
    });
  });
  autoUpdater.on('update-not-available', () => publishUpdateStatus({ state: 'current', currentVersion: app.getVersion() }));
  autoUpdater.on('download-progress', (progress) => publishUpdateStatus({
    state: 'downloading', currentVersion: app.getVersion(), percent: Math.max(0, Math.min(100, progress.percent)),
  }));
  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateReady = true;
    publishUpdateStatus({ state: 'downloaded', currentVersion: app.getVersion(), version: info.version });
  });
  autoUpdater.on('error', (error) => publishUpdateStatus({
    state: 'error', currentVersion: app.getVersion(), message: error.message || '更新检查失败，请稍后重试。',
  }));

  ipcMain.handle('readx-updates:check', async (): Promise<DesktopUpdateStatus> => {
    if (!app.isPackaged || process.platform !== 'win32') {
      return {
        state: 'unsupported', currentVersion: app.getVersion(),
        message: process.platform !== 'win32' ? '应用内更新目前仅支持 Windows 桌面版。' : '本地开发版不能自动替换代码，请安装桌面版后检查更新。',
      };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return result?.isUpdateAvailable
        ? {
          state: 'available', currentVersion: app.getVersion(), version: result.updateInfo.version,
          releaseNotes: releaseNotesText(result.updateInfo.releaseNotes),
        }
        : { state: 'current', currentVersion: app.getVersion() };
    } catch (error) {
      const status: DesktopUpdateStatus = { state: 'error', currentVersion: app.getVersion(), message: describe(error) };
      publishUpdateStatus(status);
      return status;
    }
  });

  ipcMain.handle('readx-updates:download', async (): Promise<DesktopUpdateStatus> => {
    if (!app.isPackaged || process.platform !== 'win32') {
      return { state: 'unsupported', currentVersion: app.getVersion(), message: '请在 Windows 桌面安装版中下载更新。' };
    }
    if (!availableUpdateVersion) {
      return { state: 'error', currentVersion: app.getVersion(), message: '请先检查是否有可用更新。' };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { state: 'downloaded', currentVersion: app.getVersion(), version: availableUpdateVersion };
    } catch (error) {
      const status: DesktopUpdateStatus = { state: 'error', currentVersion: app.getVersion(), message: describe(error) };
      publishUpdateStatus(status);
      return status;
    }
  });

  ipcMain.handle('readx-updates:install', () => {
    if (!app.isPackaged || process.platform !== 'win32' || !downloadedUpdateReady) return;
    autoUpdater.quitAndInstall(true, true);
  });
}

function publishUpdateStatus(status: DesktopUpdateStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('readx-updates:status', status);
}

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (typeof notes === 'string') return notes.trim() || undefined;
  if (!Array.isArray(notes)) return undefined;
  return notes
    .map(({ version, note }) => (note?.trim() ? `v${version}\n${note.trim()}` : ''))
    .filter(Boolean)
    .join('\n\n') || undefined;
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
  // Packaged installs keep the user's library/config outside Program Files;
  // development still defaults to the repository root via the Go server.
  const dataRoot = process.env.CBCT_DATA_ROOT || app.getPath('userData');
  args.push('--data-root', dataRoot);

  const webDist = path.resolve(app.getAppPath(), '..', 'web', 'dist');
  // dev 下前端由 Vite 提供；只有直接跑壳（npm start / 打包）才让 server 托管静态页。
  if (!process.env.ELECTRON_START_URL && fs.existsSync(webDist)) args.push('--static', webDist);

  const child = spawn(binary, args, {
    cwd: dataRoot ?? app.getAppPath(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...renderEnvironment(), CBCT_DATA_ROOT: dataRoot },
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

/**
 * Go server 需要知道渲染引擎、字体与脚本在哪；Electron 自带 Node 22，直接复用它，
 * 不要求用户另装 Node。仓库开发态下这些资源就在 windows/ 下；打包态同样按相对
 * 目录探测，找不到时不注入，server 会给出可执行的缺失提示。
 */
function renderEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (process.resourcesPath) {
    env.READX_RESOURCES_DIR = process.resourcesPath;
    const portablePython = path.join(process.resourcesPath, 'python', 'python.exe');
    if (fs.existsSync(portablePython)) env.READX_PYTHON = portablePython;
    const bundledTypst = path.join(process.resourcesPath, 'typst', 'typst.exe');
    if (fs.existsSync(bundledTypst)) env.TYPST_BIN = bundledTypst;
  }
  const windowsRoot = path.resolve(app.getAppPath(), '..', '..');
  const candidates = [
    path.join(windowsRoot, 'resources', 'rendering-engine'),
    path.join(process.resourcesPath ?? '', 'resources', 'rendering-engine'),
    path.join(process.resourcesPath ?? '', 'rendering-engine'),
  ];
  const engine = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'engine', 'bin', 'rpr-retain.js')),
  );
  if (!engine) return env;
  const resources = path.dirname(engine);
  env.CBCT_RENDER_ENGINE_DIR = engine;
  env.CBCT_TRANSLATED_PDF_FONT_DIR = path.join(resources, 'fonts');
  const packagedScript = path.join(process.resourcesPath ?? '', 'scripts', 'render-translated-pdf.cjs');
  const script = fs.existsSync(packagedScript)
    ? packagedScript
    : path.join(windowsRoot, 'scripts', 'render-translated-pdf.cjs');
  if (fs.existsSync(script)) env.CBCT_RENDER_SCRIPT = script;
  env.CBCT_NODE_BIN = process.execPath;
  env.CBCT_ELECTRON_AS_NODE = '1';
  return env;
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<ReadyInfo> {  const stdout = child.stdout;
  if (!stdout) return Promise.reject(new Error('Go server 没有 stdout 管道，无法读取就绪信息'));

  return new Promise<ReadyInfo>((resolve, reject) => {
    const lines = readline.createInterface({ input: stdout, crlfDelay: Infinity });
    const timer = setTimeout(() => {
      lines.close();
      void (async () => {
        child.kill();
        await waitForExit(child, SHUTDOWN_GRACE_MS);
        reject(new Error(`等待就绪超时（${READY_TIMEOUT_MS / 1000}s）：检查 ${serverBinary()} 是否能独立运行`));
      })();
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
    title: 'ReadX',
    // 应用图标（书页 + 锥束射线母题）：dist/main.js 的 __dirname 是 apps/desktop/dist，
    // ico 放在 apps/desktop/ 下，源码运行与打包后都按这个相对位置解析。
    icon: path.join(__dirname, '..', 'icon.ico'),
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

/**
 * 只把 http/https 当作可以交给系统浏览器的外链。
 * 白名单而非黑名单：file:、javascript: 等一律不外发，避免把危险协议交给 ShellExecute。
 */
function isExternalHTTP(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === 'http:' || protocol === 'https:';
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
    if (fs.existsSync(candidate)) return prepareServerRuntime(candidate);
  }
  throw new Error(`找不到 Go server 可执行文件。请先执行 npm run build:go，或设置 CBCT_V2_SERVER。\n已尝试：\n${candidates.join('\n')}`);
}

function prepareServerRuntime(source: string): string {
  if (process.platform !== 'win32') return source;
  const body = fs.readFileSync(source);
  const hash = createHash('sha256').update(body).digest('hex');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'CBCTReading', 'runtime', hash);
  const target = path.join(dir, 'server.exe');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target)) {
    const staging = path.join(dir, `server-${process.pid}.tmp`);
    try {
      fs.writeFileSync(staging, body, { flag: 'wx' });
      fs.renameSync(staging, target);
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
  }
  return target;
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
