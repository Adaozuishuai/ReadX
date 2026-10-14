// 主进程：窗口 + IPC。所有文件/网络访问都在主进程完成，渲染进程不直接碰 fs。

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { Paths, findRoot, readJSON, readJSONStrict, saveJSON, atomicWrite, findLocalPdf, readCachedPDFText, OCR_MARKER, isSafeObjectKey, isSafePathKey, assertSafePathKey } from '../core/store';
import { isLikelyScanned as isLikelyScannedText } from '../core/pdfText';
import { streak, weekDays, computeToday, followedTopics, groupByTopic, ProgressMap, localDay } from '../core/dashboard';

import { LibraryStore } from '../core/libraryState';
import { importPaper, ImportResult } from './fetchPaper';
import { decodeQueue, rank, matchesProfile, mergedFirstSeen, entryKey } from '../core/paper';
import { LibraryState, Config, QueueEntry, ResearchProfile, ExperimentExtraction, defaultProfile, defaultLibraryState, PROFILE_KEYWORDS as TOPIC_KEYWORDS } from '../core/types';
import { arxivKey } from '../core/paper';
import { ThrottledWriter } from '../core/throttle';
import { validateIdeaEvidence, validateResearchApplication, decodeResearchApplication, ResearchApplication, IdeaEvidence, defaultResearchIdea } from '../core/idea';
import { validateReproductionAnalysis, decodeReproductionAnalysis, fingerprint as reproductionFingerprint, reproductionGroups, reproductionUnknownCount, repoAuditChecks, defaultReproductionChecklist } from '../core/reproduction';
import { validateResults, validateBindings, decodeResultsAnalysis, calculateDifference, relativePercent, ResultsAnalysis } from '../core/result';
import { loadNotes, noteKey, noteTitle, noteForQueue, Note } from '../core/notes';
import { loadIdeas, saveIdeas, loadReproduction, saveReproduction, loadCompare, saveCompare, writeExport, IdeaFile, ReproductionChecklistDoc } from '../core/persist';
import { bibtexAll, risAll, suggestedFilename } from '../core/citation';
import { orderedKeys as compareOrderedKeys, reconciled as compareReconciled, warnings as comparabilityWarnings } from '../core/compare';
import { derive as deriveSystemTags, coverage as tagCoverage, SYSTEM_TAG_CATEGORIES } from '../core/systemTags';
import { BASELINE_CARDS, matchBaselines, baselineRelation } from '../core/baseline';
import { CodeSnapshot, CodeMappingAnalysis, decodeCodeMapping, validateCodeMapping, mappingID as mappingIDOf } from '../core/codeMapping';
import { scanRepository, snapshotContext } from './repository';
import { ocrImage, ocrAvailable } from './winOcr';
import { retrievalIndex, prewarmRetrievalIndex, retrieveAcrossLibrary, loadIndices, cachedKeys } from './retrieval';
import { libraryContextBlock } from '../core/retrieval';
import { analyzeFigure, locateFigure } from './figureAnalysis';
import { groupsOf } from '../core/evidence';
import { validateExtraction, validateConfiguration } from '../core/evidence';
import { decodeExperiment } from '../core/experiment';
import { findings as trendFindings, sample as trendSample, disclosure as trendDisclosure, gapStatement, violatesRedline, minimumSample as TREND_MIN_SAMPLE } from '../core/trend';
import { askStream, preparePaperMaterial, preparePaperContext, generate, generateValidated, pruneGenerated, readingSystemPrompt, JSON_KINDS, transcribeFormula, verifyFormulaTranscription } from './ai';
import { discover } from './discovery';

let win: BrowserWindow | null = null;
let paths: Paths;

// 写盘节流：首写立即、窗口内合并、退出前冲刷。
// 合并语义在 core/throttle.ts 里，并有回归测试锁住「窗口内编辑不得丢失」。
// 落盘失败必须上报到渲染进程：IPC handler 早已返回 ok:true，静默吞错会让用户
// 以为「自动保存」成功了（磁盘满/只读时实际丢数据）。
function notifyWriteError(key: string, error: unknown): void {
  const msg = `后台落盘失败（${key}）：${error instanceof Error ? error.message : String(error)}`;
  console.error(msg);
  if (win && !win.isDestroyed()) win.webContents.send('write-error', msg);
}
const writer = new ThrottledWriter(600, notifyWriteError);

/**
 * 论文库状态的内存权威副本与节流落盘。
 *
 * 语义与两个必须防住的真实缺陷（丢失更新 / 损坏覆盖）都在 core/libraryState.ts 里，
 * 并有回归测试锁住；这里只持有实例，换工作区时重建。
 */
let library = new LibraryStore('', 600, notifyWriteError); // 真实路径在 app.whenReady 里按工作区根设置

