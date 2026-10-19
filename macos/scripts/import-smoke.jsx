import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ImportDialog } from '../apps/web/src/components/ImportDialog';
import { UploadShotStage } from '../apps/web/src/components/UploadShotStage';
import { api } from '../apps/web/src/api/client';

const root = createRoot(document.getElementById('root'));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const query = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const click = text => {
  const button = all('button').find(item => item.textContent.trim() === text);
  assert(button, `Missing button: ${text}`);
  button.click();
};
async function until(predicate, message = 'UI did not update') {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function mount(element) {
  root.render(null);
  await until(() => !query('.shot-stage'));
  root.render(element);
  await until(() => query('.shot-ball'));
  await frame();
}
function pointer(target, type, x, y) {
  const rect = query('.shot-zone').getBoundingClientRect();
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, pointerId: 1, pointerType: 'mouse',
    clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height,
  }));
}
async function aim() {
  pointer(query('.shot-ball'), 'pointerdown', 0.14, 0.66);
  await until(() => query('.shot-zone.aiming'));
  await frame();
  pointer(window, 'pointermove', -0.02, 0.8);
  await until(() => query('.shot-path.make'), 'Fixture trajectory should land in the hoop');
  await frame();
}
async function shoot(twice = false) {
  await aim();
  pointer(window, 'pointerup', -0.02, 0.8);
  if (twice) pointer(window, 'pointerup', -0.02, 0.8);
}
async function enterLink(value) {
  const input = query('input[placeholder^="https://"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await frame();
  click('从链接或编号导入');
}
async function addFile(file) {
  const input = query('input[type="file"]');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => query('.shot-ball'));
  await frame();
}

function ShotHarness({ files, onMake }) {
  const [queue, setQueue] = useState(files);
  return <UploadShotStage queue={queue} active={null} current={null} results={[]} busy={false}
    onQueue={() => {}} onMake={file => {
      onMake(file);
      setQueue(items => items.filter(item => item !== file));
    }} />;
}

