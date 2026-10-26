const assert = require('node:assert/strict');
const { test } = require('node:test');
const { updateFailureStatus } = require('../dist/update-status.js');
const { checkForUpdateStatus, LATEST_RELEASE_URL } = require('../dist/update-check.js');
const { UpdateController } = require('../dist/update-controller.js');
const { downloadVerifiedUpdate } = require('../dist/update-download.js');
const { EventEmitter } = require('node:events');

test('a Windows-only release is unavailable on macOS, never current', () => {
  const error = Object.assign(new Error('Cannot find latest-mac.yml: HttpError: 404'), {
    code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
  });
  const status = updateFailureStatus(error, '0.1.4', 'check', 'darwin');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.currentVersion, '0.1.4');
  assert.match(status.message, /macOS 更新清单/);
  assert.doesNotMatch(status.message, /HttpError|authentication token|已是最新/);
});

test('a repository without public releases does not claim to be up to date', () => {
  for (const code of ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS']) {
    const status = updateFailureStatus({ code }, '0.1.4', 'check', 'win32');
    assert.equal(status.state, 'unavailable');
    assert.match(status.message, /Windows/);
  }
});

test('network failure remains retryable and does not imply missing releases', () => {
  const status = updateFailureStatus(new Error('net::ERR_NAME_NOT_RESOLVED'), '0.1.4', 'check', 'darwin');
  assert.equal(status.state, 'error');
  assert.match(status.message, /检查更新.*网络/);
});

test('download errors identify the download operation', () => {
  const status = updateFailureStatus({ code: 'ETIMEDOUT' }, '0.1.4', 'download', 'win32');
  assert.equal(status.state, 'error');
  assert.match(status.message, /下载更新.*网络/);
  const missing = updateFailureStatus({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }, '0.1.4', 'download', 'darwin');
  assert.equal(missing.state, 'error');
});

test('unexpected failures stay errors without exposing raw server responses', () => {
  for (const error of [new Error('HTTP 403 response headers and stack trace'), null, 'unknown failure']) {
    const status = updateFailureStatus(error, '0.1.4', 'check', 'darwin');
    assert.equal(status.state, 'error');
    assert.doesNotMatch(status.message, /HTTP|headers|stack|unknown/);
  }
});

test('a directory-only package identifies its missing updater configuration', () => {
  const error = Object.assign(new Error("ENOENT: open '/Resources/app-update.yml'"), { code: 'ENOENT' });
  assert.equal(updateFailureStatus(error, '0.1.8', 'check', 'darwin').state, 'unavailable');
  assert.match(updateFailureStatus(error, '0.1.8', 'check', 'darwin').message, /安装包缺少更新配置/);
  assert.equal(updateFailureStatus({ code: 'ENOENT' }, '0.1.8', 'check', 'darwin').state, 'error');
});

