// Deterministic hook/lifecycle regression without a browser or a TeX installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function loadModule(relative, dependencies) {
  const filename = path.join(__dirname, '..', relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const sandbox = { exports: {}, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(source, sandbox, { filename });
  return sandbox.exports;
}

// Model state, refs, dependency changes and effect cleanup; render is explicit so
// each test controls when network replies and autosave/poll timers are delivered.
function mount(relative, exported, api, dependencies = {}, args = ['p']) {
  const slots = [];
  const timers = new Map();
  let nextTimer = 0;
  let cursor = 0;
  let effects = [];
  const changed = (previous, next) => !previous || !next || previous.length !== next.length || next.some((item, i) => !Object.is(item, previous[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }];
    },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useMemo(create, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { value: create(), deps };
      return slots[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) effects.push(() => {
        slots[i]?.cleanup?.();
        slots[i] = { deps, cleanup: effect() };
      });
    },
    lazy: (loader) => ({ loader }),
    Suspense: 'suspense',
  };
  const window_ = {
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const filename = path.join(__dirname, '..', relative);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const sandbox = {
    exports: {}, window: window_,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name.endsWith('/api/client')) return { api, ApiError };
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  vm.runInNewContext(source, sandbox, { filename });
  const render = () => {
    cursor = 0;
    effects = [];
    const current = sandbox.exports[exported](...args);
    for (const effect of effects) effect();
    return current;
  };
  return {
    render, timers,
    async settle() { for (let i = 0; i < 4; i++) { await new Promise(setImmediate); render(); } return render(); },
    async fireTimers() {
      const queued = [...timers];
      for (const [id, callback] of queued) { timers.delete(id); callback(); }
      return this.settle();
    },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function projectApi() {
  const disk = new Map([['main.tex', { path: 'main.tex', content: 'original', revision: 'r0' }]]);
  let revision = 0;
  const api = {
    latexProject: async () => ({ id: 'p', title: 'Paper', mainFile: 'main.tex' }),
    latexTree: async () => ({ nodes: [] }),
    latexIndex: async () => ({ citations: [], labels: [] }),
    latexFile: async (_id, file) => ({ ...disk.get(file) }),
    latexSaveFile: async (_id, file, content, expected) => {
      if (disk.get(file)?.revision !== expected) throw new ApiError('revision conflict', 409);
      const next = `r${++revision}`;
      disk.set(file, { path: file, content, revision: next });
      return { revision: next };
    },
    latexFileOp: async (_id, op) => {
      for (const [file, content] of [...disk]) {
        if (file === op.from || file.startsWith(`${op.from}/`)) {
          const next = op.to + file.slice(op.from.length);
          disk.delete(file);
          disk.set(next, { ...content, path: next });
        }
      }
    },
  };
  return { api, disk };
}

async function openProject(api) {
  const hook = mount('apps/web/src/hooks/useLatexProject.ts', 'useLatexProject', api);
  hook.render();
  await hook.settle();
  await hook.render().openFile('main.tex');
  hook.render();
  return hook;
}

test('leaving during the autosave delay flushes the latest draft', async () => {
  const { api, disk } = projectApi();
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'last paragraph');
  assert.equal(hook.timers.size, 1);
  assert.equal(await hook.render().flushAll(), true);
  hook.unmount();
  assert.equal(hook.timers.size, 0);
  assert.equal(disk.get('main.tex').content, 'last paragraph');
});

test('failed saves block closing, leaving, and renaming without discarding drafts', async () => {
  const { api, disk } = projectApi();
  let operations = 0;
  api.latexSaveFile = async () => { throw new ApiError('external edit', 409); };
  api.latexFileOp = async () => { operations++; };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'keep this draft');
  assert.equal(await hook.render().closeFile('main.tex'), false);
  assert.equal(await hook.render().flushAll(), false);
  assert.equal(await hook.render().applyOp({ op: 'rename', from: 'main.tex', to: 'paper.tex' }), false);
  const file = hook.render().files[0];
  assert.equal(file.content, 'keep this draft');
  assert.equal(file.dirty, true);
  assert.equal(file.conflict, true);
  assert.equal(disk.get('main.tex').content, 'original');
  assert.equal(operations, 0);
  hook.unmount();
});

test('overlapping saves share a request and retain typing during the request', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  const write = api.latexSaveFile;
  let requests = 0;
  api.latexSaveFile = async (...args) => { if (++requests === 1) await gate.promise; return write(...args); };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'first');
  const first = hook.render().saveFile('main.tex');
  hook.render().updateContent('main.tex', 'newest');
  const second = hook.render().saveFile('main.tex');
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(requests, 2); // Two different contents; never two writes using r0.
  assert.equal(disk.get('main.tex').content, 'newest');
  assert.equal(hook.render().files[0].revision, disk.get('main.tex').revision);
  assert.equal(hook.render().files[0].dirty, false);
  hook.unmount();
});

test('renaming saves first and preserves edits arriving while the move is pending', async () => {
  const { api, disk } = projectApi();
  const gate = deferred();
  const entered = deferred();
  const move = api.latexFileOp;
  api.latexFileOp = async (...args) => {
    assert.equal(disk.get('main.tex').content, 'saved before rename');
    entered.resolve();
    await gate.promise;
    return move(...args);
  };
  const hook = await openProject(api);
  hook.render().updateContent('main.tex', 'saved before rename');
  const renaming = hook.render().applyOp({ op: 'rename', from: 'main.tex', to: 'paper.tex' });
  await entered.promise;
  hook.render().updateContent('main.tex', 'typed during rename');
  gate.resolve();
  assert.equal(await renaming, true);
  assert.equal(hook.render().files[0].path, 'paper.tex');
  assert.equal(hook.render().files[0].dirty, true);
  await hook.fireTimers();
  assert.equal(disk.get('paper.tex').content, 'typed during rename');
  assert.equal(disk.has('main.tex'), false);
  hook.unmount();
});

