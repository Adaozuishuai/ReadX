// Real Chromium component regression; parsing and uploads are mocked, with no AI calls.
// Run from windows/: npm run test:import. Set CBCT_SMOKE_BROWSER to override Edge/Chrome.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.tmp-smoke', `import-${process.pid}`);

// CDP pipe keeps the browser isolated without opening a debugging port or adding dependencies.
function connect(browser) {
  let nextId = 0;
  let buffer = '';
  let closedError;
  const pending = new Map();
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  const fail = error => {
    closedError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  browser.once('error', fail);
  browser.once('exit', code => fail(new Error(`Test browser exited: ${code}`)));
  browser.stdio[3].on('error', fail);
  browser.stdio[4].on('error', fail);
  browser.stdio[4].once('end', () => fail(new Error('Test browser closed its debugging pipe')));
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closedError) { reject(closedError); return; }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Browser request timed out: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0', error => {
      if (!error) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const executable = [
    process.env.CBCT_SMOKE_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  ].find(candidate => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error('Install Edge/Chrome or set CBCT_SMOKE_BROWSER to a Chromium executable');
  fs.mkdirSync(workspace, { recursive: true });
  let server;
  let browser;
  let cdp;
  let browserErrors = '';
  try {
    const { createServer } = await import('vite');
    const { default: react } = await import('@vitejs/plugin-react');
    fs.writeFileSync(path.join(workspace, 'index.html'), `<!doctype html>
      <style>.shot-zone { position: relative; width: 600px; height: 340px; }</style>
      <div id="root"></div><script type="module" src="/scripts/import-smoke.jsx"></script>`);
    const metadataModule = path.join(root, 'apps/web/src/components/DocumentJobDialog.tsx').replace(/\\/g, '/');
    server = await createServer({
      root,
      configFile: false,
      logLevel: 'error',
      plugins: [react(), {
        name: 'mock-job-preview',
        load(id) {
          if (id.split('?')[0].replace(/\\/g, '/') === metadataModule) {
            return 'export function DocumentJobDialog() { return null; }';
          }
        },
      }],
      server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/.tmp-smoke/**', '**/dist/**'] } },
    });
    await server.listen();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
      `--user-data-dir=${path.join(workspace, 'profile')}`, 'about:blank',
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    browser.stderr.on('data', chunk => { browserErrors = (browserErrors + chunk).slice(-2000); });
    cdp = connect(browser);
    await cdp('Browser.getVersion');
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression, awaitPromise = false) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const page = path.relative(root, path.join(workspace, 'index.html')).replace(/\\/g, '/');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/${page}` }, sessionId);
    const deadline = Date.now() + 15000;
    while (!(await evaluate('typeof window.runImportSmoke === "function"'))) {
      if (Date.now() >= deadline) throw new Error(`Regression page did not load: ${await evaluate('document.body.innerText')}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const results = await evaluate('window.runImportSmoke()', true);
    for (const result of results) console.log(`PASS ${result}`);
  } catch (error) {
    if (browserErrors.trim()) console.error(browserErrors);
    throw error;
  } finally {
    if (cdp) await cdp('Browser.close').catch(() => {});
    browser?.kill();
    for (const stream of browser?.stdio || []) stream?.destroy();
    await server?.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
