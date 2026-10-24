const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function load(relative, dependencies = {}, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const sandbox = { exports: {}, Blob, File, crypto, Uint8Array, AbortController, AbortSignal, URLSearchParams, setTimeout, clearTimeout, ...globals,
    require: name => { if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`); return dependencies[name]; } };
  vm.runInNewContext(source, sandbox);
  return sandbox.exports;
}
const apiPath = 'apps/web/src/api/bookSources.ts';
const helpers = load('apps/web/src/components/slack/bookImport.ts');
test('rights require download, cache and read; format preference is EPUB then TXT', () => {
  const api = load(apiPath, { './client': {}, '../components/slack/bookImport': helpers });
  for (const access of ['denied', 'unknown']) assert.equal(api.mayDownload({ rights: { access, canDownload: true, canRead: true, canCache: true } }), false);
  for (const field of ['canDownload', 'canCache', 'canRead']) assert.equal(api.mayDownload({ rights: { access: 'allowed', canDownload: true, canRead: true, canCache: true, [field]: false } }), false);
  assert.equal(api.mayDownload({ rights: { access: 'allowed', canDownload: true, canRead: true, canCache: true } }), true);
  assert.equal(JSON.stringify(api.readableFormats({ formats: ['pdf', 'txt', 'epub'] })), '["epub","txt"]');
  const zBook = { providerId: 'zlibrary', requiresRightsConfirmation: true, rights: { access: 'unknown', canDownload: false, canCache: false, canRead: false } };
  assert.equal(api.mayDownload(zBook), false);
  assert.equal(api.mayDownload(zBook, true), true);
  assert.equal(api.mayDownload({ ...zBook, rights: { ...zBook.rights, access: 'denied' } }, true), false);
  assert.equal(api.mayDownload({ ...zBook, providerId: 'gutenberg' }, true), false);
});
test('downloaded blob must match the server SHA256 before import', async () => {
  const blob = new Blob(['A short novel.'], { type: 'text/plain' });
  const api = load(apiPath, { './client': { authenticatedFetch: async () => ({ blob: async () => blob }) }, '../components/slack/bookImport': helpers });
  await assert.rejects(api.bookSources.file({ id: 'a', format: 'txt', sha256: 'wrong' }), /校验/);
  const file = await api.bookSources.file({ id: 'a', format: 'txt', sha256: await helpers.contentHash(blob) });
  assert.equal(await file.text(), 'A short novel.');
});

// Minimal request/transaction semantics to exercise the real IDB module, with
// data cloned as in IndexedDB. Each test gets an isolated database.
function memoryIDB(seed = []) {
  const stores = new Map([['items', new Map(seed.map(item => [item.id, structuredClone(item)]))], ['chapters', new Map()], ['assets', new Map()]]);
  const db = { objectStoreNames: { contains: name => stores.has(name) }, transaction(names) {
    const tx = { pending: 0, objectStore(name) {
      const store = stores.get(name);
      const run = fn => {
        const request = {}; tx.pending++;
        queueMicrotask(() => {
          try { request.result = structuredClone(fn()); request.onsuccess?.(); }
          catch (error) { tx.error = error; tx.onerror?.(); }
          finally { tx.pending--; setTimeout(() => { if (!tx.pending) tx.oncomplete?.(); }, 0); }
        }); return request;
      };
      return {
        getAll: () => run(() => [...store.values()]), get: id => run(() => store.get(id)),
        add: item => run(() => { const key = name === 'chapters' ? item.itemId : item.id; if (store.has(key)) throw new Error('duplicate key'); store.set(key, structuredClone(item)); }),
        put: item => run(() => store.set(item.id, structuredClone(item))),
      };
    }, abort() { tx.onabort?.(); } }; return tx;
  } };
  return { stores, open(_name, version) { assert.equal(version, 1); const request = {}; queueMicrotask(() => { request.result = db; request.onsuccess?.(); }); return request; } };
}
test('legacy shelf entries stay readable; content duplicates preserve ID and progress', async () => {
  const old = { id: 'old', title: 'Legacy', progress: { chapter: 3, page: 0, scroll: .5 }, openedAt: 10, createdAt: 10 };
  const indexedDB = memoryIDB([old]);
  const db = load('apps/web/src/components/slack/db.ts', {}, { indexedDB });
  assert.equal((await db.getItem('old')).progress.chapter, 3);
  const first = { ...old, id: 'first', title: 'New novel', contentSha256: 'same', providerId: 'gutenberg', providerBookId: '11' };
  await db.putLibraryEntry(first, [{ order: 0, title: 'First', text: 'Original text', html: '' }], []);
  const duplicate = await db.putLibraryEntry({ ...first, id: 'copy', progress: { chapter: 0 } }, [{ order: 0, text: 'overwrite' }], []);
  assert.equal(duplicate.id, 'first'); assert.equal(duplicate.progress.chapter, 3);
  assert.equal((await db.getChapters('first'))[0].text, 'Original text');
  assert.equal((await db.listItems()).length, 2);
});

function mountDownload(api, onImport) {
  const effects = []; const states = [];
  const react = { useState: value => { const slot = { value }; states.push(slot); return [value, next => { slot.value = next; }]; }, useRef: value => ({ current: value }), useEffect: effect => effects.push(effect) };
  const module = load('apps/web/src/hooks/useBookDownload.ts', { react, '../api/bookSources': { bookSources: api } });
  const hook = module.useBookDownload(onImport); const cleanups = effects.map(effect => effect());
  return { hook, states, unmount: () => cleanups.forEach(fn => fn?.()) };
}
test('ready task imports once; failed task never imports and can be retried', async () => {
  let imports = 0, starts = 0, cancels = 0;
  const api = { start: async () => { starts++; return { id: 'a', leaseId: 'caller', state: starts === 1 ? 'failed' : 'ready', message: 'upstream failed' }; }, file: async () => new File(['hello'], 'book.txt'), cancel: async () => { cancels++; } };
  const { hook } = mountDownload(api, async () => { imports++; });
  await hook.start({}, 'txt'); assert.equal(imports, 0);
  await hook.start({}, 'txt'); assert.equal(imports, 1); assert.equal(cancels, 2);
});
test('cancel during transfer cleans task and never starts import', async () => {
  let imports = 0, cancels = 0, release;
  const api = { start: () => new Promise(resolve => { release = resolve; }), file: async (_task, signal) => { signal.throwIfAborted(); }, cancel: async () => { cancels++; } };
  const { hook } = mountDownload(api, async () => { imports++; });
  const running = hook.start({}, 'txt'); hook.cancel(); release({ id: 'a', leaseId: 'caller', state: 'ready' }); await running;
  assert.equal(imports, 0); assert.equal(cancels, 1);
});

test('Z-Library authorization is explicit per task and preserved as import provenance', async () => {
  let granted, imported;
  const api = { start: async (_book, _format, _signal, confirmed) => { granted = confirmed; return { id: 'z', leaseId: 'caller', state: 'ready' }; }, file: async () => new File(['novel'], 'book.txt'), cancel: async () => {} };
  const { hook } = mountDownload(api, async (_file, book) => { imported = book; });
  await hook.start({ providerId: 'zlibrary', rights: { access: 'unknown' } }, 'txt', true);
  assert.equal(granted, true); assert.equal(imported.rights.basis, 'user_authorized');
  assert.equal(imported.rights.access, 'unknown');
});

test('unmount and transfer completion release only their own download lease', async () => {
  const released = []; let finishFile;
  const api = {
    start: async () => ({ id: 'shared', leaseId: 'window-a', state: 'ready' }),
    file: () => new Promise(resolve => { finishFile = resolve; }),
    cancel: async (...args) => released.push(args),
  };
  const { hook, unmount } = mountDownload(api, async () => assert.fail('unmounted transfer imported a file'));
  const running = hook.start({}, 'txt');
  await new Promise(setImmediate);
  unmount();
  finishFile(new File(['novel'], 'book.txt'));
  await running;
  assert.deepEqual(released, [['shared', 'window-a'], ['shared', 'window-a']]);
});

test('download cleanup sends the caller lease to the release endpoint', async () => {
  let received;
  const api = load(apiPath, { './client': { request: async (path, options) => { received = { path, options }; } }, '../components/slack/bookImport': helpers });
  await api.bookSources.cancel('shared', 'window-a');
  assert.equal(received.path, '/v1/book-downloads/shared?lease=window-a');
  assert.equal(received.options.method, 'DELETE');
});

function mountComic(count, rtl = false) {
  const slots = []; let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback: fn => fn, useEffect() {},
  };
  const jsx = (type, props) => ({ type, props });
  const module = load('apps/web/src/components/slack/ComicReader.tsx', {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx }, './db': {}, '../../lib/storage': { STORAGE_KEYS: { comicPrefs: 'prefs' } },
  }, { localStorage: { getItem: () => JSON.stringify({ double: true, fit: 'page', rtl }) }, window: { setTimeout: () => 1, clearTimeout() {} } });
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) return node.map(child => find(child, predicate)).find(Boolean);
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  };
  const render = () => { cursor = 0; return module.ComicReader({ item: { progress: { page: 0 }, pageCount: count }, onProgress() {} }); };
  return {
    turn(direction) { find(render(), n => n.props?.className === `slack-comic__zone slack-comic__zone--${direction}`).props.onClick(); },
    jump(page) { find(render(), n => n.type === 'input' && n.props.type === 'range').props.onChange({ target: { value: String(page) } }); },
    page() { return find(render(), n => n.props?.className === 'slack-comic__count').props.children[0]; },
  };
}

test('double-page comics keep pairs aligned at even and odd endings and slider jumps', () => {
  for (const rtl of [false, true]) {
    const next = rtl ? 'left' : 'right', previous = rtl ? 'right' : 'left';
    const even = mountComic(4, rtl);
    assert.equal(even.page(), 1);
    even.turn(next); assert.equal(even.page(), 3);
    even.turn(next); assert.equal(even.page(), 3);
    even.turn(previous); assert.equal(even.page(), 1);
    even.jump(4); assert.equal(even.page(), 3);
    const odd = mountComic(5, rtl);
    odd.turn(next); odd.turn(next); assert.equal(odd.page(), 5);
    odd.turn(previous); assert.equal(odd.page(), 3);
  }
});