test('force save records the new revision and permits the next normal save', async () => {
  const { api, disk } = projectApi();
  const hook = await openProject(api);
  disk.set('main.tex', { path: 'main.tex', content: 'external', revision: 'external-r' });
  hook.render().updateContent('main.tex', 'mine');
  assert.equal(await hook.render().saveFile('main.tex'), false);
  assert.equal(await hook.render().forceSave('main.tex'), true);
  assert.equal(hook.render().files[0].revision, disk.get('main.tex').revision);
  hook.render().updateContent('main.tex', 'mine again');
  assert.equal(await hook.render().saveFile('main.tex'), true);
  assert.equal(disk.get('main.tex').content, 'mine again');
  hook.unmount();
});

test('completion providers dispose with their project and read the next project index', () => {
  const providers = new Set();
  const monaco = { languages: {
    CompletionItemKind: {}, CompletionItemInsertTextRule: {},
    registerCompletionItemProvider(_id, provider) { providers.add(provider); return { dispose: () => providers.delete(provider) }; },
  } };
  const module_ = loadModule('apps/web/src/lib/latex/latexCompletion.ts', {
    '@cbct/shared': { latexCompletionContext: () => 'cite' },
    './latexLanguage': { LATEX_COMMANDS: [], LATEX_ENVIRONMENTS: [], LATEX_LANGUAGE_ID: 'latex' },
  });
  const first = module_.registerLatexCompletion(monaco, () => ({ citations: ['project-a'], labels: [] }));
  first.dispose();
  let index = { citations: ['project-b'], labels: [] };
  const second = module_.registerLatexCompletion(monaco, () => index);
  index = { citations: ['project-b-updated'], labels: [] };
  assert.equal(providers.size, 1);
  const provider = [...providers][0];
  const suggestions = provider.provideCompletionItems({ getValueInRange: () => '', getWordUntilPosition: () => ({ startColumn: 1, endColumn: 1 }) }, { lineNumber: 1, column: 1 });
  assert.equal(suggestions.suggestions[0].label, 'project-b-updated');
  second.dispose();
  assert.equal(providers.size, 0);
});

test('reopening an active build resumes polling and displays its finished PDF', async () => {
  let current = { id: 'b', status: 'running', hasPdf: false };
  let polls = 0;
  const api = {
    latexToolchains: async () => ({}), latexBuilds: async () => ({ builds: [{ ...current }] }),
    latexBuild: async () => { polls++; return { ...current }; },
  };
  const hook = mount('apps/web/src/hooks/useLatexBuild.ts', 'useLatexBuild', api);
  hook.render();
  await hook.settle();
  assert.ok(polls > 0);
  assert.equal(hook.render().running, true);
  current = { id: 'b', status: 'succeeded', hasPdf: true };
  await hook.fireTimers();
  assert.equal(hook.render().running, false);
  assert.equal(hook.render().build.hasPdf, true);
  assert.equal(hook.timers.size, 0);
  hook.unmount();
});

test('an in-flight build reply cannot restart polling after leaving the project', async () => {
  const gate = deferred();
  const hook = mount('apps/web/src/hooks/useLatexBuild.ts', 'useLatexBuild', {
    latexToolchains: async () => ({}), latexBuilds: async () => ({ builds: [{ id: 'b', status: 'running' }] }),
    latexBuild: () => gate.promise,
  });
  hook.render();
  await hook.settle();
  hook.unmount();
  gate.resolve({ id: 'b', status: 'running' });
  await new Promise(setImmediate);
  assert.equal(hook.timers.size, 0);
});

test('the application keeps LaTeX mounted until its leave guard succeeds', async () => {
  const hook = mount('apps/web/src/App.tsx', 'default', {}, {
    './components/LibraryScreen': { LibraryScreen: 'library' },
    './components/WorkspaceIcon': { WorkspaceIcon: 'icon' },
    './hooks/useWorkspace': { useWorkspace: () => ({ phase: { kind: 'ready', documents: { documents: [] } }, allDocuments: [], filters: {} }) },
    './hooks/useDocument': { useDocument: () => ({ phase: { kind: 'idle' } }) },
    './hooks/useAnnotations': { useAnnotations: () => ({}) },
    './hooks/useLibraryMeta': { useLibraryMeta: () => ({ items: {} }) },
    './hooks/useTheme': { useTheme: () => ({ choice: 'light' }) },
  }, []);
  const header = () => hook.render().props.children[0].props;
  header().onScreen('latex');
  const studio = hook.render().props.children[1].props.children;
  const gate = deferred();
  studio.props.registerBeforeLeave(() => gate.promise);
  header().onScreen('library');
  assert.equal(header().screen, 'latex');
  gate.resolve(false);
  await new Promise(setImmediate);
  assert.equal(header().screen, 'latex');
  studio.props.registerBeforeLeave(async () => true);
  header().onScreen('graph');
  await new Promise(setImmediate);
  assert.equal(header().screen, 'graph');
  hook.unmount();
});
