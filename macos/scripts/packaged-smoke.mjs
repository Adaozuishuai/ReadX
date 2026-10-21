// Validate the actual app bundle with an ephemeral local DevTools connection.
// Uses an isolated library/profile, even with the ordinary app running. Never exports the API bearer token.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ReadX.app'));
const updateConfig = path.join(appPath, 'Contents', 'Resources', 'app-update.yml');
if (!fs.existsSync(updateConfig)) {
  throw new Error('Packaged app is missing app-update.yml. Build DMG/ZIP targets (not --dir) before validating updates.');
}
const workspace = path.join(root, '.tmp-smoke', `packaged-${process.pid}`);
fs.mkdirSync(workspace, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const child = spawn(path.join(appPath, 'Contents', 'MacOS', 'ReadX'), [
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'electron')}`,
], { env: { ...process.env, CBCT_DATA_ROOT: workspace }, stdio: 'ignore' });
let launchError;
child.once('error', error => { launchError = error; });
let ws;
let id = 0;
const pending = new Map();
function cdp(method, params, timeoutMs = 15000) {
  const request = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(request); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(request, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: request, method, params }));
  });
}
try {
  let target;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Packaged app exited: ${child.exitCode}`);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      target = pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'));
      if (target) break;
    } catch { /* Chromium is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!target) throw new Error('Isolated packaged reader did not open.');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message);
  };
  const reply = await cdp('Runtime.evaluate', { expression: `(async()=>{
    const b=window.__CBCT_V2__; if(!b)throw new Error('Missing preload credentials');
    async function get(route){const r=await fetch(b.apiBase+route,{headers:{Authorization:'Bearer '+b.token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(route+' HTTP '+r.status);return r.json();}
    const [ocr,render,meta]=await Promise.all([get('/v1/ocr/settings'),get('/v1/render/status'),get('/v1/meta')]);
    return {ocrConfigured:ocr.configured,ocrModel:ocr.model,renderAvailable:render.available,renderMessage:render.error,dataRoot:meta.dataRoot,pid:meta.pid};
  })()`, awaitPromise: true, returnByValue: true });
  if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception.description);
  const status = reply.result.result.value;
  assert.equal(path.resolve(status.dataRoot), workspace, 'Packaged tests must use an isolated data root');
  console.log(JSON.stringify(status));
  const updateReply = await cdp('Runtime.evaluate', {
    expression: 'window.__READX_DESKTOP_UPDATES__.getStatus()', awaitPromise: true, returnByValue: true,
  });
  if (updateReply.result.exceptionDetails) throw new Error(updateReply.result.exceptionDetails.exception.description);
  assert.equal(updateReply.result.result.value.state, 'idle');
  status.updateBridge = true;
  if (process.argv.includes('--check-updates')) {
    const checkReply = await cdp('Runtime.evaluate', {
      expression: 'Promise.all([window.__READX_DESKTOP_UPDATES__.check(), window.__READX_DESKTOP_UPDATES__.check()])',
      awaitPromise: true, returnByValue: true,
    }, 40000);
    if (checkReply.result.exceptionDetails) throw new Error(checkReply.result.exceptionDetails.exception.description);
    const [first, second] = checkReply.result.result.value;
    assert.deepEqual(first, second, 'Concurrent IPC checks must agree');
    assert(['current', 'available', 'unavailable'].includes(first.state), JSON.stringify(first));
    assert(first.version, 'Live check must return a published version');
    status.liveUpdateCheck = { state: first.state, version: first.version, currentVersion: first.currentVersion };
    console.log(JSON.stringify({ liveUpdateCheck: status.liveUpdateCheck }));
  }
  if (!status.renderAvailable) throw new Error('Packaged rendering dependencies are unavailable.');
  // Verify the packaged main process also survives a backend crash, using the
  // same origin and preload token. Do not retry any application mutation.
  process.kill(status.pid, 'SIGKILL');
  let recovered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const health = await cdp('Runtime.evaluate', { expression: `(async()=>{try{const b=window.__CBCT_V2__;const r=await fetch(b.apiBase+'/v1/meta',{headers:{Authorization:'Bearer '+b.token},signal:AbortSignal.timeout(1500)});return r.ok?(await r.json()).pid:0;}catch{return 0;}})()`, awaitPromise: true, returnByValue: true });
    const pid = health.result?.result?.value;
    if (pid && pid !== status.pid) { recovered = true; break; }
  }
  if (!recovered) throw new Error('Packaged backend did not recover after SIGKILL.');
  status.backendRecovery = true;
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(workspace, 'app.png'), Buffer.from(screenshot.result.data, 'base64'));
  fs.writeFileSync(path.join(workspace, 'status.json'), JSON.stringify(status, null, 2));
  console.log(`Packaged UI, preload, backend and resources OK. Evidence: ${workspace}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
    await new Promise(resolve => setTimeout(resolve, 500));
    ws.close();
  }
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Packaged test closed')); }
  pending.clear();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
