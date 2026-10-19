import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A sandbox-labelled workspace executable starts with Low integrity on Windows.
// Create an ordinary user-cache file rather than copying the source ACL/label.
// Content-addressed paths allow updates while the previous server is running.
export function prepareServerRuntime(source) {
  if (process.platform !== 'win32') return source;
  const body = fs.readFileSync(source);
  const hash = createHash('sha256').update(body).digest('hex');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dir = path.join(local, 'CBCTReading', 'runtime', hash);
  const target = path.join(dir, 'server.exe');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(target)) {
    const staging = path.join(dir, `server-${process.pid}.tmp`);
    try {
      fs.writeFileSync(staging, body, { flag: 'wx' });
      fs.renameSync(staging, target);
    } finally {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    }
  }
  return target;
}
