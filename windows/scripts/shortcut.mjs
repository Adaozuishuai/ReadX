#!/usr/bin/env node
/**
 * 安装/修复 Windows 桌面快捷方式（含图标）。
 *
 * 为什么要复制图标：快捷方式的 IconLocation 必须指向资源管理器能读取的位置。
 * 仓库目录可能被放在低完整性标记或漫游盘的深层目录里，Explorer 会拒绝加载那里的
 * .ico，快捷方式就退回成通用“文件 + 箭头”图标。这里统一把图标装到
 * %LOCALAPPDATA%\ReadX\ReadX.ico，再用 WScript.Shell 写快捷方式。
 *
 * 用法：
 *   node scripts/shortcut.mjs               # 使用 Electron 桌面壳（默认）
 *   node scripts/shortcut.mjs --browser     # 使用 start-browser.ps1 浏览器回退
 *   node scripts/shortcut.mjs --name ReadX  # 自定义快捷方式名称
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useBrowser = args.includes('--browser');
const nameIndex = args.indexOf('--name');
const shortcutName = nameIndex >= 0 && args[nameIndex + 1] ? args[nameIndex + 1] : 'ReadX';

const iconName = 'ReadX.ico';
const iconDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ReadX');
const iconPath = path.join(iconDir, iconName);

function copyIcon() {
  const sources = [
    path.join(root, 'apps', 'desktop', 'icon.ico'),
    path.join(root, 'apps', 'desktop', iconName),
    path.join(root, 'apps', 'web', 'public', 'icon-256.png'),
  ];
  const source = sources.find((candidate) => fs.existsSync(candidate));
  if (!source) throw new Error(`找不到图标源文件：${sources.join(' / ')}`);
  fs.mkdirSync(iconDir, { recursive: true });
  fs.copyFileSync(source, iconPath);
  return source;
}

function desktopDir() {
  // OneDrive 重定向的桌面优先；不存在时回退到用户目录下的 Desktop。
  const candidates = [];
  if (process.env.OneDrive) candidates.push(path.join(process.env.OneDrive, 'Desktop'));
  if (process.env.OneDriveConsumer) candidates.push(path.join(process.env.OneDriveConsumer, 'Desktop'));
  candidates.push(path.join(os.homedir(), 'Desktop'));
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (!existing) throw new Error('找不到桌面目录');
  return existing;
}

/** 用 PowerShell 写 .lnk：WScript.Shell 是唯一稳定的入口，不必另装依赖。 */
function writeShortcut(linkPath, target, shortcutArgs, workingDirectory, description, windowStyle) {
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut(${psLiteral(linkPath)})
$link.TargetPath = ${psLiteral(target)}
$link.Arguments = ${psLiteral(shortcutArgs)}
$link.WorkingDirectory = ${psLiteral(workingDirectory)}
$link.IconLocation = ${psLiteral(`${iconPath},0`)}
$link.Description = ${psLiteral(description)}
$link.WindowStyle = ${windowStyle}
$link.Save()
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(`写快捷方式失败：${(result.stderr || result.stdout || '').trim()}`);
  }
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function readExisting(linkPath) {
  if (!fs.existsSync(linkPath)) return null;
  const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut(${psLiteral(linkPath)})
Write-Output $link.TargetPath
Write-Output $link.Arguments
Write-Output $link.WorkingDirectory
`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return null;
  const [target = '', shortcutArgs = '', workingDirectory = ''] = result.stdout.split(/\r?\n/);
  return target ? { target, args: shortcutArgs, workingDirectory } : null;
}

function main() {
  if (process.platform !== 'win32') throw new Error('桌面快捷方式只适用于 Windows');
  const source = copyIcon();
  const linkPath = path.join(desktopDir(), `${shortcutName}.lnk`);
  const existing = readExisting(linkPath);

  // 已有快捷方式只补图标与描述，不擅自改变它启动什么。
  let target;
  let shortcutArgs;
  let workingDirectory;
  let windowStyle = 1;
  if (existing) {
    ({ target, args: shortcutArgs, workingDirectory } = existing);
    // 原先用隐藏窗口的 PowerShell 启动器：继续最小化，避免闪一下控制台。
    if (/powershell(?:\.exe)?$/i.test(target)) windowStyle = 7;
  } else if (useBrowser) {
    target = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    shortcutArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.join(root, 'scripts', 'start-browser.ps1')}"`;
    workingDirectory = root;
    windowStyle = 7;
  } else {
    target = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
    shortcutArgs = `"${path.join(root, 'apps', 'desktop')}"`;
    workingDirectory = root;
  }
  if (!fs.existsSync(target)) throw new Error(`启动目标不存在：${target}`);

  writeShortcut(linkPath, target, shortcutArgs, workingDirectory || root, '启动 ReadX 阅读与研究工作区', windowStyle);
  console.log(`icon     ${iconPath}`);
  console.log(`icon src ${source}`);
  console.log(`shortcut ${linkPath}`);
  console.log(`target   ${target} ${shortcutArgs}`.trimEnd());
}

try {
  main();
} catch (error) {
  console.error(`[shortcut] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
