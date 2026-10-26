// ReadX host for rtex's JSON-lines API. Font outlines come from the upstream MIT host.
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { watch, readFileSync, mkdirSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ResourceLoader } from './vendor/resources.mjs';
import { fontKey } from './vendor/fontKey.mjs';

const [sourceEngine, project, main, build] = process.argv.slice(2);
const engineEnv = { ...process.env };
let engine = sourceEngine;
if (process.platform === 'win32') {
  // A Low-integrity workspace image lowers rtex and its LuaLaTeX children, preventing
  // MiKTeX from writing its user font cache. Write an ordinary user-cache executable,
  // as ReadX already does for its Go server; do not copy the source ACL/label.
  const body = readFileSync(sourceEngine);
  const hash = createHash('sha256').update(body).digest('hex');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'ReadX', 'rtex', hash);
  mkdirSync(dir, { recursive: true });
  engine = path.join(dir, 'rtex.exe');
  if (!existsSync(engine)) {
    const staging = path.join(dir, `rtex-${process.pid}.tmp`);
    try { writeFileSync(staging, body, { flag: 'wx' }); renameSync(staging, engine); }
    finally { if (existsSync(staging)) unlinkSync(staging); }
  }
  if (!engineEnv.RTEX_TEXDIR) {
    const base = path.dirname(sourceEngine);
    const support = [path.resolve(base, '../share/rtex/tex'), path.join(base, 'tex'), path.resolve(base, '../tex')]
      .find(candidate => existsSync(path.join(candidate, 'rtex-dl.lua')));
    if (support) engineEnv.RTEX_TEXDIR = support;
  }
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const loader = new ResourceLoader(process.env, (msg) => process.stderr.write(msg + '\n'));
const fontsHave = new Set(), imagesHave = new Set();
const texts = new Map();
const missingFonts = new Set(), missingImages = new Set();
const child = spawn(engine, ['serve', '--project', project, '--main', main, '--build', build], {
  env: engineEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.pipe(process.stderr);
child.stdin.on('error', () => {});
process.stdout.on('error', () => stop());
let stopping = false, forceTimer;
let watcher, watchTimer, fallbackTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  watcher?.close();
  clearTimeout(watchTimer);
  clearTimeout(fallbackTimer);
  child.stdin.end('{"cmd":"quit"}\n');
  forceTimer = setTimeout(() => {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else child.kill('SIGKILL');
  }, 5000);
  forceTimer.unref();
}
const input = createInterface({ input: process.stdin });
let commands = Promise.resolve();
input.on('line', line => {
  commands = commands.then(async () => {
    if (stopping) return;
    let command = JSON.parse(line);
    if (command.cmd === 'set_document') {
      const before = texts.get(command.path);
      // The first buffer registers the file, including files not reached by \input yet.
      // Later buffers become minimal UTF-8 edits so an ordinary body edit stays on rtex's fast path.
      texts.set(command.path, command.text);
      if (before === command.text) return;
      if (before !== undefined) {
        const after = command.text;
        let start = 0, end = before.length, newEnd = after.length;
        while (start < end && start < newEnd && before[start] === after[start]) start++;
        // rtex edit offsets are UTF-8 bytes; do not split a surrogate pair.
        const low = (value) => value >= 0xdc00 && value <= 0xdfff;
        if (start > 0 && low(before.charCodeAt(start))) start--;
        while (end > start && newEnd > start && before[end-1] === after[newEnd-1]) { end--; newEnd--; }
        if (end < before.length && low(before.charCodeAt(end))) { end++; newEnd++; }
        command = { cmd: 'edit', path: command.path, start: Buffer.byteLength(before.slice(0, start)),
          end: Buffer.byteLength(before.slice(0, end)), text: after.slice(start, newEnd) };
      }
    }
    if (!stopping) child.stdin.write(JSON.stringify(command) + '\n');
  }).catch(error => send({ event: 'ReadXError', message: error.message }));
});
input.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
try {
  watcher = watch(project, { recursive: true }, (_event, filename) => {
    if (!filename || stopping) return;
    const rel = filename.replaceAll('\\', '/');
    if (/[\/](build|\.git|node_modules)[\/]/.test('/' + rel)) return;
    if (/\.tex$/i.test(rel)) {
      if (texts.has(rel)) return; // Editor buffers are authoritative until the session ends.
      void readFile(path.join(project, rel), 'utf8').then(text => {
        if (!stopping) child.stdin.write(JSON.stringify({ cmd: 'set_document', path: rel, text }) + '\n');
      }).catch(() => {});
    } else if (/\.(bib|sty|cls|bst|png|jpe?g|pdf|eps|cfg|def)$/i.test(rel)) {
      imagesHave.clear();
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => { if (!stopping) child.stdin.write('{"cmd":"request_layout"}\n'); }, 400);
    }
  });
} catch (error) { process.stderr.write(`rtex file watcher: ${error.message}\n`); }

