import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeEnvironment } from './platform-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = runtimeEnvironment(root);
const pythonPath = ['pipeline', 'translation', 'base', 'math'].map(name => path.join(root, 'vendor', 'retainpdf', 'backend', name));
env.PYTHONPATH = [...pythonPath, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
function probe(command, args) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message || result.stderr}`);
  console.log(result.stdout.trim());
}
probe(env.READX_PYTHON || 'python3', ['-c', 'import PIL, fitz, pikepdf, requests, urllib3; import retainpdf_pipeline.entrypoints.console; print("Lee Python runtime OK")']);
probe(env.TYPST_BIN || 'typst', ['--version']);
probe(process.execPath, ['-e', 'for(const name of ["fontkit","mathjax-full","pdf-lib"]) require.resolve(name); console.log("Node rendering dependencies OK")']);
for (const file of ['resources/fonts/SourceHanSerifSC-Regular.otf', 'resources/rendering-engine/engine/bin/rpr-retain.js']) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing ${file}`);
}
console.log('OCR/translation/render resources ready. No remote services were called.');