window.runImportSmoke = async () => {
  const passed = [];
  const nativeMatchMedia = window.matchMedia;
  let reducedMotion = false;
  window.matchMedia = () => ({ matches: reducedMotion });
  const originalUpload = api.upload;
  const originalDownload = api.downloadPublication;
  try {
    const first = new File(['first'], 'first.pdf');
    const second = new File(['second'], 'second.pdf');
    const third = new File(['third'], 'third.pdf');
    const made = [];
    await mount(<ShotHarness files={[first, second, third]} onMake={file => made.push(file)} />);
    await shoot();
    await until(() => query('.shot-ball.flying'));
    all('.shot-chip button')[1].click();
    await until(() => query('.shot-chip.picked').textContent.includes('second.pdf'));
    assert(query('.shot-ball').title.startsWith('first.pdf'), 'Changing selection must not change the flying file');
    await until(() => made.length === 1);
    assert(made[0] === first, 'A shot must import the file that was launched');
    assert(query('.shot-chip.picked').textContent.includes('second.pdf'), 'Removing the first file must preserve the next selection');
    passed.push('flight keeps its original file while the next file is selected');

    reducedMotion = true;
    await mount(<ShotHarness files={[first]} onMake={file => made.push(file)} />);
    await aim();
    pointer(window, 'pointercancel', -0.02, 0.8);
    await until(() => !query('.shot-zone.aiming'));
    assert(made.length === 1, 'Cancelling a pointer gesture must not import a file');
    passed.push('pointer cancellation does not launch a reduced-motion shot');

    const calls = [];
    api.upload = (files, signal, metadata) => new Promise((resolve, reject) => {
      calls.push({ file: files[0], signal, metadata: metadata[0], resolve, reject });
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    api.downloadPublication = async value => ({ file: new File([value], 'paper.pdf'), source: value });
    const local = new File(['local article'], 'paper.pdf');
    await mount(<ImportDialog files={[local]} onClose={() => {}} onImported={() => {}} />);
    await enterLink('https://example.invalid/first');
    await until(() => all('.shot-chip').length === 2);
    await enterLink('https://example.invalid/second');
    await until(() => all('.shot-chip').length === 3);
    await shoot(true);
    await until(() => calls.length > 0);
    await until(() => query('input[type="file"]').disabled);
    assert(calls.length === 1, 'Repeated pointerup in one event turn must start only one upload');
    assert(calls[0].file === local && !calls[0].metadata.source, 'A local file must not inherit a same-named download source');
    assert(all('.shot-chip button').every(button => button.disabled), 'Queue selection must be disabled while importing');
    pointer(query('.shot-ball'), 'pointerdown', 0.14, 0.66);
    pointer(window, 'pointermove', -0.02, 0.8);
    pointer(window, 'pointerup', -0.02, 0.8);
    await frame();
    assert(!query('.shot-zone.aiming') && !query('.shot-ball.flying'), 'A pending upload must block another shot');
    assert(calls.length === 1 && all('.shot-chip').length === 2, 'Blocked shots must keep queued files');
    click('取消请求');
    await until(() => query('.shot-row')?.dataset.state === 'failed');
    assert(calls[0].signal.aborted, 'Cancel must reach the active upload');
    assert(query('.shot-row')?.dataset.state === 'failed' && query('.shot-state').textContent === '已中断', 'A cancelled task must show an interrupted state');
    assert(!query('input[type="file"]').disabled, 'Cancellation must release the request lock');
    passed.push('duplicate submits are serialized; cancellation reaches the active request and unlocks the queue');

    await shoot();
    await until(() => calls.length === 2);
    assert(calls[1].metadata.source === 'https://example.invalid/first', 'First download must retain its own source');
    calls[1].resolve({ results: [{ name: 'paper.pdf', existing: false }] });
    await until(() => query('.shot-row')?.dataset.state === 'done');
    assert(query('.shot-count').textContent === '已导入 1', 'Completed imports must stop displaying a pending count');
    await shoot();
    await until(() => calls.length === 3);
    assert(calls[2].metadata.source === 'https://example.invalid/second', 'Second same-named download must retain its own source');
    assert(query('.shot-row')?.dataset.state === 'working', 'A same-named new import must not reuse a previous success');
    calls[2].reject(new Error('fixture upload failure'));
    await until(() => query('.shot-row')?.dataset.state === 'failed');
    assert(query('.shot-state').textContent === '失败', 'An upload error must display failure');
    passed.push('same-named local/downloaded files retain independent sources and task results');

    await addFile(new File(['server failure'], 'paper.pdf'));
    await shoot();
    await until(() => calls.length === 4);
    calls[3].resolve({ results: [{ name: 'paper.pdf', existing: false, error: 'fixture pipeline failure' }] });
    await until(() => query('.shot-row')?.dataset.state === 'failed');
    assert(document.body.textContent.includes('fixture pipeline failure'), 'Pipeline error details must remain visible');
    assert(query('.shot-count').textContent === '已导入 1', 'Failure must preserve the completed count');
    passed.push('pipeline failures preserve completed results and display the current failure');

    await addFile(new File(['direct import'], 'direct.pdf'));
    click('直接导入');
    await until(() => calls.length === 5);
    assert(calls[4].file.name === 'direct.pdf', 'Direct import must use the selected queued file');
    calls[4].resolve({ results: [{ name: 'direct.pdf', existing: false }] });
    await until(() => query('.shot-row')?.dataset.state === 'done');
    assert(query('.shot-count').textContent === '已导入 2', 'Direct import must share progress and results with a shot');
    passed.push('direct import uses the selected file and the same request lifecycle');
    return passed;
  } finally {
    root.unmount();
    window.matchMedia = nativeMatchMedia;
    api.upload = originalUpload;
    api.downloadPublication = originalDownload;
  }
};
