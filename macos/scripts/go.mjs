/**
 * Go 工具链解析。
 *
 * 本机 go.exe 装在 `C:/Program Files/Go/bin`，但已在跑的终端会话不会自动刷新 PATH，
 * 所以 npm script 不能直接写 `go`。这里按固定候选表探测可用二进制，并统一模块代理
 * （proxy.golang.org 在本机不通，必须走 goproxy.cn）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeEnvironment } from './platform-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const v2Root = path.resolve(here, '..');

export const serverDir = path.join(v2Root, 'apps', 'server');
export const v2Paths = {
  root: v2Root,
  serverDir,
  webDir: path.join(v2Root, 'apps', 'web'),
  desktopDir: path.join(v2Root, 'apps', 'desktop'),
  serverBin: path.join(serverDir, 'bin', process.platform === 'win32' ? 'server.exe' : 'server'),
  devInfo: path.join(serverDir, 'dev-info.json'),
  webDist: path.join(v2Root, 'apps', 'web', 'dist'),
};

const MIN_GO = { major: 1, minor: 27 };

/** 要求 Go >= 1.27：低于它给出可执行的修复指令，而不是抛一句编译期语法错误。 */
export function resolveGo() {
  const candidates = [
    process.env.CBCT_V2_GO,
    'C:/Program Files/Go/bin/go.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Go', 'bin', 'go.exe') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'go', 'bin', 'go.exe') : '',
    path.resolve(v2Root, '..', '.tools', 'go', 'bin', 'go'),
    '/opt/homebrew/bin/go',
    '/usr/local/bin/go',
    '/usr/local/go/bin/go',
    'go',
  ].filter(Boolean);

  const failures = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8', env: goEnv(), windowsHide: true });
    if (probe.error || probe.status !== 0) {
      failures.push(`${candidate}: ${probe.error ? probe.error.message : `exit ${probe.status}`}`);
      continue;
    }
    const version = parseVersion(probe.stdout ?? '');
    if (!version) {
      failures.push(`${candidate}: 版本号解析失败`);
      continue;
    }
    if (version.major < MIN_GO.major || (version.major === MIN_GO.major && version.minor < MIN_GO.minor)) {
      throw new Error(
        `需要 Go ${MIN_GO.major}.${MIN_GO.minor}.0 以上，实际 ${version.raw}（${candidate}）。\n升级 Go 工具链，或设置 CBCT_V2_GO`,
      );
    }
    return { command: candidate, version: version.raw };
  }
  throw new Error(
    '找不到可用的 Go 工具链。安装 Go 1.27+（macOS 可用 brew install go），或设置 CBCT_V2_GO。' +
      `\n探测记录：\n${failures.join('\n')}`,
  );
}

function parseVersion(text) {
  const match = /go(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), raw: match[0] };
}

/** GOPROXY 兜底：本机直连 proxy.golang.org 超时（纯 Go 的 SQLite 驱动也就不需要 CGO）。 */
export function goEnv(extra = {}) {
  return {
    ...runtimeEnvironment(v2Root),
    GOPROXY: process.env.GOPROXY ?? 'https://goproxy.cn,direct',
    CGO_ENABLED: process.env.CGO_ENABLED ?? '0',
    ...extra,
  };
}

export function runGo(args, { cwd = serverDir, stdio = 'inherit', env = {} } = {}) {
  const go = resolveGo();
  const result = spawnSync(go.command, args, {
    cwd,
    stdio,
    env: goEnv(env),
    encoding: stdio === 'inherit' ? null : 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return { ...result, go };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('用法：node scripts/go.mjs <go 子命令与参数>');
    process.exit(2);
  }
  const result = runGo(args, { stdio: 'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
