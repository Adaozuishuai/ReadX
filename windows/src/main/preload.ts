// 预加载：只暴露白名单 IPC，渲染进程拿不到 Node 或 fs。

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cbct', {
  info: () => ipcRenderer.invoke('app:info'),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  setLibraryState: (key: string, patch: unknown) => ipcRenderer.invoke('library:setState', key, patch),
  removeFromLibrary: (key: string) => ipcRenderer.invoke('library:remove', key),

  getProfile: () => ipcRenderer.invoke('profile:get'),
  setProfile: (p: unknown) => ipcRenderer.invoke('profile:set', p),

  getText: (key: string) => ipcRenderer.invoke('text:get', key),
  getNote: (key: string) => ipcRenderer.invoke('notes:get', key),
  openPDF: (key: string) => ipcRenderer.invoke('pdf:open', key),
  importPDF: () => ipcRenderer.invoke('pdf:import'),
  pdfBytes: (key: string) => ipcRenderer.invoke('pdf:bytes', key),

  refreshDiscovery: () => ipcRenderer.invoke('discovery:refresh'),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),

  getReading: (key: string) => ipcRenderer.invoke('reading:get', key),
  saveReading: (key: string, patch: unknown) => ipcRenderer.invoke('reading:save', key, patch),

  getCompare: () => ipcRenderer.invoke('compare:get'),
  setCompare: (sel: string[], pinned?: string | null) => ipcRenderer.invoke('compare:set', sel, pinned ?? null),
  compareFields: (keys: string[]) => ipcRenderer.invoke('compare:fields', keys),
  compareWarnings: (rows: Array<[string, string[]]>) => ipcRenderer.invoke('compare:warnings', rows),

  citationPreview: (keys: string[]) => ipcRenderer.invoke('citation:preview', keys),
  citationExport: (keys: string[], format: 'bib' | 'ris') => ipcRenderer.invoke('citation:export', keys, format),

  listIdeas: () => ipcRenderer.invoke('idea:list'),
  saveIdea: (idea: unknown) => ipcRenderer.invoke('idea:save', idea),
  deleteIdea: (id: string) => ipcRenderer.invoke('idea:delete', id),
  importApplication: (paperKey: string, raw: string) => ipcRenderer.invoke('idea:importApplication', paperKey, raw),

  analyzeResults: (key: string, raw: string) => ipcRenderer.invoke('results:analyze', key, raw),
  saveResults: (key: string, raw: string) => ipcRenderer.invoke('results:save', key, raw),
  resultDifference: (key: string, tableID: string, columnID: string, aID: string, bID: string) =>
    ipcRenderer.invoke('results:difference', key, tableID, columnID, aID, bID),

  tagCoverage: () => ipcRenderer.invoke('tags:coverage'),
  getTrend: () => ipcRenderer.invoke('trend:get'),
  checkRedline: (text: string) => ipcRenderer.invoke('trend:checkText', text),

  getReproduction: (key: string) => ipcRenderer.invoke('reproduction:get', key),
  setReproductionTask: (key: string, revision: string, itemID: string, patch: unknown) =>
    ipcRenderer.invoke('reproduction:setTask', key, revision, itemID, patch),
  analyzeReproduction: (key: string, raw: string) => ipcRenderer.invoke('reproduction:analyze', key, raw),
  repoChecks: (snapshot: unknown) => ipcRenderer.invoke('reproduction:repoChecks', snapshot),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch: unknown) => ipcRenderer.invoke('config:set', patch),

  prepareAI: (key: string, question: string, scope: string) => ipcRenderer.invoke('ai:prepare', key, question, scope),
  ask: (req: unknown) => ipcRenderer.invoke('ai:ask', req),
  onDelta: (cb: (s: string) => void) => {
    const h = (_e: unknown, s: string): void => cb(s);
    ipcRenderer.on('ai:delta', h);
    return () => ipcRenderer.removeListener('ai:delta', h);
  },

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  revealRoot: () => ipcRenderer.invoke('root:reveal'),
});
