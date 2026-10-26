const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const config = require('../package.json').build;

test('Windows taskbar icon includes native frames for standard and high DPI displays', () => {
  const ico = fs.readFileSync(path.join(desktop, config.win.icon));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const frames = new Map();
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + i * 16;
    const size = ico[entry] || 256;
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert(offset + bytes <= ico.length, `truncated ${size}px frame`);
    const frame = ico.subarray(offset, offset + bytes);
    if (size < 256) {
      assert.equal(frame.readUInt32LE(0), 40, `${size}px taskbar frame must be a native Windows bitmap`);
      assert.equal(frame.readInt32LE(4), size);
      assert.equal(frame.readInt32LE(8), size * 2);
    } else {
      assert.equal(frame.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(frame.readUInt32BE(16), size);
      assert.equal(frame.readUInt32BE(20), size);
    }
    frames.set(size, frame);
  }
  for (const size of [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]) assert(frames.has(size), `missing ${size}px DPI variant`);
});

test('packaging includes the window icon and browser fallback uses the same artwork', () => {
  assert(config.files.includes(config.win.icon), 'BrowserWindow must be able to read its ICO inside app.asar');
  const ico = fs.readFileSync(path.join(desktop, config.win.icon));
  const favicon = fs.readFileSync(path.resolve(desktop, '../web/public/favicon.ico'));
  assert.deepEqual(favicon, ico);
});
