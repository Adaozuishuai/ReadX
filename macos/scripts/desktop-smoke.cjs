// Exercise the real Electron main/preload + Go binary + production React bundle.
// Uses a generated PDF and an isolated legacy library; never calls paid models.
const { app, dialog, BrowserWindow } = require('electron');
const errorDialogs = [];
dialog.showMessageBox = async options => { if (options.type === 'error') errorDialogs.push(options.message); return { response: 0 }; };
dialog.showErrorBox = (title, detail) => errorDialogs.push(`${title}: ${detail}`);
app.on('will-quit', () => { if (errorDialogs.length) { console.error(errorDialogs); app.exit(1); } });
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.tmp-smoke', `desktop-${process.pid}`);
process.env.CBCT_DATA_ROOT = workspace;
app.setAppPath(path.join(root, 'apps', 'desktop'));
app.setPath('userData', path.join(workspace, 'electron'));
let tested = false;
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 60000);
async function waitFor(window, expression) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await Promise.race([window.webContents.executeJavaScript(expression), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
    if (result) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`UI did not become ready: ${expression}`);
}
async function api(window, route, method = 'GET', body) {
  return window.webContents.executeJavaScript(`(async()=>{
    const {apiBase,token}=window.__CBCT_V2__;
    const response=await fetch(apiBase+${JSON.stringify(route)}, {method:${JSON.stringify(method)},signal:AbortSignal.timeout(2500),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))}});
    if(!response.ok) throw new Error('HTTP '+response.status+' '+await response.text());
    return response.json();
  })()`);
}
app.on('browser-window-created', (_event, window) => {
  if (tested) return;
  tested = true;
  window.webContents.once('did-finish-load', async () => {
    try {
      await waitFor(window, '!!window.__CBCT_V2__ && !!document.querySelector(".library-sidebar")');
      const unauthorized = await window.webContents.executeJavaScript('fetch("/v1/documents").then(r=>r.status)');
      assert.equal(unauthorized, 401);
      await api(window, '/v1/import', 'POST', {});
      const documents = await api(window, '/v1/documents');
      assert.equal(documents.total, 1);
      const rendering = await api(window, '/v1/render/status');
      assert.equal(rendering.available, true, JSON.stringify(rendering));
      const updates = await window.webContents.executeJavaScript('window.__READX_DESKTOP_UPDATES__.check()');
      assert.equal(updates.state, 'unsupported');
      await window.reload();
      await waitFor(window, '!!document.querySelector(".book-cover")');
      await window.webContents.executeJavaScript('document.querySelector(".book-cover").click()');
      await waitFor(window, '!!document.querySelector(".pdf-reader canvas")');
      await waitFor(window, 'document.body.textContent.includes("精读五重奏")');
      const source = await api(window, '/v1/documents/mac-smoke/pages/1');
      assert.match(JSON.stringify(source), /Research paper/);
      await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === '下一页').click()`);
      await waitFor(window, 'document.querySelector("input[aria-label=页码]").value === "2"');
      const locationDeadline = Date.now() + 5000;
      while ((await api(window, '/v1/documents/mac-smoke/location')).location?.page !== 2) {
        if (Date.now() > locationDeadline) throw new Error('Reading location did not persist');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const screenshot = await window.webContents.capturePage();
      fs.writeFileSync(path.join(workspace, 'reader.png'), screenshot.toPNG());
      const beforeRestart = await api(window, '/v1/meta');
      process.kill(beforeRestart.pid, 'SIGKILL');
      const deadline = Date.now() + 15000;
      let recovered = false;
      while (Date.now() < deadline) {
        try {
          const afterRestart = await api(window, '/v1/meta');
          if (afterRestart.pid !== beforeRestart.pid) { recovered = true; break; }
        } catch { /* expected during the restart */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      console.log('Crash recovery request loop completed');
      assert(recovered, 'Go server must recover after an unexpected exit');
      assert.equal((await api(window, '/v1/documents/mac-smoke/location')).location.page, 2);
      assert.equal(errorDialogs.length, 0, 'Automatic recovery must not close the reader');
      if (process.platform === 'darwin') {
        console.log('Checking Dock window restoration');
        const closed = new Promise(resolve => window.once('closed', resolve));
        window.close();
        await closed;
        app.emit('activate');
        window = BrowserWindow.getAllWindows()[0];
        assert(window, 'Dock activation must recreate the window');
        window.show();
        console.log('Dock recreated window:', window.webContents.getURL());
        await waitFor(window, '!!window.__CBCT_V2__ && !!document.querySelector(".library-sidebar, .pdf-reader")');
        assert.equal((await api(window, '/v1/documents')).total, 1);
      }
      console.log('Dock window restoration completed');
      console.log('Desktop smoke OK: real main/preload, auth, SQLite import, PDF reader, render resources, update bridge, reading location, backend crash recovery and Dock activation.');
      console.log(`Evidence: ${path.join(workspace, 'reader.png')}`);
      clearTimeout(timeout);
      app.quit();
    } catch (error) {
      console.error(error);
      clearTimeout(timeout);
      app.once('will-quit', () => app.exit(1));
      app.quit();
    }
  });
});
(async () => {
  fs.mkdirSync(path.join(workspace, 'library'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'library', 'text'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'library', 'text', 'mac-smoke-v3.txt'), '=== Page 1 ===\nResearch paper. Introduction. A generated PDF for local testing.\n=== Page 2 ===\nMethods and results. No remote services are used.');
  fs.writeFileSync(path.join(workspace, 'queue.json'), JSON.stringify({ papers: [{ id: 'mac-smoke', title: 'ReadX macOS parity smoke', authors: ['ReadX test fixture'] }] }));
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const text of ['Research paper. Introduction. A generated PDF for local testing.', 'Methods and results. No remote services are used.']) {
    pdf.addPage([595, 842]).drawText(text, { x: 35, y: 760, size: 12, font });
  }
  fs.writeFileSync(path.join(workspace, 'library', 'mac-smoke.pdf'), await pdf.save());
  // Legacy text is intentionally optional; PDF.js writes its extracted text back.
  require(path.join(root, 'apps', 'desktop', 'dist', 'main.js'));
})().catch(error => { console.error(error); app.exit(1); });
