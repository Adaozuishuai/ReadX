import fs from 'node:fs';
import { runGo, v2Paths } from './go.mjs';

const rebuild = process.argv.includes('--force');
const args = ['build', '-trimpath', '-o', v2Paths.serverBin, './cmd/server'];

if (!rebuild && fs.existsSync(v2Paths.serverBin)) {
  const binaryTime = fs.statSync(v2Paths.serverBin).mtimeMs;
  const newer = listGoSources().find((file) => fs.statSync(file).mtimeMs > binaryTime);
  if (!newer) {
    console.log(`server 已是最新：${v2Paths.serverBin}`);
    process.exit(0);
  }
  console.log(`检测到 ${newer} 比二进制更新，重新构建`);
}

fs.mkdirSync(v2Paths.serverDir + '/bin', { recursive: true });
const result = runGo(args, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`go build 失败（exit ${result.status}）`);
  process.exit(result.status ?? 1);
}
console.log(`构建完成：${v2Paths.serverBin}（${result.go.version}）`);

function listGoSources() {
  const out = runGo(['list', '-f', '{{.Dir}}', './...'], { stdio: 'pipe' });
  if (out.status !== 0) return [];
  const dirs = String(out.stdout).split(/\r?\n/).filter(Boolean);
  const files = [];
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.go')) files.push(`${dir}/${entry.name}`);
      if (entry.isFile() && entry.name.endsWith('.sql')) files.push(`${dir}/${entry.name}`);
    }
  }
  return files;
}
