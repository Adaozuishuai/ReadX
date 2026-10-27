const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const react = {
  useState: value => [value, () => {}],
  useRef: value => ({ current: value }),
  useEffect: () => {},
};
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const source = fs.readFileSync(path.join(__dirname, '../apps/web/src/components/MarginNote.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const sandbox = { exports: {}, Math, require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : (() => { throw Error(name); })() };
vm.runInNewContext(code, sandbox);
const { MarginNote, initialMarginRect } = sandbox.exports;

function harness() {
  const saved = { x: 0.2, y: 0.25, width: 0.3, height: 0.2 };
  const item = { id: 'n', note: '想法', color: 'sky', locator: { kind: 'pdf', rects: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.02 }], noteRect: saved } };
  const commits = [], edits = [];
  const node = MarginNote({ item, fontSize: 14, focused: false, onEdit: value => edits.push(value), onGeometry: async (_, rect) => { commits.push(rect); } });
  const currentTarget = { parentElement: { getBoundingClientRect: () => ({ width: 1000, height: 500 }) }, setPointerCapture: () => {}, hasPointerCapture: () => true, releasePointerCapture: () => {} };
  const event = (x, y, resize = false) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, target: { closest: () => resize ? {} : null }, currentTarget, preventDefault() {}, stopPropagation() {} });
  return { node, event, commits, edits };
}

test('drag moves the note using page-relative coordinates and clamps at the page edge', () => {
  const h = harness();
  h.node.props.onPointerDown(h.event(200, 100));
  h.node.props.onPointerMove(h.event(1100, 900));
  h.node.props.onPointerUp(h.event(1100, 900));
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0].x, 0.7);
  assert.equal(h.commits[0].y, 0.8);
  assert.equal(h.commits[0].width, 0.3);
  assert.equal(h.edits.length, 0);
});

test('resize changes size, cancellation discards changes, click opens editing', () => {
  let h = harness();
  h.node.props.onPointerDown(h.event(200, 100, true));
  h.node.props.onPointerMove(h.event(400, 150, true));
  h.node.props.onPointerUp(h.event(400, 150, true));
  assert.equal(h.commits[0].width, 0.5);
  assert.ok(Math.abs(h.commits[0].height - 0.3) < 1e-9);
  h = harness();
  h.node.props.onPointerDown(h.event(200, 100));
  h.node.props.onPointerMove(h.event(300, 100));
  h.node.props.onPointerCancel(h.event(300, 100));
  assert.equal(h.commits.length, 0);
  h.node.props.onPointerDown(h.event(200, 100));
  h.node.props.onPointerUp(h.event(200, 100));
  assert.equal(h.edits.length, 1);
});

test('short notes start compact; longer and multiline notes get room within the page', () => {
  const short = initialMarginRect('你好', 0.9, 0.98, 0.707);
  assert.ok(short.width < 0.1 && short.height < 0.06);
  assert.ok(short.x + short.width <= 1 && short.y + short.height <= 1);
  const long = initialMarginRect('第一行内容比较长\n第二行也是笔记', 0.1, 0.1, 0.707);
  assert.ok(long.width > short.width && long.height > short.height);
  assert.ok(long.width <= 0.24 && long.height <= 0.3);
});

test('old default-size notes render compact while manually resized notes keep their size', () => {
  const props = { item: { id: 'n', note: '你好', color: 'sky', locator: { kind: 'pdf', rects: [], noteRect: { x: 0.1, y: 0.2, width: 0.24, height: 0.2 } } }, fontSize: 14, focused: false, onEdit() {}, onGeometry: async () => {} };
  const old = MarginNote(props);
  assert.ok(parseFloat(old.props.style.width) < 10 && parseFloat(old.props.style.height) < 6);
  props.item.locator.noteRect.width = 0.3;
  const resized = MarginNote(props);
  assert.equal(resized.props.style.width, '30%');
  assert.equal(resized.props.style.height, '20%');
});
