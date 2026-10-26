import type { DesktopUpdateStatus } from '@cbct/shared';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LATEST_RELEASE_URL } from './update-check';
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider';

export const MAC_RELEASES_URL = LATEST_RELEASE_URL.replace(/\/latest$/, '?per_page=100');
export const MAC_PUBLIC_LATEST_URL = 'https://github.com/Leechion/ReadX/releases/latest';
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;
const INSTALL_MESSAGE = '下载校验完成后打开 DMG；退出 ReadX，将新版 ReadX 拖入 Applications 覆盖，再重新打开。';

interface MacInstaller {
  version: string;
  name: string;
  url: string;
  size: number;
  checksum: { algorithm: 'sha256' | 'sha512'; encoding: 'hex' | 'base64'; value: string };
}

interface MacUpdateSelection {
  status: DesktopUpdateStatus;
  installer?: MacInstaller;
}

function stableVersion(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const version = value.replace(/^v/, '');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.test(version)) return;
  return version.split('+')[0]!.split('.').every(part => Number.isSafeInteger(Number(part))) ? version : undefined;
}

function compareVersions(left: string, right: string): number {
  const a = left.split('+')[0]!.split('.').map(Number);
  const b = right.split('+')[0]!.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function assetChecksum(digest: unknown): MacInstaller['checksum'] | undefined {
  if (typeof digest !== 'string') return;
  if (/^sha256:[a-f\d]{64}$/i.test(digest)) return { algorithm: 'sha256', encoding: 'hex', value: digest.slice(7).toLowerCase() };
  if (/^sha512:[A-Za-z0-9+/]{86}==$/.test(digest)) return { algorithm: 'sha512', encoding: 'base64', value: digest.slice(7) };
  return;
}

// GitHub's newest release may be Windows-only. Choose a published, stable DMG
// for this architecture, without depending on latest-mac.yml or Squirrel.Mac.
export function selectMacInstaller(currentVersion: string, arch: string, releases: unknown): MacUpdateSelection {
  const base = { currentVersion, installMode: 'manual-dmg' as const };
  if (!stableVersion(currentVersion) || !Array.isArray(releases)) throw new Error('Invalid release metadata');
  if (arch !== 'arm64' && arch !== 'x64') return {
    status: { ...base, state: 'unavailable', message: '尚未提供当前 Mac 架构的安装包。' },
  };
  const stable = releases.filter((release): release is Record<string, unknown> =>
    !!release && typeof release === 'object' && release.draft === false && release.prerelease === false && !!stableVersion(release.tag_name),
  ).sort((a, b) => compareVersions(stableVersion(b.tag_name)!, stableVersion(a.tag_name)!));
  for (const release of stable) {
    const version = stableVersion(release.tag_name)!;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const targetArch of [arch, 'universal']) {
      const name = `ReadX-${version}-${targetArch}.dmg`;
      const asset = assets.find(value => value && typeof value === 'object' && value.name === name);
      if (!asset) continue;
      const unavailable = (message: string): MacUpdateSelection => ({
        status: { ...base, state: 'unavailable', version, message },
      });
      // Only download assets from this repository, never a URL supplied by notes.
      const expectedURL = `https://github.com/Leechion/ReadX/releases/download/${encodeURIComponent(String(release.tag_name))}/${encodeURIComponent(name)}`;
      const checksum = assetChecksum(asset.digest);
      if (asset.browser_download_url !== expectedURL || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES ||
          !checksum) {
        return unavailable('macOS 安装包缺少可信的下载地址、大小或校验信息，请等待发布者补齐后重试。');
      }
      if (compareVersions(version, currentVersion) <= 0) return { status: {
        ...base, state: 'current', version,
        message: version === currentVersion ? undefined : `最新可用 macOS 安装包为 v${version}，当前版本 v${currentVersion}；不会降级安装。`,
      } };
      return {
        status: { ...base, state: 'available', version, message: INSTALL_MESSAGE,
          releaseNotes: typeof release.body === 'string' ? release.body : undefined },
        installer: { version, name, url: expectedURL, size: asset.size, checksum },
      };
    }
  }
  return { status: { ...base, state: 'unavailable',
    message: `尚未发布适用于${arch === 'arm64' ? ' Apple Silicon' : ' Intel'} Mac 的正式安装包。`,
  } };
}

interface MacInstallerActions {
  currentVersion: string;
  arch: string;
  cacheDir: string;
  fetch(url: string, signal: AbortSignal, redirect?: 'follow' | 'manual'): Promise<Response>;
  openInstaller(file: string): Promise<string>;
  progress(percent: number): void;
}

// Unsigned releases use a verified installer. They must never be presented as a
// restart-and-install update, which Squirrel requires a signing identity for.
export class MacInstallerUpdater {
  private selected?: MacInstaller;
  private downloaded?: { file: string; installer: MacInstaller };
  private checkGeneration = 0;

  constructor(private readonly actions: MacInstallerActions) {}

  async check(): Promise<DesktopUpdateStatus> {
    const generation = ++this.checkGeneration;
    this.selected = undefined;
    const response = await this.actions.fetch(MAC_RELEASES_URL, AbortSignal.timeout(15_000));
    if (response.status === 403 || response.status === 429) {
      await response.body?.cancel().catch(() => {});
      const selection = await this.checkPublicRelease();
      if (generation === this.checkGeneration) this.selected = selection.installer;
      return selection.status;
    }
    if (!response.ok) throw new Error(`Release metadata HTTP ${response.status}`);
    const selection = selectMacInstaller(this.actions.currentVersion, this.actions.arch, await response.json());
    if (generation === this.checkGeneration) this.selected = selection.installer;
    return selection.status;
  }

