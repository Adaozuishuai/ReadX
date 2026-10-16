import { contextBridge } from 'electron';

/**
 * 唯一的渲染进程入口凭据通道：主进程用 additionalArguments 传进来，
 * 这里转成 window.__CBCT_V2__ 供 API 客户端读取。不暴露任何 Node 能力。
 */
function readArg(prefix: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

const apiBase = readArg('--cbct-api-base=');
const token = readArg('--cbct-token=');

if (token) {
  contextBridge.exposeInMainWorld('__CBCT_V2__', { apiBase, token });
}
