// 主进程：窗口 + IPC。所有文件/网络访问都在主进程完成，渲染进程不直接碰 fs。

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

import { Paths, findRoot, readJSON, readJSONStrict, saveJSON, findLocalPdf, readCachedPDFText } from '../core/store';
import { decodeQueue, rank, matchesProfile, mergedFirstSeen } from '../core/paper';
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
import { groupsOf } from '../core/evidence';
import { findings as trendFindings, sample as trendSample, disclosure as trendDisclosure, gapStatement, violatesRedline, minimumSample as TREND_MIN_SAMPLE } from '../core/trend';
import { askStream, preparePaperContext } from './ai';
import { discover } from './discovery';

let win: BrowserWindow | null = null;
let paths: Paths;

// 写盘节流：首写立即、窗口内合并、退出前冲刷。
// 合并语义在 core/throttle.ts 里，并有回归测试锁住「窗口内编辑不得丢失」。
const writer = new ThrottledWriter(600);

/**
 * 论文库状态的内存权威副本。
 *
 * 不能每次改动都「重读磁盘 -> 生成快照 -> 交给节流写」：节流窗口内若发生另一条
 * 写入路径（如直接落盘的「移入回收站」），磁盘上的新值会被窗口结束时落下的旧快照
 * 回滚（已用脚本复现：删除的论文会在 ~600ms 后复活）。
 * 因此这里只保留一份内存状态：所有修改都作用于它，落盘也总是写它。
 */
let libraryCache: Record<string, LibraryState> | null = null;

function libState(): Record<string, LibraryState> {
  if (!libraryCache) libraryCache = libraryState();
  return libraryCache;
}

function persistLibrary(): void {
  const snapshot = libState();
  writer.schedule('library', () => saveJSON(paths.libraryStatePath, snapshot));
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
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

function readConfig(): Config {
  const c = readJSON<Config>(paths.configPath, {});
  return c;
}

function libraryState(): Record<string, LibraryState> {
  return readJSON<Record<string, LibraryState>>(paths.libraryStatePath, {});
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
    const states = libState();
    const cur = states[key] ?? defaultLibraryState();
    states[key] = { ...cur, ...patch, updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
    persistLibrary(); // 草稿类编辑可能每次按键触发，节流合并
    return states[key];
  });

  ipcMain.handle('library:remove', (_e, key: string) => {
    // 回收站语义：标记 deleted，不物理删除，可在库中恢复。
    // 必须走同一份内存状态与同一个节流器，否则会与在途的草稿写入互相覆盖。
    const states = libState();
    states[key] = { ...(states[key] ?? defaultLibraryState()), status: 'deleted' };
    persistLibrary();
    return true;
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
    const allPapers = [...result.papers, ...result.preprints];
    const next = {
      papers: result.papers,
      preprints: result.preprints,
      fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      errors: result.errors,
      firstSeen: mergedFirstSeen(cache.firstSeen ?? {}, allPapers, day),
    };
    saveJSON(paths.discoveryPath, next);
    return next;
  });

  ipcMain.handle('discovery:get', () => readJSON(paths.discoveryPath, { papers: [], preprints: [], fetchedAt: '', errors: [], firstSeen: {} }));

  // ---- 阅读记录 ----
  ipcMain.handle('reading:get', (_e, key: string) => {
    const r = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    if (r.ok) return { ok: true, value: r.value };
    // 损坏必须显式报错：静默回退默认值会在下次保存时覆盖用户数据
    return { ok: false, missing: r.missing, error: r.error };
  });

  ipcMain.handle('reading:save', (_e, key: string, patch: Record<string, unknown>) => {
    const cur = readJSONStrict<Record<string, unknown>>(paths.readingsPath(key));
    const base = cur.ok ? cur.value : {};
    const next = { ...base, ...patch, key, updatedAt: { ...(base.updatedAt as object ?? {}), draft: new Date().toISOString() } };
    writer.schedule(`reading:${key}`, () => saveJSON(paths.readingsPath(key), next));
    return true;
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
    const r = loadReproduction(paths, key);
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
    const c = readConfig();
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
  ipcMain.handle('ai:ask', async (e, req: { key: string; mode: string; question: string; scope: string; pdfText?: string }) => {
    const cfg = readConfig();
    return await askStream(cfg, req, (delta) => {
      if (!e.sender.isDestroyed()) e.sender.send('ai:delta', delta);
    });
  });

  ipcMain.handle('ai:prepare', (_e, key: string, question: string, scope: string) => {
    const text = readCachedPDFText(paths, key);
    if (!text) return { ok: false, error: '还没有该论文的全文缓存，请先在 macOS 版或本应用内完成 PDF 文本抽取' };
    return { ok: true, ...preparePaperContext(text, question, scope) };
  });

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    // 只放行 http/https，避免被诱导打开本地可执行文件
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });

  ipcMain.handle('root:reveal', () => { shell.openPath(paths.root); return true; });
}

app.whenReady().then(() => {
  paths = new Paths(findRoot(undefined, process.env.CBCT_ROOT ?? null));
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
            libraryCache = null; // 换工作区必须丢弃旧状态缓存
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
app.on('before-quit', () => writer.flushAll());
