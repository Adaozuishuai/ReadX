// Test the shipped React update control in real Chromium with an injected bridge.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateControl, ReleaseNotesContent } from '../apps/web/src/components/LibraryScreen';

const root = createRoot(document.getElementById('root'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate, message = 'Update UI did not settle') {
  const deadline = performance.now() + 3000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error(message); await wait(); }
}
const button = () => document.querySelector('.sidebar-update-button');
const label = () => button()?.textContent;
const available = { state: 'available', currentVersion: '0.1.8', version: '0.1.9', releaseNotes: '<h3>New features</h3><p>Changes</p>' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function mount(status, overrides = {}) {
  root.render(null);
  await until(() => !button());
  const listeners = new Set();
  const calls = { check: 0, download: 0, install: 0 };
  window.__READX_DESKTOP_UPDATES__ = {
    getStatus: async () => status,
    check: async () => { calls.check++; return { state: 'current', currentVersion: '0.1.8', version: '0.1.8' }; },
    download: async () => { calls.download++; return { ...available, state: 'downloaded' }; },
    install: async () => { calls.install++; return { ...available, state: 'downloaded' }; },
    onStatus: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    ...overrides,
  };
  root.render(<UpdateControl />);
  await until(() => listeners.size === 1);
  await wait();
  return { calls, listeners, emit: next => listeners.forEach(listener => listener(next)) };
}

window.runUpdateSmoke = async () => {
  const passed = [];
  await mount({ state: 'current', currentVersion: '0.1.8', version: '0.1.8' });
  assert(label().includes('已是最新版本 · v0.1.8'), 'Remote version must be visible');
  passed.push('current version is restored from main-process state');

  await mount({ state: 'current', currentVersion: '0.1.9', version: '0.1.8' });
  assert(!label().includes('已是最新'), 'Local newer build must not mislabel the remote version');
  assert(document.body.textContent.includes('更新源最新版本 v0.1.8'), 'Remote version missing for a newer local build');
  passed.push('newer local builds show both versions accurately');

  await mount({ state: 'unavailable', currentVersion: '0.1.8', version: '0.1.9', message: 'macOS 更新清单尚未发布' });
  assert(label().includes('最新发布 · v0.1.9'), 'Missing feed must retain latest public version');
  assert(document.body.textContent.includes('当前版本 v0.1.8'), 'Missing current version');
  assert(!document.querySelector('dialog').open, 'Unavailable releases must not offer installation');
  passed.push('missing platform feeds show versions without offering an update');

  const pending = deferred();
  const checking = await mount({ state: 'idle' }, { check: () => { checking.calls.check++; return pending.promise; } });
  button().click();
  await until(() => button().disabled);
  button().click(); assert(checking.calls.check === 1, 'Double click must not check twice');
  pending.resolve(available);
  await until(() => document.querySelector('dialog').open);
  assert(document.querySelector('.update-release-notes').textContent.includes('New features'), 'Release notes missing');
  checking.emit({ state: 'checking', currentVersion: '0.1.8' });
  await until(() => !document.querySelector('dialog').open);
  passed.push('checking disables repeated clicks and closes stale confirmation dialogs');

  const downloading = await mount({ ...available, state: 'downloading', percent: 42 });
  assert(button().disabled && label().includes('42%'), 'Reload must retain active download and progress');
  downloading.emit({ ...available, state: 'error', operation: 'download', message: '下载失败' });
  await until(() => !button().disabled);
  button().click();
  await until(() => label().includes('重启并安装'));
  assert(downloading.calls.download === 1 && downloading.calls.check === 0, 'Download retry must not restart checking');
  passed.push('downloads recover on remount and retry the failed operation');

  const installing = await mount({ ...available, state: 'error', operation: 'install', message: '安装失败' });
  button().click();
  await until(() => installing.calls.install === 1);
  assert(installing.calls.check === 0 && installing.calls.download === 0, 'Install retry must not download again');
  passed.push('installation failures retry the already-downloaded update');

  const snapshot = deferred();
  const race = await mount({ state: 'idle' }, { getStatus: () => snapshot.promise });
  race.emit({ ...available, state: 'downloading', percent: 64 });
  await until(() => label().includes('64%'));
  snapshot.resolve({ state: 'idle' });
  await wait();
  assert(label().includes('64%'), 'Stale snapshot overwrote live progress');
  root.render(null); await until(() => !button());
  assert(race.listeners.size === 0, 'Unmount leaked update subscriptions');
  passed.push('live events win snapshot races and subscriptions are cleaned up');

  await mount({ state: 'idle' }, { getStatus: async () => { throw new Error('IPC unavailable'); } });
  await until(() => label().includes('更新失败'));
  assert(document.body.textContent.includes('无法读取更新状态'), 'Snapshot failure must be actionable');
  passed.push('IPC snapshot errors stay visible and retryable');

  root.render(<ReleaseNotesContent value={'<h3>Safe notes</h3><script>window.__unsafe=1</script><img src=x onerror="window.__unsafe=2"><a href="javascript:alert(1)">unsafe link</a><a href="https://example.com" onclick="window.__unsafe=3">valid link</a><iframe src="https://example.com"></iframe>'} />);
  await until(() => !button() && document.querySelector('.update-release-notes-content')?.textContent.includes('Safe notes'));
  assert(!document.querySelector('.update-release-notes-content').querySelector('script,img,iframe,[onclick],[onerror]'), 'Unsafe release markup survived');
  const link = document.querySelector('.update-release-notes-content a');
  assert(link?.href === 'https://example.com/' && link.rel.includes('noopener'), 'Valid release links must remain safe');
  assert(!window.__unsafe, 'Release markup executed');
  passed.push('release notes preserve allowed content and discard executable markup');
  root.render(null);
  delete window.__READX_DESKTOP_UPDATES__;
  return passed;
};
