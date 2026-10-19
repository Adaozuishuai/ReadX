import fs from 'node:fs';
import path from 'node:path';
import { prepareServerRuntime } from './server-runtime.mjs';
import { runGo, v2Paths } from './go.mjs';

const rebuild = process.argv.includes('--force');
const args = ['build', '-trimpath', '-o', v2Paths.serverBin, './cmd/server'];

if (!rebuild && fs.existsSync(v2Paths.serverBin)) {
  const binaryTime = fs.statSync(v2Paths.serverBin).mtimeMs;
  const newer = listGoSources().find((file) => fs.statSync(file).mtimeMs > binaryTime);
  if (!newer) {
    prepareServerRuntime(v2Paths.serverBin);
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
prepareServerRuntime(v2Paths.serverBin);
console.log(`构建完成：${v2Paths.serverBin}（${result.go.version}）`);

function listGoSources() {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'bin') visit(file);
      else if (entry.isFile() && /\.(go|sql|mod|sum)$/.test(entry.name)) files.push(file);
    }
  };
  visit(v2Paths.serverDir);
  return files;
}