const wire = (res) => {
  if (!('data' in res)) return res;
  const { data, ...rest } = res;
  return { ...rest, dataBase64: Buffer.from(data).toString('base64') };
};
let queue = Promise.resolve();
const output = createInterface({ input: child.stdout });
output.on('line', line => {
  queue = queue.then(async () => {
    const event = JSON.parse(line);
    const dls = event.event === 'LayoutUpdate' ? event.pages_changed.map(p => p.dl)
      : event.event === 'ParagraphUpdate' && event.dl ? [event.dl] : [];
    if (dls.length) {
      const [fonts, images] = await Promise.all([
        loader.fontsFor(dls, fontsHave), loader.imagesFor(dls, imagesHave, project),
      ]);
      if (fonts.size || images.size) {
        send({ event: 'ReadXResources', fonts: [...fonts].map(([k,v]) => [k, wire(v)]),
          images: [...images].map(([k,v]) => [k, wire(v)]) });
        for (const k of fonts.keys()) fontsHave.add(k);
        for (const k of images.keys()) imagesHave.add(k);
        for (const [k, resource] of fonts) { if (resource.kind === 'missing') missingFonts.add(k); else missingFonts.delete(k); }
        for (const [k, resource] of images) { if (resource.kind === 'missing') missingImages.add(k); else missingImages.delete(k); }
      }
    }
    const missing = dls.some(dl => Object.values(dl.fonts ?? {}).some(desc => missingFonts.has(fontKey(desc)))
      || Object.values(dl.images_info ?? {}).some(info => missingImages.has(info.file)));
    if (event.event === 'ParagraphUpdate' && missing && !stopping) {
      clearTimeout(fallbackTimer);
      fallbackTimer = setTimeout(() => { if (!stopping) child.stdin.write('{"cmd":"request_layout"}\n'); }, 400);
    }
    if (event.event === 'LayoutUpdate' && event.compile.state !== 'Failed' &&
        (event.pdf_fallback || missing || event.pages_changed.some(page => !page.exact))) {
      const pdf = event.pdf_fallback || path.join(build, 'bg', path.basename(main, path.extname(main)) + '.pdf');
      try { event.pdfBase64 = (await readFile(pdf)).toString('base64'); }
      catch (error) { process.stderr.write(`rtex PDF: ${error.message}\n`); }
    }
    send(event);
  }).catch(error => send({ event: 'ReadXError', message: error.message }));
});
child.on('error', error => { send({ event: 'ReadXError', message: error.message }); process.exitCode = 1; input.close(); });
child.on('close', async code => {
  watcher?.close();
  clearTimeout(watchTimer);
  clearTimeout(fallbackTimer);
  clearTimeout(forceTimer);
  await queue;
  send({ event: 'ReadXStopped', code });
  input.close();
  process.exitCode = code ?? 1;
  process.stdin.destroy();
});
