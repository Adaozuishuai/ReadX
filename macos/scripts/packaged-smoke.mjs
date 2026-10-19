// Validate the actual app bundle with an ephemeral local DevTools connection.
// Run with no other ReadX instance open. Never exports the API bearer token.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appPath = path.resolve(process.argv[2] || path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ReadX.app'));
const workspace = path.join(root, '.tmp-smoke', `packaged-${process.pid}`);
fs.mkdirSync(workspace, { recursive: true });
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const launched = spawnSync('/usr/bin/open', ['-n', appPath, '--args', `--remote-debugging-port=${port}`], { encoding: 'utf8' });
if (launched.error || launched.status !== 0) throw new Error(launched.stderr || launched.error?.message);
let target;
for (let i = 0; i < 60; i++) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = pages.find(page => page.type === 'page' && page.url.startsWith('http://127.0.0.1:'));
    if (target) break;
  } catch { /* Chromium is still starting. */ }
  await new Promise(resolve => setTimeout(resolve, 500));
}
if (!target) throw new Error('Packaged reader did not open. Close other ReadX instances and retry.');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); callback(message); }
};
function cdp(method, params) {
  const request = ++id;
  return Promise.race([
    new Promise(resolve => { pending.set(request, resolve); ws.send(JSON.stringify({ id: request, method, params })); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15000); timer.unref(); }),
  ]);
}
try {
  const reply = await cdp('Runtime.evaluate', { expression: `(async()=>{
    const b=window.__CBCT_V2__; if(!b)throw new Error('Missing preload credentials');
    async function get(route){const r=await fetch(b.apiBase+route,{headers:{Authorization:'Bearer '+b.token},signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(route+' HTTP '+r.status);return r.json();}
    const [ocr,render,meta]=await Promise.all([get('/v1/ocr/settings'),get('/v1/render/status'),get('/v1/meta')]);
    return {ocrConfigured:ocr.configured,ocrModel:ocr.model,renderAvailable:render.available,renderMessage:render.error,dataRoot:meta.dataRoot,pid:meta.pid};
  })()`, awaitPromise: true, returnByValue: true });
  if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception.description);
  const status = reply.result.result.value;
  console.log(JSON.stringify(status));
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
  // Close the debug instance so the next ordinary launch has no debugging port.
  ws.send(JSON.stringify({ id: ++id, method: 'Browser.close' }));
  await new Promise(resolve => setTimeout(resolve, 500));
  ws.close();
}