test('release lookup uses the same repository as both platform publishers', () => {
  for (const file of ['../package.json', '../../../../windows/apps/desktop/package.json', '../../../../macos/apps/desktop/package.json']) {
    const { owner, repo } = require(file).build.publish[0];
    assert.equal(LATEST_RELEASE_URL, `https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  }
});

test('successful checks retain the remote version and release notes, including no-update results', async () => {
  for (const [current, remote, available] of [['0.1.7', '0.1.8', true], ['0.1.8', '0.1.8', false], ['0.1.9', '0.1.8', false]]) {
    const status = await checkForUpdateStatus(current, async () => ({
      isUpdateAvailable: available,
      updateInfo: { version: remote, releaseNotes: 'Version changes' },
    }), async () => { throw new Error('Should not look up a fallback on success'); }, 'darwin');
    assert.equal(status.state, available ? 'available' : 'current');
    assert.equal(status.currentVersion, current);
    assert.equal(status.version, remote);
    assert.equal(status.releaseNotes, 'Version changes');
  }
});

test('Windows-only releases still show their published version on Mac without enabling an update', async () => {
  for (const current of ['0.1.7', '0.1.8', '0.1.9']) {
    const status = await checkForUpdateStatus(current, async () => {
      throw { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' };
    }, async () => ({ tag_name: 'v0.1.8', draft: false, prerelease: false, body: 'Changes', assets: [{ name: 'latest.yml' }] }), 'darwin');
    assert.equal(status.state, 'unavailable');
    assert.equal(status.version, '0.1.8');
    assert.equal(status.currentVersion, current);
    assert.match(status.message, /macOS 更新清单/);
  }
});

test('missing local configuration also permits a read-only latest-version lookup', async () => {
  const status = await checkForUpdateStatus('0.1.8', async () => {
    throw Object.assign(new Error('open app-update.yml'), { code: 'ENOENT' });
  }, async () => ({ tag_name: 'v0.1.8' }), 'darwin');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.version, '0.1.8');
  assert.match(status.message, /缺少更新配置/);
});

test('fallback failures and invalid releases never invent a latest version', async () => {
  const check = async () => { throw { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }; };
  for (const release of [null, {}, { tag_name: 'nightly' }, { tag_name: 'v0.2.0-beta.1' }, { tag_name: 'v0.2.0', draft: true }, { tag_name: 'v0.2.0', prerelease: true }]) {
    const status = await checkForUpdateStatus('0.1.8', check, async () => release, 'darwin');
    assert.equal(status.state, 'unavailable');
    assert.equal(status.version, undefined);
  }
  for (const error of [new Error('HTTP 403 private response'), new Error('net::ERR_TIMED_OUT')]) {
    const status = await checkForUpdateStatus('0.1.8', check, async () => { throw error; }, 'darwin');
    assert.equal(status.state, 'unavailable');
    assert.equal(status.version, undefined);
    assert.match(status.message, /未能获取最新发布版本/);
    assert.doesNotMatch(status.message, /HTTP|private|ERR_TIMED_OUT/);
  }
});

test('ordinary network errors stay retryable without consulting a different release endpoint', async () => {
  const status = await checkForUpdateStatus('0.1.8', async () => {
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  }, async () => { throw new Error('Unexpected fallback'); }, 'darwin');
  assert.equal(status.state, 'error');
  assert.equal(status.version, undefined);
  assert.match(status.message, /网络/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const available = { state: 'available', currentVersion: '0.1.8', version: '0.1.9', releaseNotes: 'Changes' };
function controller(overrides = {}) {
  const events = [];
  const calls = { check: 0, download: 0, install: 0 };
  const actions = {
    currentVersion: '0.1.8', supported: true,
    check: async () => { calls.check++; return available; },
    download: async () => { calls.download++; },
    install: () => { calls.install++; },
    publish: status => events.push(status), ...overrides,
  };
  return { updates: new UpdateController(actions), events, calls };
}

test('concurrent checks share one request; snapshots cannot mutate main-process state', async () => {
  const pending = deferred(); let calls = 0;
  const { updates } = controller({ check: () => { calls++; return pending.promise; } });
  const first = updates.check(); const second = updates.check();
  assert.equal(first, second);
  assert.equal(updates.getStatus().state, 'checking');
  updates.getStatus().state = 'downloaded';
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.resolve(available);
  assert.equal((await first).state, 'available');
});

test('checks and duplicate download clicks cannot replace an active download', async () => {
  const pending = deferred(); let downloads = 0;
  const { updates, events } = controller({ download: () => { downloads++; return pending.promise; } });
  await updates.check();
  const first = updates.download(); const second = updates.download();
  assert.equal(first, second);
  assert.equal((await updates.check()).state, 'downloading');
  assert.equal(downloads, 1);
  for (const value of [25, NaN, Infinity, -1, 10, 250]) updates.onProgress(value);
  assert.deepEqual(events.filter(s => s.state === 'downloading').map(s => s.percent), [0, 25, 25, 25, 100]);
  pending.resolve([]);
  assert.equal((await first).state, 'downloaded');
  updates.onProgress(1);
  assert.equal(updates.getStatus().state, 'downloaded');
});

test('download errors retain the selected version and can retry without a new check', async () => {
  let attempts = 0;
  const { updates, calls } = controller({ download: async () => {
    if (++attempts === 1) throw new Error('net::ERR_CONNECTION_RESET');
  } });
  await updates.check();
  const failure = await updates.download();
  assert.equal(failure.state, 'error'); assert.equal(failure.operation, 'download');
  assert.equal(failure.version, '0.1.9'); assert.equal(failure.releaseNotes, 'Changes');
  assert.equal((await updates.download()).state, 'downloaded');
  assert.equal(calls.check, 1); assert.equal(attempts, 2);
});

test('download and installation are blocked until their prerequisites are met', async () => {
  const pending = deferred(); const { updates, calls } = controller({ check: () => pending.promise });
  await updates.install();
  assert.equal((await updates.download()).state, 'error');
  const check = updates.check();
  assert.equal((await updates.download()).state, 'checking');
  pending.resolve({ state: 'unavailable', currentVersion: '0.1.8', version: '0.1.9' });
  await check;
  assert.equal((await updates.download()).state, 'error');
  await updates.install();
  assert.equal(calls.download, 0); assert.equal(calls.install, 0);
});

test('downloaded updates survive checks and only install once', async () => {
  const { updates, calls } = controller();
  await updates.check(); await updates.download();
  assert.equal((await updates.check()).state, 'downloaded');
  assert.equal((await updates.download()).state, 'downloaded');
  await Promise.all([updates.install(), updates.install()]);
  assert.equal(calls.install, 1); assert.equal(calls.download, 1); assert.equal(calls.check, 1);
});

test('both synchronous and asynchronous installation errors allow a controlled retry', async () => {
  let attempts = 0;
  const { updates } = controller({ install: () => {
    if (++attempts === 1) throw new Error('Cannot install update');
  } });
  await updates.check(); await updates.download();
  assert.equal((await updates.install()).operation, 'install');
  await updates.install(); assert.equal(attempts, 2);
  updates.onError(new Error('Asynchronous installation failure'));
  assert.equal(updates.getStatus().state, 'error');
  assert.equal(updates.getStatus().operation, 'install');
  await updates.install(); assert.equal(attempts, 3);
});

test('check timeout is retryable and late results cannot overwrite a newer check', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const old = deferred(); let attempts = 0;
  const { updates } = controller({ checkTimeoutMs: 100, check: () => ++attempts === 1 ? old.promise : Promise.resolve(available) });
  const first = updates.check(); await Promise.resolve();
  t.mock.timers.tick(100);
  const failure = await first;
  assert.equal(failure.state, 'error'); assert.match(failure.message, /网络/);
  await updates.check();
  old.resolve({ state: 'current', currentVersion: '0.1.8', version: '0.1.8' });
  await Promise.resolve();
  assert.equal(updates.getStatus().state, 'available');
  assert.equal(updates.getStatus().version, '0.1.9');
});

test('unsupported builds do not invoke any updater actions', async () => {
  const { updates, calls } = controller({ supported: false });
  assert.equal((await updates.check()).state, 'unsupported');
  assert.equal((await updates.download()).state, 'unsupported');
  assert.equal((await updates.install()).state, 'unsupported');
  assert.deepEqual(calls, { check: 0, download: 0, install: 0 });
});

test('plain structured errors, timeout errors and invalid results remain safe', async () => {
  const { releaseNotesText } = require('../dist/update-check.js');
  assert.match(updateFailureStatus({ message: 'net::ERR_NAME_NOT_RESOLVED' }, '0.1.8', 'check').message, /网络/);
  assert.match(updateFailureStatus(new Error('TimeoutError'), '0.1.8', 'check').message, /网络/);
  for (const value of [null, {}, { updateInfo: { version: '0.1.9' } }, { isUpdateAvailable: false, updateInfo: {} }]) {
    assert.equal((await checkForUpdateStatus('0.1.8', async () => value, async () => null)).state, 'error');
  }
  assert.equal(releaseNotesText([null, 42, { note: 4 }, { version: '0.1.9', note: ' Changes ' }]), 'v0.1.9\nChanges');
});

test('Mac download waits for native readiness even after the ZIP transfer finishes', async () => {
  const source = new EventEmitter(); source.downloadUpdate = async () => [];
  let settled = false;
  const pending = downloadVerifiedUpdate(source).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  source.emit('update-downloaded', { version: '0.1.9' });
  await pending;
  assert.equal(settled, true);
  assert.equal(source.listenerCount('update-downloaded'), 0);
  assert.equal(source.listenerCount('error'), 0);
});

test('native readiness before transfer completion still waits for transfer verification', async () => {
  const source = new EventEmitter(); const transfer = deferred();
  source.downloadUpdate = () => transfer.promise;
  let settled = false;
  const pending = downloadVerifiedUpdate(source).then(() => { settled = true; });
  source.emit('update-downloaded'); await Promise.resolve();
  assert.equal(settled, false);
  transfer.resolve([]); await pending;
  assert.equal(settled, true);
});

test('transfer and native verification failures reject and clean up listeners', async () => {
  for (const mode of ['native', 'transfer', 'throw']) {
    const source = new EventEmitter();
    source.downloadUpdate = () => {
      if (mode === 'throw') throw new Error('sync failure');
      return mode === 'transfer' ? Promise.reject(new Error('transfer failure')) : Promise.resolve([]);
    };
    const pending = downloadVerifiedUpdate(source);
    if (mode === 'native') source.emit('error', new Error('signature rejected'));
    await assert.rejects(pending);
    assert.equal(source.listenerCount('update-downloaded'), 0);
    assert.equal(source.listenerCount('error'), 0);
  }
});

const { MacInstallerUpdater, selectMacInstaller, MAC_RELEASES_URL } = require('../dist/mac-installer-update.js');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const installerBytes = Buffer.from('isolated installer download fixture');
function macRelease(version = '0.1.9', arch = 'arm64', overrides = {}) {
  const name = `ReadX-${version}-${arch}.dmg`;
  return {
    tag_name: `v${version}`, draft: false, prerelease: false, body: 'Mac changes',
    assets: [{ name, size: installerBytes.length, digest: `sha256:${createHash('sha256').update(installerBytes).digest('hex')}`,
      browser_download_url: `https://github.com/Leechion/ReadX/releases/download/v${version}/${name}` }],
    ...overrides,
  };
}

test('Mac lookup skips newer Windows-only releases and matches the hardware architecture', () => {
  const releases = [macRelease('1.0.1', 'arm64', { assets: [{ name: 'latest.yml' }] }), macRelease('0.1.9'), macRelease('0.1.8')];
  const selected = selectMacInstaller('0.1.8', 'arm64', releases);
  assert.equal(selected.status.state, 'available');
  assert.equal(selected.status.version, '0.1.9');
  assert.equal(selected.status.installMode, 'manual-dmg');
  assert.match(selected.installer.url, /ReadX-0\.1\.9-arm64\.dmg$/);
  assert.equal(selectMacInstaller('0.1.8', 'x64', releases).status.state, 'unavailable');
  assert.equal(selectMacInstaller('0.1.8', 'x64', [macRelease('0.1.9', 'universal')]).status.state, 'available');
  assert.equal(selectMacInstaller('0.1.8', 'unsupported', releases).status.state, 'unavailable');
  assert.match(MAC_RELEASES_URL, /Leechion\/ReadX\/releases\?per_page=100$/);
});

test('Mac selection compares stable versions numerically and never downgrades', () => {
  const releases = [macRelease('1.0.9'), macRelease('1.0.10'), macRelease('2.0.0', 'arm64', { draft: true }), macRelease('3.0.0', 'arm64', { prerelease: true })];
  assert.equal(selectMacInstaller('1.0.9', 'arm64', releases).status.version, '1.0.10');
  assert.equal(selectMacInstaller('1.0.10', 'arm64', releases).status.state, 'current');
  const newer = selectMacInstaller('2.0.0', 'arm64', releases);
  assert.equal(newer.status.state, 'current');
  assert.match(newer.status.message, /不会降级/);
  assert.equal(newer.installer, undefined);
  for (const metadata of [null, {}, 'invalid']) assert.throws(() => selectMacInstaller('0.1.8', 'arm64', metadata));
  assert.equal(selectMacInstaller('0.1.8', 'arm64', [macRelease('1.0.0-beta.1')]).status.state, 'unavailable');
});

test('Mac selection rejects missing digests, wrong repositories and invalid sizes', () => {
  for (const patch of [
    { digest: null }, { digest: 'sha256:bad' }, { size: 0 }, { size: 3 * 1024 ** 3 },
    { browser_download_url: 'https://example.com/ReadX.dmg' },
    { browser_download_url: 'https://github.com/another/repo/releases/download/v0.1.9/ReadX-0.1.9-arm64.dmg' },
  ]) {
    const release = macRelease(); Object.assign(release.assets[0], patch);
    const selection = selectMacInstaller('0.1.8', 'arm64', [release]);
    assert.equal(selection.status.state, 'unavailable');
    assert.equal(selection.installer, undefined);
  }
});

async function installerFixture(t, overrides = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readx-installer-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const calls = []; const opened = []; const progress = [];
  const updater = new MacInstallerUpdater({
    currentVersion: '0.1.8', arch: 'arm64', cacheDir,
    fetch: async (url, signal) => {
      assert.ok(signal instanceof AbortSignal);
      calls.push(url);
      return url === MAC_RELEASES_URL ? Response.json([macRelease()]) : new Response(installerBytes);
    },
    openInstaller: async file => { opened.push(file); return ''; },
    progress: percent => progress.push(percent),
    ...overrides,
  });
  return { updater, cacheDir, calls, opened, progress };
}

test('Mac installer is streamed, verified and rechecked before opening; it can reopen without quitting', async t => {
  const { updater, cacheDir, calls, opened, progress } = await installerFixture(t);
  await assert.rejects(updater.download(), /No compatible installer/);
  await assert.rejects(updater.install(), /No verified installer/);
  assert.equal((await updater.check()).state, 'available');
  await updater.download();
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.slice(0, -1).every(value => value < 100));
  await updater.install(); await updater.install();
  assert.equal(opened.length, 2);
  assert.ok(opened[0].startsWith(cacheDir + path.sep));
  assert.deepEqual(await fs.readFile(opened[0]), installerBytes);
  assert.equal(calls.length, 2);
  assert.equal((await fs.readdir(path.dirname(opened[0]))).length, 1);
});

test('Mac truncated, oversized, corrupted and failed downloads are removed and never offered for installation', async t => {
  for (const payload of [installerBytes.subarray(1), Buffer.concat([installerBytes, Buffer.from('x')]), Buffer.alloc(installerBytes.length), null]) {
    const fixture = await installerFixture(t, {
      fetch: async url => url === MAC_RELEASES_URL ? Response.json([macRelease()]) : payload === null ? new Response('failed', { status: 500 }) : new Response(payload),
    });
    await fixture.updater.check();
    await assert.rejects(fixture.updater.download());
    assert.deepEqual(await fs.readdir(fixture.cacheDir), []);
    await assert.rejects(fixture.updater.install());
    assert.equal(fixture.opened.length, 0);
    assert.ok(!fixture.progress.includes(100));
  }
});

test('Mac cached installer tampering or deletion prevents opening', async t => {
  for (const mode of ['changed', 'deleted']) {
    const { updater, cacheDir, opened } = await installerFixture(t);
    await updater.check(); await updater.download();
    const directory = path.join(cacheDir, (await fs.readdir(cacheDir))[0]);
    const file = path.join(directory, (await fs.readdir(directory))[0]);
    if (mode === 'changed') await fs.writeFile(file, Buffer.alloc(installerBytes.length)); else await fs.unlink(file);
    await assert.rejects(updater.install(), { code: 'ERR_MAC_INSTALLER_INTEGRITY' });
    assert.equal(opened.length, 0);
  }
});

test('async installer launch errors are visible and duplicate launches share one operation', async () => {
  const launch = deferred(); let launches = 0;
  const manual = { ...available, installMode: 'manual-dmg' };
  const { updates } = controller({ check: async () => manual, install: () => { launches++; return launch.promise; } });
  await updates.check(); await updates.download();
  const first = updates.install(), second = updates.install();
  assert.equal(first, second); assert.equal(launches, 1);
  launch.reject(new Error('Cannot open DMG'));
  assert.equal((await first).operation, 'install');
  const retry = updates.install(); await retry;
  assert.equal(launches, 2);
});

test('Mac open failures allow retry and successful launches do not quit or block reopening', async t => {
  let attempts = 0;
  const fixture = await installerFixture(t, { openInstaller: async () => ++attempts === 1 ? 'OS open failed' : '' });
  const { updates } = controller({ check: () => fixture.updater.check(), download: () => fixture.updater.download(), install: () => fixture.updater.install() });
  await updates.check(); await updates.download();
  assert.equal((await updates.install()).operation, 'install');
  assert.equal((await updates.install()).state, 'downloaded');
  // Successful retry must clear the previous error and remain reopenable.
  assert.equal((await updates.install()).state, 'downloaded');
  assert.equal(attempts, 3);
});

test('Mac missing cached installers return to download, rather than retrying a broken install forever', async () => {
  let installs = 0;
  const { updates, calls } = controller({ check: async () => ({ ...available, installMode: 'manual-dmg' }), install: async () => {
    installs++;
    throw Object.assign(new Error('Missing installer'), { code: 'ERR_MAC_INSTALLER_INTEGRITY' });
  } });
  await updates.check(); await updates.download();
  assert.equal((await updates.install()).operation, 'download');
  await updates.install(); assert.equal(installs, 1);
  assert.equal((await updates.download()).state, 'downloaded');
  assert.equal(calls.download, 2);
});

function publicReleaseResponse(version = '0.1.9') {
  return new Response(null, { status: 302, headers: { location: `/Leechion/ReadX/releases/tag/v${version}` } });
}
function publicMacMetadata(version = '0.1.9', overrides = {}) {
  const info = { version, files: [{ url: `ReadX-${version}-arm64.dmg`, size: installerBytes.length,
    sha512: createHash('sha512').update(installerBytes).digest('base64'), ...overrides }] };
  // JSON is also valid YAML and exercises the same installed updater parser.
  return new Response(JSON.stringify(info));
}

test('Mac API rate limits use the public stable release and SHA-512 manifest without an API token', async t => {
  const { MAC_PUBLIC_LATEST_URL } = require('../dist/mac-installer-update.js');
  for (const status of [403, 429]) {
    const calls = [];
    const fixture = await installerFixture(t, { fetch: async url => {
      calls.push(url);
      if (url === MAC_RELEASES_URL) return new Response('rate limit', { status });
      if (url === MAC_PUBLIC_LATEST_URL) return publicReleaseResponse();
      if (url.endsWith('/latest-mac.yml')) return publicMacMetadata();
      return new Response(installerBytes);
    } });
    const result = await fixture.updater.check();
    assert.equal(result.state, 'available'); assert.equal(result.version, '0.1.9');
    await fixture.updater.download(); await fixture.updater.install();
    assert.equal(fixture.opened.length, 1);
    assert.equal(calls.filter(url => url.startsWith('https://api.github.com/')).length, 1);
  }
});

test('public Mac fallback rejects untrusted redirects, mismatched versions and invalid checksums', async t => {
  const { MAC_PUBLIC_LATEST_URL } = require('../dist/mac-installer-update.js');
  for (const mode of ['redirect', 'version', 'checksum', 'size', 'url']) {
    const fixture = await installerFixture(t, { fetch: async url => {
      if (url === MAC_RELEASES_URL) return new Response('rate limit', { status: 403 });
      if (url === MAC_PUBLIC_LATEST_URL) {
        if (mode === 'redirect') {
          const response = publicReleaseResponse(); response.headers.set('location', 'https://example.com/v0.1.9'); return response;
        }
        return publicReleaseResponse();
      }
      return publicMacMetadata(mode === 'version' ? '1.0.0' : '0.1.9', mode === 'checksum' ? { sha512: 'bad' } : mode === 'size' ? { size: 0 } : mode === 'url' ? { url: 'https://example.com/ReadX-0.1.9-arm64.dmg' } : {});
    } });
    if (mode === 'redirect' || mode === 'version') await assert.rejects(fixture.updater.check());
    else assert.equal((await fixture.updater.check()).state, 'unavailable');
    await assert.rejects(fixture.updater.download());
  }
});

test('public latest releases without Mac metadata stay unavailable rather than enabling a Windows update', async t => {
  const { MAC_PUBLIC_LATEST_URL } = require('../dist/mac-installer-update.js');
  const fixture = await installerFixture(t, { fetch: async url => {
    if (url === MAC_RELEASES_URL) return new Response('', { status: 403 });
    if (url === MAC_PUBLIC_LATEST_URL) return publicReleaseResponse('1.0.1');
    return new Response('not found', { status: 404 });
  } });
  const status = await fixture.updater.check();
  assert.equal(status.state, 'unavailable'); assert.equal(status.version, '1.0.1');
  await assert.rejects(fixture.updater.download());
});

const { createUpdateFetcher } = require('../dist/update-fetch.js');
test('Electron manual redirects expose Location and tolerate abort errors after resolution', async () => {
  const request = new EventEmitter(); let aborted = 0;
  request.setHeader = () => {};
  request.abort = () => { aborted++; request.emit('error', new Error('Redirect was cancelled')); };
  request.end = () => request.emit('redirect', 302, 'GET', 'https://github.com/Leechion/ReadX/releases/tag/v1.0.1');
  const fetch = createUpdateFetcher({ request: () => request, fetch: () => { throw new Error('Must not use net.fetch for manual redirects'); } });
  const response = await fetch('https://github.com/Leechion/ReadX/releases/latest', new AbortController().signal, 'manual');
  assert.equal(response.url, '');
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /tag\/v1.0.1$/);
  assert.equal(aborted, 1);
});

test('Electron redirect probes abort on timeout and ordinary payloads keep Chromium fetch', async () => {
  for (const alreadyAborted of [false, true]) {
    const request = new EventEmitter(); request.setHeader = () => {}; request.end = () => {};
    let aborted = 0; request.abort = () => { aborted++; };
    const control = new AbortController(); if (alreadyAborted) control.abort(new Error('timeout'));
    const fetch = createUpdateFetcher({ request: () => request, fetch: async url => new Response(url) });
    const pending = fetch('https://github.com/Leechion/ReadX/releases/latest', control.signal, 'manual');
    if (!alreadyAborted) control.abort(new Error('timeout'));
    await assert.rejects(pending, /timeout/); assert.equal(aborted, 1);
    assert.equal(await (await fetch('https://example.com/fixture', new AbortController().signal)).text(), 'https://example.com/fixture');
  }
});
