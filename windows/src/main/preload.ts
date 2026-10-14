// 预加载：只暴露白名单 IPC，渲染进程拿不到 Node 或 fs。

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cbct', {
  info: () => ipcRenderer.invoke('app:info'),

  listLibrary: () => ipcRenderer.invoke('library:list'),
  setLibraryState: (key: string, patch: unknown) => ipcRenderer.invoke('library:setState', key, patch),
  removeFromLibrary: (key: string) => ipcRenderer.invoke('library:remove', key),
  restoreFromLibrary: (key: string) => ipcRenderer.invoke('library:restore', key),
  purgeFromLibrary: (key: string) => ipcRenderer.invoke('library:purge', key),
  tagsFor: (key: string) => ipcRenderer.invoke('tags:for', key),

  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  getProgress: (key: string) => ipcRenderer.invoke('progress:get', key),
  saveProgress: (key: string, patch: unknown) => ipcRenderer.invoke('progress:save', key, patch),

  getProfile: () => ipcRenderer.invoke('profile:get'),
  setProfile: (p: unknown) => ipcRenderer.invoke('profile:set', p),

  getText: (key: string) => ipcRenderer.invoke('text:get', key),
  getNote: (key: string) => ipcRenderer.invoke('notes:get', key),
  openPDF: (key: string) => ipcRenderer.invoke('pdf:open', key),
  importPDF: () => ipcRenderer.invoke('pdf:import'),
  pdfBytes: (key: string) => ipcRenderer.invoke('pdf:bytes', key),

  refreshDiscovery: () => ipcRenderer.invoke('discovery:refresh'),
  getDiscovery: () => ipcRenderer.invoke('discovery:get'),

  importPaper: (key: string, force?: boolean) => ipcRenderer.invoke('paper:import', key, force ?? false),
  importPapers: (keys: string[]) => ipcRenderer.invoke('paper:importMany', keys),

  getReading: (key: string) => ipcRenderer.invoke('reading:get', key),
  saveReading: (key: string, patch: unknown) => ipcRenderer.invoke('reading:save', key, patch),
  generateReading: (key: string, kind: string, force?: boolean) => ipcRenderer.invoke('reading:generate', key, kind, force ?? false),
  getReadingCached: (key: string) => ipcRenderer.invoke('reading:cached', key),
  getBaselines: (key?: string) => ipcRenderer.invoke('baseline:get', key),
  getApplication: (key: string) => ipcRenderer.invoke('apply:get', key),

  codeScan: (key: string, url: string) => ipcRenderer.invoke('code:scan', key, url),
  codeGet: (key: string) => ipcRenderer.invoke('code:get', key),
  codeMap: (key: string) => ipcRenderer.invoke('code:map', key),
  codeConfirm: (key: string, id: string, note: string) => ipcRenderer.invoke('code:confirm', key, id, note),

  transcribeFormula: (dataURL: string, feedback?: string) => ipcRenderer.invoke('formula:transcribe', dataURL, feedback ?? ''),
  verifyFormula: (dataURL: string, transcription: string) => ipcRenderer.invoke('formula:verify', dataURL, transcription),
  ocrAvailable: () => ipcRenderer.invoke('ocr:available'),
  ocrPage: (key: string, page: number, dataURL: string) => ipcRenderer.invoke('ocr:page', key, page, dataURL),

  figureLocate: (key: string) => ipcRenderer.invoke('figure:locate', key),
  figureAnalyze: (key: string, dataURL: string) => ipcRenderer.invoke('figure:analyze', key, dataURL),

  retrievalBuild: (key: string, allowEmbedding?: boolean) => ipcRenderer.invoke('retrieval:build', key, allowEmbedding ?? true),
  retrievalStatus: () => ipcRenderer.invoke('retrieval:status'),

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

  // 主进程节流写盘失败的唯一上报通道（IPC handler 已提前返回 ok:true）
  onWriteError: (cb: (msg: string) => void) => {
    const h = (_e: unknown, msg: string): void => cb(msg);
    ipcRenderer.on('write-error', h);
    return () => ipcRenderer.removeListener('write-error', h);
  },

  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  revealRoot: () => ipcRenderer.invoke('root:reveal'),
  openNoteFile: (file: string) => ipcRenderer.invoke('note:openFile', file),
  exportText: (name: string, content: string) => ipcRenderer.invoke('export:text', name, content),
  exportResearch: () => ipcRenderer.invoke('export:research'),
});
