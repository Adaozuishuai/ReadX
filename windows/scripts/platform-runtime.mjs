import fs from 'node:fs';
import path from 'node:path';

// Shared by development and runtime diagnostics. Packaged Electron injects the
// same contract from its Resources directory before spawning the Go service.
export function runtimeEnvironment(root) {
  const env = { ...process.env, READX_WORKSPACE_DIR: root };
  const windows = process.platform === 'win32';
  const python = path.join(root, '.retain-runtime', ...(windows ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
  if (!env.READX_PYTHON && fs.existsSync(python)) env.READX_PYTHON = python;
  const typst = path.join(root, '.retain-runtime', 'typst', windows ? 'typst.exe' : 'typst');
  if (!env.TYPST_BIN && fs.existsSync(typst)) env.TYPST_BIN = typst;
  env.CBCT_RENDER_ENGINE_DIR = path.join(root, 'resources', 'rendering-engine');
  env.CBCT_TRANSLATED_PDF_FONT_DIR = path.join(root, 'resources', 'fonts');
  env.CBCT_RENDER_SCRIPT = path.join(root, 'scripts', 'render-translated-pdf.cjs');
  return env;
}
