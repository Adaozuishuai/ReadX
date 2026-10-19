import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopUpdateBridge, DesktopUpdateStatus } from '@cbct/shared';

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

const updateBridge: DesktopUpdateBridge = {
  check: () => ipcRenderer.invoke('readx-updates:check') as Promise<DesktopUpdateStatus>,
  download: () => ipcRenderer.invoke('readx-updates:download') as Promise<DesktopUpdateStatus>,
  install: () => { void ipcRenderer.invoke('readx-updates:install'); },
  onStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: DesktopUpdateStatus) => callback(status);
    ipcRenderer.on('readx-updates:status', listener);
    return () => ipcRenderer.removeListener('readx-updates:status', listener);
  },
};
contextBridge.exposeInMainWorld('__READX_DESKTOP_UPDATES__', updateBridge);
