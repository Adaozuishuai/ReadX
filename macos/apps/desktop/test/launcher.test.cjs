const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { AltHold } = require('../dist/alt-hold.js');

function gesture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const hold = new AltHold({ show: () => calls.push('show'), release: () => calls.push('release'), cancel: () => calls.push('cancel') });
  t.after(() => hold.dispose());
  return { calls, hold, tick: ms => t.mock.timers.tick(ms) };
}
test('holding Alt opens once and releasing selects once', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(259); assert.deepEqual(calls, []);
  hold.press(); tick(1); assert.deepEqual(calls, ['show']);
  hold.release(); hold.release(); assert.deepEqual(calls, ['show', 'release']);
});
test('a tap and Alt+Tab do not launch; a fresh hold still works', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(100); hold.release(); tick(400);
  hold.press(); hold.cancel(); tick(400); hold.release();
  assert.deepEqual(calls, []);
  hold.press(); tick(260); hold.release();
  assert.deepEqual(calls, ['show', 'release']);
});
test('Escape or another shortcut cancels a visible wheel without selecting', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); tick(260); hold.cancel(); hold.release();
  assert.deepEqual(calls, ['show', 'cancel']);
});
test('Alt pressed with Ctrl/Shift/Meta never starts a timer', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(true); tick(500); hold.release(); assert.deepEqual(calls, []);
});
test('disposing a pending gesture cancels its delayed popup', t => {
  const { calls, hold, tick } = gesture(t);
  hold.press(); hold.dispose(); tick(500); assert.deepEqual(calls, []);
});
const geometry = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../web/src/lib/launcherGeometry.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, geometry);
test('all five inner sectors resolve to their workspace; center and gap cancel', () => {
  const { WHEEL_WORKSPACES, wheelPoint, innerWorkspaceAt } = geometry.exports;
  WHEEL_WORKSPACES.forEach((workspace, index) => {
    const point = wheelPoint(-90 + index * 72, 122);
    assert.equal(innerWorkspaceAt(point.x, point.y), workspace.id);
  });
  assert.equal(innerWorkspaceAt(360, 360), null);
  assert.equal(innerWorkspaceAt(540, 360), null);
});
test('outer ring selection follows project sectors for full and partial pages', () => {
  const { projectPlacement, projectSlotAt } = geometry.exports;
  for (const count of [1, 2, 3, 8]) {
    for (let index = 0; index < count; index++) {
      const point = projectPlacement(index, count);
      assert.equal(projectSlotAt(point.x, point.y, count), index);
    }
  }
  assert.equal(projectSlotAt(360, 360, 8), null);
  assert.equal(projectSlotAt(530, 360, 8), null);
  assert.equal(projectSlotAt(640, 360, 8), null);
  assert.equal(projectSlotAt(360, 107, 0), null);
});
