import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['cmaps', 'standard_fonts']) {
  fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', name), path.join(root, 'apps/web/public/pdfjs', name), { recursive: true });
}