  private async checkPublicRelease(): Promise<MacUpdateSelection> {
    // The public latest redirect selects a stable release without an API token
    // or shared-IP quota. Do not infer prerelease status from Atom tag spelling.
    const signal = AbortSignal.timeout(15_000);
    const latest = await this.actions.fetch(MAC_PUBLIC_LATEST_URL, signal, 'manual');
    await latest.body?.cancel().catch(() => {});
    const prefix = 'https://github.com/Leechion/ReadX/releases/tag/';
    // Electron net.fetch can return an empty Response.url, including after a
    // redirect. Resolve the explicit Location header instead of trusting it.
    const location = latest.headers.get('location');
    const destination = location ? new URL(location, MAC_PUBLIC_LATEST_URL).href : '';
    const tag = destination.startsWith(prefix) ? decodeURIComponent(destination.slice(prefix.length)) : '';
    const version = stableVersion(tag);
    if (![301, 302, 303, 307, 308].includes(latest.status) || !version) throw new Error('Cannot identify latest public stable release');
    const metadataURL = `https://github.com/Leechion/ReadX/releases/download/${encodeURIComponent(tag)}/latest-mac.yml`;
    const metadata = await this.actions.fetch(metadataURL, signal);
    if (metadata.status === 404) return { status: {
      state: 'unavailable', currentVersion: this.actions.currentVersion, version, installMode: 'manual-dmg',
      message: '最新正式发布尚未提供 macOS 安装包；更新服务器繁忙，请稍后重查。',
    } };
    if (!metadata.ok) throw new Error(`Public update metadata HTTP ${metadata.status}`);
    const info = parseUpdateInfo(await metadata.text(), 'latest-mac.yml', new URL(metadataURL));
    if (info.version !== version || !Array.isArray(info.files)) throw new Error('Public update metadata version mismatch');
    const base = `https://github.com/Leechion/ReadX/releases/download/${encodeURIComponent(tag)}/`;
    const assets = info.files.filter(file => typeof file.url === 'string').map(file => {
      const url = file.url.startsWith(base) ? file.url : base + encodeURIComponent(file.url);
      const name = file.url.startsWith(base) ? decodeURIComponent(file.url.slice(base.length)) : file.url;
      return { name, size: file.size, digest: `sha512:${file.sha512}`, browser_download_url: url };
    });
    return selectMacInstaller(this.actions.currentVersion, this.actions.arch, [{
      tag_name: tag, draft: false, prerelease: false, assets,
      body: `更新说明：${prefix}${encodeURIComponent(tag)}`,
    }]);
  }

  async download(): Promise<void> {
    const installer = this.selected;
    if (!installer) throw new Error('No compatible installer selected');
    this.downloaded = undefined;
    await fs.mkdir(this.actions.cacheDir, { recursive: true, mode: 0o700 });
    const directory = await fs.mkdtemp(path.join(this.actions.cacheDir, 'mac-'));
    const target = path.join(directory, installer.name);
    const partial = `${target}.part`;
    try {
      const response = await this.actions.fetch(installer.url, AbortSignal.timeout(15 * 60_000));
      if (!response.ok || !response.body) throw new Error(`Installer download HTTP ${response.status}`);
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await fs.open(partial, 'wx', 0o600);
      } catch (error) {
        await response.body.cancel().catch(() => {});
        throw error;
      }
      const reader = response.body.getReader();
      const hash = createHash(installer.checksum.algorithm);
      let received = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > installer.size) throw Object.assign(new Error('Installer size exceeds release metadata'), { code: 'ERR_UPDATER_CHECKSUM_MISMATCH' });
          hash.update(value);
          await handle.writeFile(value);
          // 100% means the digest and final file have also been verified.
          this.actions.progress(Math.min(99, received / installer.size * 100));
        }
        if (received !== installer.size || hash.digest(installer.checksum.encoding) !== installer.checksum.value) {
          throw Object.assign(new Error('Installer checksum mismatch'), { code: 'ERR_UPDATER_CHECKSUM_MISMATCH' });
        }
        await handle.sync();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
      await fs.rename(partial, target);
      this.downloaded = { file: target, installer };
      this.actions.progress(100);
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async install(): Promise<void> {
    const download = this.downloaded;
    if (!download) throw new Error('No verified installer downloaded');
    // Recheck on each open; a cached file may have changed since downloading.
    try {
      const stat = await fs.lstat(download.file);
      if (!stat.isFile() || stat.size !== download.installer.size) throw new Error('Installer size mismatch');
      const hash = createHash(download.installer.checksum.algorithm);
      for await (const chunk of createReadStream(download.file)) hash.update(chunk);
      if (hash.digest(download.installer.checksum.encoding) !== download.installer.checksum.value) throw new Error('Installer checksum mismatch');
    } catch {
      throw Object.assign(new Error('Installer is missing or has changed'), { code: 'ERR_MAC_INSTALLER_INTEGRITY' });
    }
    const error = await this.actions.openInstaller(download.file);
    if (error) throw new Error('Unable to open the downloaded DMG');
  }
}
