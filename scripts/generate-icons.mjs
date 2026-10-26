/** Render the existing SVG at each native size; no raster upscaling or image dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 192, 256, 512];
const icoSizes = sizes.filter(size => size <= 256 && size !== 192);

function connect(browser) {
  let sequence = 0;
  let buffer = '';
  const pending = new Map();
  browser.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
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
  browser.once('exit', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Icon renderer exited'));
    }
    pending.clear();
  });
  return (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Icon renderer timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
  });
}

// Native-size DIBs let Windows load small taskbar icons without decoding or
// resampling a single large PNG. Keep the 256px frame PNG-compressed.
function dibFrame(size, rgba) {
  const maskStride = Math.ceil(size / 32) * 4;
  const bitmap = Buffer.alloc(40 + size * size * 4 + maskStride * size);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(size * size * 4, 20);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = 40 + ((size - 1 - y) * size + x) * 4;
      bitmap[target] = rgba[source + 2];
      bitmap[target + 1] = rgba[source + 1];
      bitmap[target + 2] = rgba[source];
      bitmap[target + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0) bitmap[40 + size * size * 4 + (size - 1 - y) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return bitmap;
}

function iconFile(frames) {
  const header = Buffer.alloc(6 + icoSizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  let offset = header.length;
  const payloads = icoSizes.map((size, index) => {
    const frame = frames.find(frame => frame.size === size);
    const payload = size === 256 ? Buffer.from(frame.png, 'base64') : dibFrame(size, Buffer.from(frame.rgba, 'base64'));
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(payload.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += payload.length;
    return payload;
  });
  return Buffer.concat([header, ...payloads]);
}

const browserPath = [
  process.env.READX_ICON_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(candidate => candidate && fs.existsSync(candidate));
if (!browserPath) throw new Error('Install Edge/Chrome or set READX_ICON_BROWSER to render icon.svg');
fs.mkdirSync(path.join(root, 'windows/.tmp-smoke'), { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'windows/.tmp-smoke/icon-render-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-proxy-server', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const cdp = connect(browser);
try {
  await cdp('Browser.getVersion');
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const svg = fs.readFileSync(path.join(root, 'windows/apps/web/public/icon.svg'), 'utf8');
  const result = await cdp('Runtime.evaluate', {
    expression: `(async () => {
      const svg = ${JSON.stringify(svg)};
      const base64 = bytes => {
        let value = '';
        for (let start = 0; start < bytes.length; start += 16384) value += String.fromCharCode(...bytes.subarray(start, start + 16384));
        return btoa(value);
      };
      const frames = [];
      for (const size of ${JSON.stringify(sizes)}) {
        const image = new Image();
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="512" height="512"', 'width="' + size + '" height="' + size + '"'));
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        frames.push({ size, png: canvas.toDataURL('image/png').split(',')[1], rgba: size < 256 ? base64(context.getImageData(0, 0, size, size).data) : '' });
      }
      return frames;
    })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  const frames = result.result.value;
  const ico = iconFile(frames);
  for (const platform of ['windows', 'macos']) {
    const publicDir = path.join(root, platform, 'apps/web/public');
    for (const frame of frames) fs.writeFileSync(path.join(publicDir, `icon-${frame.size}.png`), Buffer.from(frame.png, 'base64'));
    fs.writeFileSync(path.join(publicDir, 'favicon.ico'), ico);
    fs.writeFileSync(path.join(root, platform, 'apps/desktop/icon.ico'), ico);
  }
  console.log(`Rendered SVG at ${sizes.join(', ')}px; ICO contains ${icoSizes.length} native sizes.`);
} finally {
  await cdp('Browser.close').catch(() => {});
  browser.kill();
  for (const stream of browser.stdio) stream?.destroy();
}