function libState(): Record<string, LibraryState> {
  return library.all();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: '#F4EFE6',
    title: 'CBCT 每日精读',
    webPreferences: {
      // 安全基线：渲染进程无 Node、无直接 fs；所有能力经 IPC 白名单暴露
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 纵深防御：本应用没有任何合法导航/新窗口场景（外链走 shell:openExternal）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function readConfig(): Config {
  const c = readJSON<Config>(paths.configPath, {});
  return c;
}

function profile(): ResearchProfile {
  return { ...defaultProfile(), ...readJSON<Partial<ResearchProfile>>(paths.profilePath, {}) };
}

/** 负反馈主题计数：relevance = -1 的论文，其命中主题累加。 */
function negativeTopics(profileObj: ResearchProfile): Record<string, number> {
  const out: Record<string, number> = {};
  const states = libState();
  const queue = decodeQueue(readJSON<unknown>(paths.queuePath, { papers: [] }));
  for (const p of queue) {
    const st = states[p.arxiv ? arxivKey(p.arxiv) : (p.id ?? '')];
    if (!st || st.relevance !== -1) continue;
    const text = ((p.title ?? '') + ' ' + (p.abstract ?? '')).toLowerCase();
    for (const [topic, weight] of Object.entries(profileObj.topics)) {
      if (weight <= 0) continue;
      const kws = TOPIC_KEYWORDS[topic] ?? [];
      if (kws.some((k) => text.includes(k))) out[topic] = (out[topic] ?? 0) + 1;
    }
  }
  return out;
}



/**
 * 组装论文库条目：队列 + 笔记，合并库状态与推荐理由。
 * 抽成函数是因为引用导出、系统标签、趋势分析都要用同一份权威列表；
 * 各自重算会导致「界面看到的」与「导出/统计用的」不一致。
 */
function libraryItems(): Array<ReturnType<typeof buildItem>> {
  const queue = decodeQueue(readJSON<unknown>(paths.queuePath, { papers: [] }));
  const { notes } = loadNotes(paths.papersDir);
  const states = libState();
  const prof = profile();
  const neg = negativeTopics(prof);

  const buildItem = (p: QueueEntry, note: Note | null) => {
    const key = note ? noteKey(note) : (p.arxiv ? arxivKey(p.arxiv) : (p.id ?? ''));
    const st = states[key] ?? defaultLibraryState();
    const r = rank(p, prof, st, neg);
    return {
      key,
      paper: { ...p, title: p.title ?? (note ? noteTitle(note) : key) } as QueueEntry,
      state: st,
      score: r.score,
      reasons: r.reasons,
      matchesProfile: matchesProfile(r),
      hasPDF: !!findLocalPdf(paths, key),
      hasText: !!readCachedPDFText(paths, key),
      hasNote: !!note,
      noteFile: note?.file ?? null,
      venue: note?.meta.venue ?? p.venue ?? '',
      kind: note ? 'note' as const : 'queue' as const,
      // 主题匹配关键词：与 Profile 的关注主题一致，供前端「主题花园/知识图谱」过滤用
      topicKeywords: TOPIC_KEYWORDS,
    };
  };

  const items = queue.map((p) => buildItem(p, noteForQueue(notes, p)));

  // 有笔记但不在队列里的论文同样必须可见（macOS 版的「今日」就优先取这类论文）。
  // 否则「唯一有全文缓存与笔记的论文」在 Windows 版完全看不到——是功能缺失，不是空列表。
  const seen = new Set(items.map((i) => i.key));
  for (const note of notes) {
    const key = noteKey(note);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(buildItem({
      arxiv: note.meta.arxiv ?? undefined,
      id: note.id,
      title: noteTitle(note),
      venue: note.meta.venue ?? undefined,
    }, note));
  }
  return items;
}


/** 按 key 找笔记（系统标签要合并笔记 frontmatter 与正文段落作为匹配文本）。 */
function findNote(key: string): Note | null {
  const { notes } = loadNotes(paths.papersDir);
  return notes.find((n) => noteKey(n) === key) ?? null;
}

/**
 * 汇总用于派生系统标签的文本片段：标题/摘要/venue/why + 已抽取实验字段 + 笔记 frontmatter 与正文。
 * 只读、无副作用，不写入用户自建标签（两者并存）。
 */
function tagFieldsFor(paper: QueueEntry, note: Note | null): string[] {
  const fields: string[] = [];
  for (const v of [paper.title, paper.abstract, paper.venue, paper.why]) if (v) fields.push(v);
  // 已抽取的实验字段让 views/dataset/metrics 也进入匹配范围
  const reading = readJSONStrict<Record<string, unknown>>(paths.readingsPath(paper.arxiv ? arxivKey(paper.arxiv) : (paper.id ?? '')));
  if (reading.ok && typeof reading.value.experimentJSON === 'string') {
    try {
      const ex = JSON.parse((reading.value.experimentJSON as string).replace(/^```[a-z]*\n?|```$/g, '')) as ExperimentExtraction;
      for (const [, , items] of groupsOf(ex)) for (const it of items) { fields.push(it.k); fields.push(it.v); }
    } catch { /* 损坏的抽取结果不参与标签派生，不影响其它字段 */ }
  }
  if (note) {
    for (const v of Object.values(note.meta)) if (v) fields.push(v);
    for (const body of Object.values(note.sections)) if (body) fields.push(body);
  }
  return fields.filter((x) => x && x.length > 0);
}

function registerIPC(): void {
  ipcMain.handle('app:info', () => ({
    root: paths.root,
    version: app.getVersion(),
    hasConfig: !!readConfig().baseURL,
    configPath: paths.configPath,
  }));

  // ---- 队列 + 论文库 ----
  ipcMain.handle('library:list', () => libraryItems().map((i) => ({
    ...i,
    systemTags: deriveSystemTags(tagFieldsFor(i.paper, findNote(i.key))),
  })));

  // 系统标签（PRD 7.2）：只做「文本里确实出现」的关键词匹配，命不中就是空，绝不推测。
  ipcMain.handle('tags:coverage', () => {
    const items = libraryItems();
    const all = items.flatMap((i) => deriveSystemTags(tagFieldsFor(i.paper, findNote(i.key))));
    return {
      categories: SYSTEM_TAG_CATEGORIES,
      coverage: tagCoverage(all).map(([category, count]) => ({ category, count })),
      total: all.length,
      papers: items.length,
    };
  });

  // 趋势 / Research Gap（PRD 4.16）：样本不足必须拒绝给出趋势判断。
  ipcMain.handle('trend:get', () => {
    const items = libraryItems();
    const papers = items.map((i) => i.paper);
    const smp = trendSample(papers);
    const tagMap = new Map(items.map((i) => [i.key, deriveSystemTags(tagFieldsFor(i.paper, findNote(i.key)))]));
    const found = trendFindings(papers, (p) => {
      const key = p.arxiv ? arxivKey(p.arxiv) : (p.id ?? '');
      return tagMap.get(key) ?? [];
    });
    return {
      sample: smp,
      minimumSample: TREND_MIN_SAMPLE,
      findings: found.map((f) => ({ ...f, disclosure: trendDisclosure(f) })),
      // 缺口表述必须是「检索范围内未见」，且自身要通过红线自检
      gapExample: gapStatement('示例主题', smp),
    };
  });

  // 红线自检：把待输出文本送回校验，命中「首次」类措辞即拒绝
  ipcMain.handle('trend:checkText', (_e, text: string) => ({ violates: violatesRedline(text) }));
  // 笔记内容（精读框架的六个段落），供阅读器左侧展示
  ipcMain.handle('notes:get', (_e, key: string) => {
    const { notes, failed } = loadNotes(paths.papersDir);
    const note = notes.find((n) => noteKey(n) === key) ?? null;
    return note ? { ok: true, note: { id: note.id, file: note.file, title: noteTitle(note), meta: note.meta, sections: note.sections } } : { ok: false, failed };
  });

  ipcMain.handle('library:setState', (_e, key: string, patch: Partial<LibraryState>) => {
    return library.set(key, patch);
  });

  ipcMain.handle('library:remove', (_e, key: string) => {
    // 回收站语义：标记 deleted，不物理删除，可在库中恢复。
    // 与草稿写入共用同一份内存状态与同一个节流器，否则会互相覆盖（论文复活）。
    return library.remove(key);
  });
  ipcMain.handle('library:restore', (_e, key: string) => library.restore(key));
  ipcMain.handle('library:purge', (_e, key: string) => library.purge(key));

  /** 单篇系统标签：合并标题/摘要/venue/why + 已抽取实验字段 + 笔记，派生八类标签。 */
  ipcMain.handle('tags:for', (_e, key: string) => {
    const item = libraryItems().find((i) => i.key === key);
    if (!item) return { ok: false, tags: [] };
    return { ok: true, tags: deriveSystemTags(tagFieldsFor(item.paper, findNote(key))) };
  });

  // ---- 画像 ----
  ipcMain.handle('profile:get', () => profile());
  ipcMain.handle('profile:set', (_e, p: ResearchProfile) => {
    saveJSON(paths.profilePath, p);
    return p;
  });

  // ---- 原文与全文 ----
  ipcMain.handle('text:get', (_e, key: string) => {
    const text = readCachedPDFText(paths, key);
    return text ? { text, isOCR: text.startsWith('【OCR') } : { text: null, isOCR: false };
  });

  ipcMain.handle('pdf:open', async (_e, key: string) => {
    const file = findLocalPdf(paths, key);
    if (!file) return { ok: false, error: '本地没有该论文的 PDF' };
    const err = await shell.openPath(file);
    return err ? { ok: false, error: err } : { ok: true, path: file };
  });

  ipcMain.handle('pdf:import', async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: '导入 PDF', filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    const src = r.filePaths[0];
    const base = path.basename(src);
    const dst = path.join(paths.libraryDir, base);
    fs.mkdirSync(paths.libraryDir, { recursive: true });
    fs.copyFileSync(src, dst);
    return { ok: true, name: base };
  });

  // 返回 PDF 文件字节供渲染进程用 pdf.js 显示（避免 file:// 与沙箱问题）
  ipcMain.handle('pdf:bytes', (_e, key: string) => {
    const file = findLocalPdf(paths, key);
    if (!file) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  });

  // ---- 发现 ----
  ipcMain.handle('discovery:refresh', async () => {
    const cache = readJSON<{ papers: QueueEntry[]; preprints?: QueueEntry[]; fetchedAt: string; errors: string[]; firstSeen: Record<string, string> }>(
      paths.discoveryPath, { papers: [], preprints: [], fetchedAt: '', errors: [], firstSeen: {} },
    );
    const result = await discover();
    const day = new Date().toISOString().slice(0, 10);
    // 单源失败（如 Semantic Scholar 限流 429）时保留上次缓存里属于该源的条目：
    // 否则一次失败就会把整个「期刊会议」feed 从发现缓存里冲掉，界面却写着「已保留上次结果」。
    let papers = result.papers;
    let preprints = result.preprints;
    if (result.errors.length) {
      const failedLabels = new Set(result.errors.map((e) => e.split(' ')[0]));
      const freshKeys = new Set([...result.papers, ...result.preprints].map(entryKey));
      const sourceLabel = (e: QueueEntry): string => {
        const s = e.source ?? '';
        if (s === 'pubmed') return 'PubMed';
        if (s === 'arXiv 预印本') return 'arXiv';
        return '期刊会议';
      };
      const keep = (list: QueueEntry[] | undefined): QueueEntry[] =>
        (list ?? []).filter((e) => failedLabels.has(sourceLabel(e)) && !freshKeys.has(entryKey(e)));
      papers = [...result.papers, ...keep(cache.papers)];
      preprints = [...result.preprints, ...keep(cache.preprints)];
    }
    const allPapers = [...papers, ...preprints];
    const next = {
      papers,
      preprints,
      fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      errors: result.errors,
      firstSeen: mergedFirstSeen(cache.firstSeen ?? {}, allPapers, day),
    };
    saveJSON(paths.discoveryPath, next);
    return next;
  });

  ipcMain.handle('discovery:get', () => readJSON(paths.discoveryPath, { papers: [], preprints: [], fetchedAt: '', errors: [], firstSeen: {} }));

  // ---- 工作台聚合（复刻 macOS FunHome 的派生量）----
  const progressMap = (): ProgressMap => readJSON<ProgressMap>(paths.progressPath, {});
  const noteEntries = (): Array<{ id: string; key: string; title: string; venue: string; dateRead: string; sections: Record<string, string> }> => {
    const { notes } = loadNotes(paths.papersDir);
    return notes.map((n) => ({
      id: n.id, key: noteKey(n), title: noteTitle(n),
      venue: n.meta.venue ?? '', dateRead: n.meta.date_read ?? '', sections: n.sections,
    }));
  };

  ipcMain.handle('dashboard:get', () => {
    const items = libraryItems();
    const prof = profile();
    const prog = progressMap();
    const states = libState();
    const stateOf = (k: string): LibraryState => states[k] ?? defaultLibraryState();
    const notes = noteEntries();
    const topics = followedTopics(prof.topics);

    const saved = items.filter((i) => i.state.status !== 'deleted');
    const ranked = saved
      .filter((i) => i.state.status !== 'ignored' && i.state.relevance >= 0)
      .sort((a, b) => (a.score === b.score ? String(b.paper.published ?? '').localeCompare(String(a.paper.published ?? '')) : b.score - a.score));

    const todayEntry = computeToday(
      notes, ranked.map((r) => ({ key: r.key, title: r.paper.title ?? r.key, venue: r.venue })),
      stateOf, prog,
    );

    const disc = readJSON<{ papers?: QueueEntry[]; preprints?: QueueEntry[]; firstSeen?: Record<string, string>; fetchedAt?: string; errors?: string[] }>(
      paths.discoveryPath, { papers: [], preprints: [], fetchedAt: '', errors: [], firstSeen: {} },
    );
    const day = localDay(new Date());
    const firstSeen = disc.firstSeen ?? {};
    const todayNew = (disc.papers ?? []).filter((p) => firstSeen[entryKey(p)] === day);
    const todayNewPreprints = (disc.preprints ?? []).filter((p) => firstSeen[entryKey(p)] === day);

    return {
      streak: streak(prog),
      week: weekDays(prog),
      today: todayEntry,
      unreadCount: saved.filter((i) => ['unread', 'later', 'reading'].includes(i.state.status)).length,
      readCount: saved.filter((i) => i.state.status === 'read').length,
      preprints: (disc.preprints ?? []).length,
      fetchedAt: disc.fetchedAt ?? '',
      errors: disc.errors ?? [],
      todayNewCount: todayNew.filter((p) => (p.source ?? '') !== 'PubMed' && !(p.source ?? '').toLowerCase().includes('arxiv')).length,
      todayNewPubmed: todayNew.filter((p) => (p.source ?? '') === 'PubMed').length,
      todayNewPreprints: todayNewPreprints.length,
      topics,
      topicGroups: groupByTopic(ranked, topics).map(([t, rs]) => ({ topic: t, papers: rs.map((r) => ({ key: r.key, title: r.paper.title ?? r.key, score: r.score, venue: r.venue, reasons: r.reasons })) })),
      // 推荐前若干（主 feed：非预印本）
      picks: ranked.filter((i) => !(i.paper.source ?? '').toLowerCase().includes('arxiv')).slice(0, 6)
        .map((i) => ({ key: i.key, title: i.paper.title ?? i.key, score: i.score, venue: i.venue, source: i.paper.source ?? '', reasons: i.reasons, matchesProfile: i.matchesProfile, hasText: i.hasText, hasPDF: i.hasPDF, abstract: i.paper.abstract ?? '' })),
      preprintPicks: ranked.filter((i) => (i.paper.source ?? '').toLowerCase().includes('arxiv')).slice(0, 6)
        .map((i) => ({ key: i.key, title: i.paper.title ?? i.key, score: i.score, venue: i.venue, source: i.paper.source ?? '', reasons: i.reasons, hasText: i.hasText, hasPDF: i.hasPDF, abstract: i.paper.abstract ?? '' })),
      ideasLinkedCount: (() => { const r = loadIdeas(paths); return r.ok ? r.value.ideas.filter((x) => (x.evidence ?? []).length > 0).length : 0; })(),
    };
  });

  // ---- 阅读进度（第④步的反思/批注 + 连续阅读）----
  ipcMain.handle('progress:get', (_e, key: string) => (progressMap()[key] ?? {}));
  ipcMain.handle('progress:save', (_e, key: string, patch: Record<string, unknown>) => {
    // all['__proto__'] = ... 会走 setter 污染原型（旧 C3）；损坏时静默当空再整文件覆盖
    // 会丢掉全部阅读历史（旧 H9），与 library.json 的「损坏拒写」策略保持一致。
    if (!isSafeObjectKey(key)) return { ok: false, error: '非法 key（__proto__ 等保留名或空值，已拒绝）' };
    const r = readJSONStrict<ProgressMap>(paths.progressPath);
    if (!r.ok && !r.missing) return { ok: false, error: `progress.json 已损坏，未保存以免覆盖：${r.error}` };
    const all = r.ok ? r.value : {};
    const cur = Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
    all[key] = { ...(cur ?? {}), ...patch } as any;
    saveJSON(paths.progressPath, all);
    return { ok: true, value: all[key] };
  });

  // ---- 自动导入（下载 PDF + 抽取全文）----
  /** 按 key 找论文条目（含 pdfUrl）：先查论文库（队列+笔记），再查发现缓存。 */
  const paperByKey = (key: string): QueueEntry | null => {
    const fromLib = libraryItems().find((i) => i.key === key);
    if (fromLib) return fromLib.paper;
    const disc = readJSON<{ papers?: QueueEntry[]; preprints?: QueueEntry[] }>(paths.discoveryPath, {});
    for (const p of [...(disc.papers ?? []), (disc.preprints ?? [])].flat()) {
      if (entryKey(p) === key) return p;
    }
    return null;
  };

  /**
   * 把论文并入 queue.json（若尚无）。
   * 目的是让自动下载的论文成为论文库的一等公民（能被搜索、对比、记笔记）；
   * 保持 `{ "papers": [...] }` 对象格式，与 decodeQueue 兼容、不破坏手工条目。
   */
  const ensureInQueue = (paper: QueueEntry): void => {
    // 损坏时抛错拒写：静默回退 {papers:[]} 再保存会把整个队列（含手工条目）覆盖没。
    const r = readJSONStrict<unknown>(paths.queuePath);
    if (!r.ok && !r.missing) throw new Error(`queue.json 已损坏，未写入队列以免覆盖：${r.error}`);
    const raw = r.ok ? r.value : { papers: [] };
    const papers = decodeQueue(raw);
    const key = entryKey(paper);
    if (papers.some((p) => entryKey(p) === key)) return;
    const merged = [...papers, paper];
    saveJSON(paths.queuePath, { papers: merged });
  };

  ipcMain.handle('paper:import', async (_e, key: string, force = false) => {
    const paper = paperByKey(key);
    if (!paper) return { ok: false, key, error: '找不到该论文的条目（可能不在队列或发现缓存中）' };
    const r = await importPaper(paths, key, paper.pdfUrl, force);
    // 只有真的拿到全文才入队：避免把「下载失败/扫描件」的条目污染论文库
    if (r.ok) {
      try { ensureInQueue(paper); }
      catch (e) { return { ...r, warning: e instanceof Error ? e.message : String(e) }; }
    }
    return r;
  });

  /** 批量导入：逐篇下载，如实报告每篇结果（单篇失败不影响其它）。 */
  ipcMain.handle('paper:importMany', async (_e, keys: string[]) => {
    const results: ImportResult[] = [];
    for (const key of keys ?? []) {
      const paper = paperByKey(key);
      if (!paper) { results.push({ ok: false, key, error: '找不到该论文条目' }); continue; }
      const r = await importPaper(paths, key, paper.pdfUrl, false);
      if (r.ok) {
        try { ensureInQueue(paper); }
        catch (e) { results.push({ ...r, warning: e instanceof Error ? e.message : String(e) }); continue; }
      }
      results.push(r);
    }
    return {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  });

  // ---- 阅读记录 ----
  ipcMain.handle('reading:get', (_e, key: string) => {
    const r = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    if (r.ok) return { ok: true, value: r.value };
    // 损坏必须显式报错：静默回退默认值会在下次保存时覆盖用户数据
    return { ok: false, missing: r.missing, error: r.error };
  });

  ipcMain.handle('reading:save', (_e, key: string, patch: Record<string, unknown>) => {
    const cur = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    // 损坏时必须报错，不能回退成 {}：否则这次保存会把改坏的旧解析直接覆盖掉，
    // 与 reading:get 的显式报错、以及「损坏的 JSON 不静默回退」的硬约束相矛盾。
    if (!cur.ok && !cur.missing) return { ok: false, error: `阅读记录已损坏，未保存以免覆盖：${cur.error}` };
    const base = cur.ok ? cur.value : {};
    const next = { ...base, ...patch, key, updatedAt: { ...(base.updatedAt as object ?? {}), draft: new Date().toISOString() } };
    writer.schedule(`reading:${key}`, () => saveJSON(paths.readingsPath(key), next));
    return { ok: true };
  });

  // ---- 分层精读生成（TL;DR / 5min / Critical / 动机 / 方法公式 / 实验 / 结果 / 迁移）----
  /**
   * 生成一类精读产物并落盘到 `app/data/readings/<key>.json`。
   * 结构化 kind（experiment/results/apply）在保存前必须过证据校验：
   * 每个事实要有页码 + 逐字摘录（apply 还要求至少一条真实页码依据），否则拒绝保存。
   */
  ipcMain.handle('reading:generate', async (_e, key: string, kind: string, force = false) => {
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '没有该论文的全文缓存，无法做事实分析。请先「下载并导入全文」。' };

    // 已有缓存且非强制：直接返回（避免重复消耗）
    const store = readJSONStrict<Record<string, any>>(paths.readingsPath(key));
    const base = store.ok ? store.value : {};
    const field: Record<string, string> = { tldr: 'tldr', deep: 'deep', critical: 'critical', motivation: 'motivation', method: 'method', experiment: 'experimentJSON', results: 'resultsJSON', apply: 'applicationJSON' };
    // kind 白名单：否则任意字符串都会成为 reading JSON 的字段名（可覆盖 key/updatedAt 等）
    if (!Object.prototype.hasOwnProperty.call(field, kind)) {
      return { ok: false, error: `未知的精读类型：${String(kind).slice(0, 40)}` };
    }
    const cacheKey = field[kind];
    if (!force && typeof base[cacheKey] === 'string' && base[cacheKey].trim()) {
      return { ok: true, kind, cached: true, value: base[cacheKey] };
    }

    const cfg = readConfig();
    const { material } = preparePaperContext(text, kind, '全文');
    const sys = readingSystemPrompt(kind, material);

    // 生成 + 自动修正重试（校验失败把错误回喂模型逐条改，最多 2 轮）
    const g = await generateValidated(cfg, kind, sys, text);
    if (!g.ok) return { ok: false, error: g.error };
    const value = g.value;
    const validationError = g.validationError;
    const attempts = g.attempts;

    const cur = readJSONStrict<Record<string, any>>(paths.readingsPath(key));
    if (!cur.ok && !cur.missing) return { ok: false, error: `阅读记录已损坏，未保存以免覆盖：${cur.error}` };
    const nextBase = cur.ok ? cur.value : {};

    if (JSON_KINDS.has(kind) && validationError) {
      // 兜底修剪：不消耗 API，把无法逐字核验的事实降级/剔除后重新校验。
      // 修剪成功 = 通过校验的「部分事实 + 显式未知」，降级清单如实展示给用户。
      const pruned = pruneGenerated(kind, value, text);
      if (pruned) {
        const next: Record<string, any> = { ...nextBase, [cacheKey]: pruned.value, key, updatedAt: { ...(nextBase.updatedAt as object ?? {}), [kind]: new Date().toISOString() } };
        if (pruned.demoted.length) next[cacheKey + 'Demoted'] = pruned.demoted; else delete next[cacheKey + 'Demoted'];
        delete next[cacheKey + 'Validation'];
        saveJSON(paths.readingsPath(key), next);
        return { ok: true, kind, value: pruned.value, demoted: pruned.demoted, attempts };
      }
      // 修剪也无法收敛：失败原文落盘备查（噪音静默记录，不打断）
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        atomicWrite(path.join(paths.dataDir, 'generate-errors', `${key}-${kind}-${stamp}.json`),
          JSON.stringify({ key, kind, at: new Date().toISOString(), attempts, error: validationError, raw: value }, null, 2));
      } catch { /* 备查落盘失败不影响主流程 */ }
      // 已有通过校验的旧结果：保留旧的，只报错，不用未核验内容覆盖可信数据
      const hadGood = typeof nextBase[cacheKey] === 'string' && String(nextBase[cacheKey]).trim() && !nextBase[cacheKey + 'Validation'];
      if (hadGood) return { ok: false, error: `校验未通过（已自动修正 ${attempts - 1} 次），已保留原有结果：${validationError}`, raw: value };
      // 没有旧的可信结果：降级保存并打「未核验」标记——面板永远出得来结果，但不伪造校验背书
      const next = { ...nextBase, [cacheKey]: value, [cacheKey + 'Validation']: { ok: false, error: validationError, attempts, at: new Date().toISOString() }, key, updatedAt: { ...(nextBase.updatedAt as object ?? {}), [kind]: new Date().toISOString() } };
      saveJSON(paths.readingsPath(key), next);
      return { ok: true, kind, value, unverified: validationError, attempts };
    }

    const next: Record<string, any> = { ...nextBase, [cacheKey]: value, key, updatedAt: { ...(nextBase.updatedAt as object ?? {}), [kind]: new Date().toISOString() } };
    delete next[cacheKey + 'Validation'];   // 本次通过校验：清掉旧的未核验标记
    saveJSON(paths.readingsPath(key), next);
    return { ok: true, kind, value, attempts };
  });

  ipcMain.handle('reading:cached', (_e, key: string) => {
    const r = readJSONStrict<Record<string, any>>(paths.readingsPath(key));
    return r.ok ? r.value : {};
  });

  /** Baseline 方法卡片（PRD 4.7）：领域常识卡片 + 与当前论文已抽取基线的关系。 */
  ipcMain.handle('baseline:get', (_e, key?: string) => {
    let names: string[] = [];
    if (key) {
      const r = readJSONStrict<Record<string, any>>(paths.readingsPath(key));
      if (r.ok && typeof r.value.experimentJSON === 'string') {
        try {
          const ex = JSON.parse((r.value.experimentJSON as string).replace(/^```[a-z]*\n?|```$/g, ''));
          names = (ex.baselines ?? []).map((f: any) => String(f?.v ?? '')).filter(Boolean);
        } catch { /* 损坏的抽取结果不参与匹配 */ }
      }
      // 笔记 frontmatter 里的 baselines 也并入匹配
      const note = findNote(key);
      if (note?.sections?.experiments) {
        const m = note.sections.experiments.match(/[A-Za-z0-9²^\-]{3,}/g) ?? [];
        names = names.concat(m);
      }
    }
    return { cards: BASELINE_CARDS, matched: matchBaselines(names).map((x) => ({ ...x.card, relation: baselineRelation(x.card, names) })) };
  });

  /** 迁移建议（apply）产物读取：作为 Idea 附件来源。 */
  ipcMain.handle('apply:get', (_e, key: string) => {
    const r = readJSONStrict<Record<string, any>>(paths.readingsPath(key));
    if (!r.ok || typeof r.value.applicationJSON !== 'string') return { ok: false };
    try {
      const app = decodeResearchApplication(r.value.applicationJSON as string);
      validateResearchApplication(app, readCachedPDFText(paths, key) ?? '');
      return { ok: true, application: app };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /** 行内/独立公式的视觉转写与核对（移植自 macOS transcribeFormula / verifyFormulaTranscription）。 */
  ipcMain.handle('formula:transcribe', async (_e, dataURL: string, feedback = '') => {
    return transcribeFormula(readConfig(), dataURL, feedback);
  });
  ipcMain.handle('formula:verify', async (_e, dataURL: string, transcription: string) => {
    return verifyFormulaTranscription(readConfig(), dataURL, transcription);
  });

  // ---- 架构图解析（FigureAnalysis）----
  ipcMain.handle('figure:locate', (_e, key: string) => {
    const text = readCachedPDFText(paths, key) ?? '';
    return locateFigure(text) ?? null;
  });
  ipcMain.handle('figure:analyze', async (_e, key: string, dataURL: string) => {
    return analyzeFigure(paths, readConfig(), key, dataURL);
  });

  // ---- 扫描版 PDF 的页面 OCR（Windows 内置 OCR，无需下载模型）----
  ipcMain.handle('ocr:available', () => ocrAvailable());
  ipcMain.handle('ocr:page', async (_e, key: string, page: number, dataURL: string) => {
    const r = await ocrImage(dataURL);
    if (!r.ok) return { ok: false, error: r.error };
    const text = r.text ?? '';
    if (!text.trim()) return { ok: false, error: '该页没有识别出文字（可能是纯图片页）。' };
    // IPC 边界也要校验页码：page 会被插进页标记与正则，非法值会写出永不匹配的坏块。
    const pageNo = Number(page) | 0;
    if (!(pageNo >= 1)) return { ok: false, error: '页码无效（需为 ≥ 1 的整数）。' };
    // 写入/合并到 library/text/<key>-v3.txt，带页标记（与 macOS 版同一格式）。
    const textPath = paths.pdfTextPath(key);
    let existing = '';
    try { existing = fs.readFileSync(textPath, 'utf8'); } catch { /* 首次 OCR */ }
    // 只要这份缓存里含有 OCR 页，整份文件就必须带 OCR 标记：
    // 否则 text:get 不会报 isOCR，机器识别文本会被当作原文通过摘录校验（证据来源丢失）。
    const scanned = isLikelyScannedText(existing);
    const base = (!existing || scanned) ? '' : existing.replace(OCR_MARKER, '').replace(/^\n+/, '');
    const body0 = base ? (() => {
      const re = new RegExp(`=== Page ${pageNo} ===\\n[\\s\\S]*?(?=\\n=== Page |$)`);
      // 函数式替换：OCR 文本是替换串时 $&/$1 等会被展开（旧 H4），把页块内容复制错置。
      return re.test(base) ? base.replace(re, () => `=== Page ${pageNo} ===\n${text}`) : base.replace(/\s+$/, '') + `\n\n=== Page ${pageNo} ===\n${text}`;
    })() : `=== Page ${pageNo} ===\n${text}`;
    // 只要这份缓存里含有 OCR 页，整份文件就必须带 OCR 标记：
    // 否则 text:get 不会报 isOCR，机器识别文本会被当作原文通过摘录校验（证据来源丢失）。
    atomicWrite(textPath, OCR_MARKER + '\n' + body0 + '\n');
    return { ok: true, page: pageNo, chars: text.length, lines: text.split('\n').length };
  });

  // ---- 论文 ↔ 代码映射（PRD 4.9）----
  const codePath = (key: string): string => path.join(paths.dataDir, 'code', `${assertSafePathKey(key)}.json`);

  /** 扫描公开 GitHub 仓库，固定 commit，落盘快照。token 只从配置读取，不进 prompt。 */
  ipcMain.handle('code:scan', async (_e, key: string, url: string) => {
    try {
      const cfg = readConfig();
      const snapshot = await scanRepository(url, key, cfg.githubToken ?? null);
      fs.mkdirSync(path.dirname(codePath(key)), { recursive: true });
      saveJSON(codePath(key), snapshot);
      return { ok: true, snapshot: { repository: snapshot.repository, commit: snapshot.commit, files: snapshot.files.length, paths: snapshot.paths.length, warnings: snapshot.warnings, fileList: snapshot.files.map((f) => ({ path: f.path, category: f.category, lines: f.text.split('\n').length })) } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('code:get', (_e, key: string) => {
    const r = readJSONStrict<CodeSnapshot>(codePath(key));
    if (!r.ok) return { ok: false, missing: r.missing };
    const s = r.value;
    let analysis: CodeMappingAnalysis | null = null;
    let validateError: string | null = null;
    if (typeof s.mappingJSON === 'string') {
      try { analysis = decodeCodeMapping(s.mappingJSON); validateCodeMapping(analysis, s); }
      catch (e) { validateError = e instanceof Error ? e.message : String(e); }
    }
    return { ok: true, snapshot: { repository: s.repository, commit: s.commit, scannedAt: s.scannedAt, files: s.files.length, paths: s.paths.length, warnings: s.warnings, fileList: s.files.map((f) => ({ path: f.path, category: f.category, lines: f.text.split('\n').length })) }, analysis, validateError, confirmations: s.confirmations ?? {} };
  });

  /** 生成映射：调用 AI，校验后落盘（校验失败不覆盖旧结果）。 */
  ipcMain.handle('code:map', async (_e, key: string) => {
    const r = readJSONStrict<CodeSnapshot>(codePath(key));
    if (!r.ok) return { ok: false, error: '还没有仓库快照，请先扫描仓库。' };
    const snapshot = r.value;
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '没有论文全文缓存，无法生成映射。' };
    const cfg = readConfig();
    const { material } = preparePaperContext(text, 'method', '全文');
    const sys = readingSystemPrompt('code', material) + '\n\n【仓库代码（固定 commit）】\n' + snapshotContext(snapshot);
    const res = await generate(cfg, sys, '请生成论文概念到代码的映射 JSON。');
    if (!res.ok) return { ok: false, error: res.error };
    let analysis: CodeMappingAnalysis;
    try {
      analysis = decodeCodeMapping(res.text as string);
      validateCodeMapping(analysis, snapshot);
      // 论文依据也过 evidence 校验（页码必须真实存在）
      for (const m of analysis.mappings) {
        validateExtraction({ dataset: [m.paper], acquisition: [], training: [], loss: [], metrics: [], results: [] }, text);
      }
    } catch (e) {
      return { ok: false, error: `校验未通过，未覆盖旧快照：${e instanceof Error ? e.message : String(e)}`, raw: res.text };
    }
    const next: CodeSnapshot = { ...snapshot, mappingJSON: res.text as string, mappingSource: text };
    saveJSON(codePath(key), next);
    return { ok: true, analysis };
  });

  /** 人工核对 / 明确映射：保存某条映射的核对说明。 */
  ipcMain.handle('code:confirm', (_e, key: string, mappingID: string, note: string) => {
    const r = readJSONStrict<CodeSnapshot>(codePath(key));
    if (!r.ok) return { ok: false, error: '没有仓库快照' };
    const snapshot = r.value;
    if (typeof snapshot.mappingJSON === 'string') {
      try {
        const a = decodeCodeMapping(snapshot.mappingJSON);
        if (!a.mappings.some((m) => mappingIDOf(m) === mappingID)) return { ok: false, error: '找不到该映射' };
      } catch { return { ok: false, error: '快照里的映射无法解析' }; }
    }
    const confirmations = { ...(snapshot.confirmations ?? {}) };
    if (note.trim()) confirmations[mappingID] = note.trim(); else delete confirmations[mappingID];
    saveJSON(codePath(key), { ...snapshot, confirmations });
    return { ok: true, confirmations };
  });

  // 对比用字段：来自笔记 frontmatter（论文级事实），不是库状态。
  // 库状态只有 status/favorite/tags/notes/relevance/corrections，
  // 把 views/geometry/datasets 当库状态读会永远得到「尚未抽取」，可比性检查也就永远不会触发。
  ipcMain.handle('compare:fields', (_e, keys: string[]) => {
    const { notes } = loadNotes(paths.papersDir);
    const items = libraryItems();
    return keys.map((key) => {
      const note = notes.find((n) => noteKey(n) === key) ?? null;
      const readings = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
      let ex: ExperimentExtraction | null = null;
      if (readings.ok && typeof readings.value.experimentJSON === 'string') {
        try { ex = JSON.parse((readings.value.experimentJSON as string).replace(/^```[a-z]*\n?|```$/g, '')) as ExperimentExtraction; } catch { ex = null; }
      }
      const fromExtraction = (names: string[]): string => {
        if (!ex) return '';
        for (const [, , items2] of groupsOf(ex)) {
          for (const it of items2) if (names.some((n) => it.k.includes(n)) && it.v && it.v !== '论文未说明') return it.v;
        }
        return '';
      };
      const item = items.find((i) => i.key === key);
      return {
        key,
        title: item?.paper.title ?? key,
        venue: note?.meta.venue ?? item?.paper.venue ?? '论文未说明',
        year: note?.meta.date_read ?? item?.paper.year ?? item?.paper.published ?? '尚未抽取',
        // 视角数 / 几何 / 数据集：优先笔记 frontmatter，其次已抽取实验字段，最后如实标未知
        views: (note?.meta.views ?? fromExtraction(['views', '视角', '投影'])) || '尚未抽取',
        geometry: (note?.meta.geometry ?? fromExtraction(['几何', 'geometry', 'acquisition'])) || '尚未抽取',
        datasets: (note?.meta.data ?? fromExtraction(['数据集', 'dataset', 'data'])) || '尚未抽取',
      };
    });
  });

  // ---- 结果分析（含列序位置校验）----
  /**
   * 结果表校验是可信度关键路径：集合语义（数字 ∈ 该行摘录）挡不住**列置换**，
   * 必须再按表头列顺序逐字校验。界面入口必须走这里，不能让模型输出直接落盘。
   */
  ipcMain.handle('results:analyze', (_e, key: string, raw: string) => {
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '没有该论文的全文缓存，无法校验结果表的原文依据。' };
    let analysis: ResultsAnalysis;
    try {
      analysis = decodeResultsAnalysis(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      validateResults(analysis, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      ok: true,
      tables: analysis.tables.map((t) => ({ id: t.id, columns: t.columns.length, rows: t.rows.length })),
      discussions: analysis.missing.length,
    };
  });

  /** 保存结果分析：校验通过后才写入 reading 文件，并与图/表绑定交叉检查。 */
  ipcMain.handle('results:save', (_e, key: string, raw: string) => {
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '没有该论文的全文缓存，无法校验结果表的原文依据。' };
    let analysis: ResultsAnalysis;
    try {
      analysis = decodeResultsAnalysis(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      validateResults(analysis, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const cur = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    // 同 reading:save：损坏时拒绝保存，避免用新解析覆盖掉可人工修复的旧数据。
    if (!cur.ok && !cur.missing) return { ok: false, error: `阅读记录已损坏，未保存以免覆盖：${cur.error}` };
    const base = cur.ok ? cur.value : {};
    const visuals = Array.isArray(base.resultVisuals) ? (base.resultVisuals as Array<{ id: string; kind: string }>) : [];
    // 只有存在图/表资源时才做绑定校验：没有资源时要求绑定会让用户无法保存任何解读。
    if (visuals.length) {
      try {
        validateBindings(analysis, visuals);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const next = { ...base, key, resultsJSON: raw, updatedAt: { ...((base.updatedAt as object) ?? {}), results: new Date().toISOString() } };
    writer.schedule(`reading:${key}`, () => saveJSON(paths.readingsPath(key), next));
    return { ok: true, tables: analysis.tables.length };
  });

  /** 两个方法的差值（同一表同一列）；不解释 dB 等对数尺度的物理意义。 */
  ipcMain.handle('results:difference', (_e, key: string, tableID: string, columnID: string, aID: string, bID: string) => {
    const cur = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    if (!cur.ok || typeof cur.value.resultsJSON !== 'string') return { ok: false, error: '该论文还没有结果分析' };
    let analysis: ResultsAnalysis;
    try { analysis = decodeResultsAnalysis(cur.value.resultsJSON as string); }
    catch { return { ok: false, error: '已保存的结果分析无法解析' }; }
    const table = analysis.tables.find((t) => t.id === tableID);
    if (!table) return { ok: false, error: '找不到该结果表' };
    const diff = calculateDifference(table, columnID, aID, bID);
    if (!diff) return { ok: false, error: '无法计算：请确认两行、该列都存在且数值合法（分母为 0、NaN、溢出都会拒绝）' };
    return { ok: true, difference: diff, relativePercent: relativePercent(diff) };
  });

  // ---- 对比选择集（含固定列） ----
  ipcMain.handle('compare:get', () => {
    const doc = loadCompare(paths);
    // 固定列可能已不在选中集合里（用户取消了那一篇），取用时必须清理失效固定
    return { selected: doc.selected, pinned: compareReconciled(doc.selected, doc.pinned ?? null), order: compareOrderedKeys(doc.selected, doc.pinned ?? null) };
  });
  ipcMain.handle('compare:set', (_e, selected: string[], pinned?: string | null) => {
    const next = { selected, pinned: compareReconciled(selected, pinned ?? null) };
    saveCompare(paths, next);
    return { ...next, order: compareOrderedKeys(next.selected, next.pinned) };
  });

  // 跨协议可比性警示：不同实验协议的结果不能直接排名（未知值不参与判断，不误报）
  ipcMain.handle('compare:warnings', (_e, rows: Array<[string, string[]]>) => comparabilityWarnings(rows));

  // ---- 引用导出 ----
  ipcMain.handle('citation:preview', (_e, keys: string[]) => {
    const items = libraryItems();
    const picked = keys.map((k) => items.find((i) => i.key === k)).filter(Boolean);
    const papers = picked.map((p) => p!.paper);
    const day = new Date().toISOString().slice(0, 10);
    return { bibtex: bibtexAll(papers), ris: risAll(papers), count: papers.length,
             bibtexName: suggestedFilename(papers, 'bib', day), risName: suggestedFilename(papers, 'ris', day) };
  });
  ipcMain.handle('citation:export', async (_e, keys: string[], format: 'bib' | 'ris') => {
    const items = libraryItems();
    const papers = keys.map((k) => items.find((i) => i.key === k)?.paper).filter(Boolean) as QueueEntry[];
    if (!papers.length) return { ok: false, error: '没有可导出的论文' };
    const day = new Date().toISOString().slice(0, 10);
    const content = format === 'bib' ? bibtexAll(papers) : risAll(papers);
    const r = await dialog.showSaveDialog(win!, {
      title: format === 'bib' ? '导出 BibTeX' : '导出 RIS',
      defaultPath: suggestedFilename(papers, format, day),
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    writeExport(r.filePath, content);
    return { ok: true, path: r.filePath, bytes: Buffer.byteLength(content, 'utf8') };
  });

  // ---- 研究想法(Idea) ----
  ipcMain.handle('idea:list', () => {
    const r = loadIdeas(paths);
    if (!r.ok) return { ok: false, error: r.error, ideas: [] };
    return { ok: true, ideas: r.value.ideas };
  });
  ipcMain.handle('idea:save', (_e, idea: Record<string, unknown>) => {
    const r = loadIdeas(paths);
    if (!r.ok) return { ok: false, error: r.error };

    // 证据校验必须在写入前跑：status 之外最容易被绕过的是 evidence。
    // 只有 origin === '论文原文' 才要求页码+逐字摘录（AI 解释/个人笔记无需，见 idea.ts）。
    const evidence = (idea.evidence ?? []) as IdeaEvidence[];
    for (const ev of evidence) {
      const paperKey = ev.paperKey || (idea.paperKey as string) || '';
      const text = paperKey ? readCachedPDFText(paths, paperKey) : null;
      if (ev.origin === '论文原文') {
        if (!text) {
          return { ok: false, error: `${ev.paperTitle || paperKey}：没有全文缓存，无法校验原文摘录。原文证据需要能回到 PDF 页面。` };
        }
        try {
          validateIdeaEvidence(ev, text);
        } catch (error) {
          return { ok: false, error: `${ev.paperTitle || paperKey}：${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }

    const ideas = r.value.ideas.slice();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const id = (idea.id as string) || `idea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const idx = ideas.findIndex((x) => x.id === id);
    const record = { ...(idx >= 0 ? ideas[idx] : {}), ...idea, id, updatedAt: now,
                     createdAt: (idx >= 0 ? ideas[idx].createdAt : now) } as IdeaFile['ideas'][number];
    if (idx >= 0) ideas[idx] = record; else ideas.push(record);
    saveIdeas(paths, { ideas });
    return { ok: true, idea: record };
  });

  // 迁移建议导入：模型输出 -> 校验 -> 转成待实验 Idea。
  // 整条建议只有未知字段（page 全为 null）会被拒绝，避免「附了 evidence」变成空壳。
  ipcMain.handle('idea:importApplication', (_e, paperKey: string, raw: string) => {
    const text = readCachedPDFText(paths, paperKey);
    if (!text) return { ok: false, error: '没有该论文的全文缓存，无法校验迁移建议的原文依据。' };
    let application: ResearchApplication;
    try {
      application = decodeResearchApplication(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      validateResearchApplication(application, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return { ok: true, application };
  });
  ipcMain.handle('idea:delete', (_e, id: string) => {
    const r = loadIdeas(paths);
    if (!r.ok) return { ok: false, error: r.error };
    saveIdeas(paths, { ideas: r.value.ideas.filter((x) => x.id !== id) });
    return { ok: true };
  });

  // ---- 复现分析 + 核对清单 ----
  ipcMain.handle('reproduction:get', (_e, key: string) => {
    const r = loadReproduction(paths, key);
    return r.ok ? { ok: true, doc: r.value } : { ok: false, error: r.error, doc: r.value };
  });

  /**
   * 保存复现分析：先校验（每组 1–4 项、字段不空白、引用的页码真实存在、finding 有证据），
   * 再按内容指纹归档。指纹按键名排序，同一内容换字段顺序不会误判成新版分析。
   */
  ipcMain.handle('reproduction:analyze', (_e, key: string, raw: string) => {
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '没有该论文的全文缓存，无法校验复现分析的原文依据。' };
    let analysis;
    try {
      analysis = decodeReproductionAnalysis(raw);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      validateReproductionAnalysis(analysis, text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const revision = reproductionFingerprint(analysis);
    const r = loadReproduction(paths, key);
    if (!r.ok) return { ok: false, error: r.error };
    const doc = r.value;
    doc.analyses = { ...(doc.analyses ?? {}), [revision]: analysis as unknown as Record<string, unknown> };
    // 新版分析不继承旧核对结果：revisions 按指纹隔离
    doc.revisions[revision] = doc.revisions[revision] ?? {};
    saveReproduction(paths, key, doc);
    return {
      ok: true, revision, doc,
      groups: reproductionGroups(analysis).map(([id, label, items]) => ({ id, label, count: items.length })),
      unknownCount: reproductionUnknownCount(analysis),
    };
  });

  /** 代码快照 -> 仓库依赖/数据/权重核对项（规则扫描，不执行仓库代码、不发请求）。 */
  ipcMain.handle('reproduction:repoChecks', (_e, snapshot: { files: Array<{ path: string; lines: string[] }> }) => {
    if (!snapshot || !Array.isArray(snapshot.files)) return { ok: false, error: '代码快照格式不正确' };
    return { ok: true, checks: repoAuditChecks(snapshot) };
  });
  ipcMain.handle('reproduction:setTask', (_e, key: string, revision: string, itemID: string, patch: { status?: string; note?: string }) => {
    // revision='__proto__' 时 doc.revisions[revision] 返回 Object.prototype（?? 不兜底），
    // 下一行赋值会直接污染主进程全局原型（旧 C3 复发路径）。
    if (!isSafePathKey(key)) return { ok: false, error: '非法 key（含路径穿越或保留名，已拒绝）' };
    if (!isSafeObjectKey(revision) || !isSafeObjectKey(itemID)) {
      return { ok: false, error: '非法 revision 或核对项 ID（__proto__ 等保留名，已拒绝）' };
    }
    if (patch == null || typeof patch !== 'object') return { ok: false, error: 'patch 必须是对象' };
    const r = loadReproduction(paths, key);
    // 损坏时拒写：否则空 doc 落盘会覆盖掉文件里已有的 analyses/revisions。
    if (!r.ok) return { ok: false, error: `复现核对文件已损坏，未保存以免覆盖：${r.error}` };
    const doc: ReproductionChecklistDoc = r.value;
    // 新分析不继承旧核对结果：状态写在指纹对应的 revision 下
    doc.revisions[revision] = doc.revisions[revision] ?? {};
    const cur = doc.revisions[revision][itemID] ?? { status: 'todo', note: '' };
    doc.revisions[revision][itemID] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    saveReproduction(paths, key, doc);
    return { ok: true, doc };
  });

  // ---- 配置 ----
  ipcMain.handle('config:get', () => {
    const c = readConfig();
    // 绝不把 Key 回传给渲染进程
    return { baseURL: c.baseURL ?? '', model: c.model ?? '', hasKey: !!(c.apiKey && c.apiKey.length && !c.apiKey.includes('在这里填入')), path: paths.configPath };
  });
  ipcMain.handle('config:set', (_e, patch: { baseURL?: string; model?: string; apiKey?: string }) => {
    // 损坏时拒写：静默回退 {} 会把没随 patch 提交的字段（含 apiKey）覆盖丢。
    const r = readJSONStrict<Config>(paths.configPath);
    if (!r.ok && !r.missing) return { ok: false, error: `config.json 已损坏，未保存以免覆盖：${r.error}` };
    const c = r.ok ? r.value : {};
    const next: Config = {
      ...c,
      baseURL: patch.baseURL ?? c.baseURL,
      model: patch.model ?? c.model,
      apiKey: patch.apiKey && patch.apiKey.length ? patch.apiKey : c.apiKey,
    };
    saveJSON(paths.configPath, next);
    return { ok: true };
  });

  // ---- AI 流式问答 ----
  /** 论文标题查找（跨论文候选材料的来源标注用）。 */
  const titleOf = (key: string): string | null => {
    const item = libraryItems().find((i) => i.key === key);
    return item ? (item.paper.title ?? key) : null;
  };

  ipcMain.handle('ai:ask', async (e, req: { key: string; mode: string; question: string; scope: string; pdfText?: string }) => {
    const cfg = readConfig();
    // 跨论文扩展检索（R-05）：只读本地索引 + 至多 3 秒的查询向量请求，失败回退关键词；
    // 结果作为「候选材料」附在材料后。检索失败不阻断问答。
    let pdfText = req.pdfText ?? '';
    try {
      const passages = await retrieveAcrossLibrary(paths, cfg, req.question, req.key, titleOf, 3);
      if (passages.length) pdfText += libraryContextBlock(passages);
    } catch { /* 检索不可用不影响单篇问答 */ }
    return await askStream(cfg, { ...req, pdfText }, (delta) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:delta', delta);
    });
  });

  // ---- 检索索引（R-05）：构建/读取/prewarm ----
  ipcMain.handle('retrieval:build', async (_e, key: string, allowEmbedding = true) => {
    try {
      const idx = await retrievalIndex(paths, readConfig(), key, allowEmbedding);
      return idx ? { ok: true, chunks: idx.chunks.length, model: idx.model, embedded: idx.chunks.filter((c) => c.vector).length } : { ok: false, error: '没有可检索的全文缓存。' };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });

  ipcMain.handle('retrieval:status', () => {
    const keys = cachedKeys(paths);
    const indices = loadIndices(paths, keys);
    const withVectors = Object.values(indices).filter((i) => i.chunks.some((c) => c.vector)).length;
    return { cached: keys.length, indexed: Object.keys(indices).length, embedded: withVectors };
  });

  ipcMain.handle('ai:prepare', (_e, key: string, question: string, scope: string) => {
    const text = readCachedPDFText(paths, key);
    // 打开论文时后台预热嵌入索引（不阻塞问答）
    if (text) prewarmRetrievalIndex(paths, readConfig(), key);
    return preparePaperMaterial(text, question, scope);
  });

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    // 只放行 http/https，避免被诱导打开本地可执行文件
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });

  /** 打开 papers/*.md 笔记文件（「原有精读笔记 ↗」）。只允许 papers 目录内的 .md。 */
  ipcMain.handle('note:openFile', (_e, file: string) => {
    const name = path.basename(String(file ?? ''));
    if (!name.endsWith('.md')) return { ok: false, error: '只允许打开 Markdown 笔记' };
    const full = path.join(paths.papersDir, name);
    if (!fs.existsSync(full)) return { ok: false, error: '笔记文件不存在' };
    void shell.openPath(full);
    return { ok: true, path: full };
  });

  /** 保存文本导出（Compare Markdown/CSV、Ideas Markdown）。 */
  ipcMain.handle('export:text', async (_e, name: string, content: string) => {
    const r = await dialog.showSaveDialog(win!, { title: '导出', defaultPath: path.basename(String(name || 'export.txt')) });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    writeExport(r.filePath, String(content ?? ''));
    return { ok: true, path: r.filePath };
  });

  /** 导出研究资产（JSON bundle，schema 1.4）。回收站条目不导出。 */
  ipcMain.handle('export:research', async () => {
    const items = libraryItems().filter((i) => i.state.status !== 'deleted');
    const { notes } = loadNotes(paths.papersDir);
    const noteText: Record<string, string> = {};
    for (const n of notes) {
      try { noteText[n.file] = fs.readFileSync(path.join(paths.papersDir, n.file), 'utf8'); } catch { /* 读取失败不阻断导出 */ }
    }
    const ideas = (() => { const r = loadIdeas(paths); return r.ok ? r.value.ideas : []; })();
    const bundle = {
      schemaVersion: '1.4',
      exportedAt: new Date().toISOString(),
      profile: profile(),
      papers: items.map((i) => i.paper),
      library: Object.fromEntries(items.map((i) => [i.key, i.state])),
      progress: progressMap(),
      notes: noteText,
      ideas,
    };
    const r = await dialog.showSaveDialog(win!, { title: '导出研究资产', defaultPath: `CBCT-research-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    writeExport(r.filePath, JSON.stringify(bundle, null, 2));
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('root:reveal', () => { shell.openPath(paths.root); return true; });
}

app.whenReady().then(() => {
  paths = new Paths(findRoot(undefined, process.env.CBCT_ROOT ?? null));
  library = new LibraryStore(paths.libraryStatePath, 600, notifyWriteError);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开工作区目录', click: () => shell.openPath(paths.root) },
        { label: '切换工作区…', click: async () => {
          const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
          if (!r.canceled && r.filePaths.length) {
            process.env.CBCT_ROOT = r.filePaths[0];
            paths = new Paths(findRoot(undefined, r.filePaths[0]));
            library = new LibraryStore(paths.libraryStatePath, 600, notifyWriteError); // 换工作区必须丢弃旧状态缓存
            win?.reload();
          }
        } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  registerIPC();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// 退出前必须冲刷节流中的草稿，否则窗口关闭会丢最后一次编辑
app.on('before-quit', () => { writer.flushAll(); library.flush(); });
