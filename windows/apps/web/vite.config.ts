import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReadyInfo } from '@cbct/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const devInfoPath = path.resolve(here, '../server/dev-info.json');

/**
 * 读取 Go server 写出的 dev-info.json：Vite dev proxy 用它把 /v1 转到本机 server，
 * 并在服务端注入 bearer token——这样 token 不必出现在渲染进程的 URL / 全局变量里，
 * 纯浏览器 dev（不带 Electron）也能直接联调。
 */
function readDevInfo(): ReadyInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(devInfoPath, 'utf8')) as Partial<ReadyInfo>;
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || raw.token.length < 32) return null;
    return raw as ReadyInfo;
  } catch {
    return null;
  }
}

const info = readDevInfo();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    strictPort: true,
    host: '127.0.0.1',
    proxy: info
      ? {
          '/v1': {
            target: `http://127.0.0.1:${info.port}`,
            changeOrigin: false,
            headers: { Authorization: `Bearer ${info.token}` },
          },
          '/healthz': { target: `http://127.0.0.1:${info.port}`, changeOrigin: false },
        }
      : {},
  },
  build: {
    target: 'chrome120',
    outDir: 'dist',
    sourcemap: true,
    // pdf.js worker 走独立 chunk，主包不内联，保证 CSP script-src 'self' 可守。
    chunkSizeWarningLimit: 900,
  },
  envPrefix: 'CBCT_',
});
