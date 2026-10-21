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
  updates.install();
  assert.equal((await updates.download()).state, 'error');
  const check = updates.check();
  assert.equal((await updates.download()).state, 'checking');
  pending.resolve({ state: 'unavailable', currentVersion: '0.1.8', version: '0.1.9' });
  await check;
  assert.equal((await updates.download()).state, 'error');
  updates.install();
  assert.equal(calls.download, 0); assert.equal(calls.install, 0);
});

test('downloaded updates survive checks and only install once', async () => {
  const { updates, calls } = controller();
  await updates.check(); await updates.download();
  assert.equal((await updates.check()).state, 'downloaded');
  assert.equal((await updates.download()).state, 'downloaded');
  updates.install(); updates.install();
  assert.equal(calls.install, 1); assert.equal(calls.download, 1); assert.equal(calls.check, 1);
});

test('both synchronous and asynchronous installation errors allow a controlled retry', async () => {
  let attempts = 0;
  const { updates } = controller({ install: () => {
    if (++attempts === 1) throw new Error('Cannot install update');
  } });
  await updates.check(); await updates.download();
  assert.equal(updates.install().operation, 'install');
  updates.install(); assert.equal(attempts, 2);
  updates.onError(new Error('Asynchronous installation failure'));
  assert.equal(updates.getStatus().state, 'error');
  assert.equal(updates.getStatus().operation, 'install');
  updates.install(); assert.equal(attempts, 3);
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
  assert.equal(updates.install().state, 'unsupported');
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
