// 渲染进程入口。复用 src/core 的解析器（同一份实现，不另写一套 JS 渲染逻辑）。
//
// 结构对齐 macOS 版 FunWorkspace：顶部胶囊导航（今日/论文库/主题/想法）+ 搜索框 +
// 溢出菜单 + 研究画像按钮；内容区按 workspacePage 切换。精读室为 4 步结构。
import { parseMarkdown, MDBlock, inlineHTML, inlineHTMLWithEvidence, pageAnchorNumber } from '../core/markdown';
import { MarkdownTable } from '../core/markdownTable';
import { Typography } from '../core/typography';
import { renderRichHTML, mathBlockHTML } from '../core/mathTypeset';
import { rasterizePage } from './pdfRaster';
import { layoutFigure, figureSVG } from '../core/figureAnalysis';
import { PdfViewer } from './pdfView';

declare const window: any;
const api = window.cbct;

// ---------- 内置 PDF 阅读器（第②步「PDF 原版」模式）----------
let pdfViewer: PdfViewer | null = null;
function destroyPdfViewer(): void { pdfViewer?.destroy(); pdfViewer = null; }

// ---------- 保存失败提示 ----------
// 自动保存此前是 void 调用 + 主进程节流写盘静默吞错：磁盘满/只读/文件损坏被拒写时
// 用户以为已保存。所有保存路径统一走 checkSaved / onWriteError 上报到这里。
let saveWarnTimer: number | undefined;
function notifySaveError(msg: string): void {
  let el = document.getElementById('save-warn');
  if (!el) {
    el = document.createElement('div');
    el.id = 'save-warn';
    el.className = 'warn';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;max-width:70vw;padding:10px 16px;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.18)';
    document.body.appendChild(el);
  }
  el.textContent = `⚠️ ${msg}`;
  window.clearTimeout(saveWarnTimer);
  saveWarnTimer = window.setTimeout(() => el?.remove(), 8000);
}
function checkSaved(r: any, what: string): void {
  if (r && r.ok === false) notifySaveError(`${what}：${r.error ?? '未知错误'}`);
}

interface LibItem {
  key: string; paper: any; state: any; score: number;
  reasons: string[]; matchesProfile: boolean; hasPDF: boolean; hasText: boolean; noteFile?: string | null;
  /** 主题匹配关键词表（与 Profile 关注主题一致），由主进程在 buildItem 时挂到条目上。 */
  topicKeywords?: Record<string, string[]>;
}

let library: LibItem[] = [];
let currentKey: string | null = null;
type Mode = 'today' | 'library' | 'topics' | 'map' | 'compare' | 'settings' | 'trend' | 'ideas' | 'reproduction' | 'profile';
let currentMode: Mode = 'today';
let chatHistory: Array<{ role: string; text: string }> = [];
let workspaceTopic: string | null = null;
let workspaceSearch = '';
let currentStep = 1;

const $ = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;

// ---------- Markdown 渲染（表格/公式/标题） ----------

/**
 * PDF 抽取的换行是排版伪影（每行半宽），逐行 <br> 渲染时两端对齐无行可拉伸。
 * 这里把段内连续行合并为流式段落：保留空行分段与标题/列表/表格/引用/公式块结构；
 * 行尾连字符断词（experi- / ment）按 PDF 惯例拼回。仅用于文本层展示，不影响证据校验用的原始缓存。
 */
function reflowPaperText(text: string): string {
  const structural = (s: string): boolean =>
    s.trim() === '' || /^#{1,6}\s/.test(s) || /^[-*•]\s/.test(s) || /^\d+[.)]\s/.test(s) ||
    s.startsWith('|') || s.startsWith('>') || s.startsWith('$$') || /^=== Page /.test(s);
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const prev = out.length ? out[out.length - 1] : undefined;
    if (prev !== undefined && !structural(prev) && !structural(line)) {
      const p = prev.trimEnd();
      if (p.endsWith('-') && /^[a-z]/.test(line.trim())) out[out.length - 1] = p.slice(0, -1) + line.trim();
      else out[out.length - 1] = p + ' ' + line.trim();
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

function renderTable(t: MarkdownTable): string {
  const align = (a: string): string => (a === 'center' ? 'center' : a === 'trailing' ? 'right' : 'left');
  const head = t.header.map((h, i) => `<th style="text-align:${align(t.alignments[i])}">${inlineHTML(h)}</th>`).join('');
  const body = t.rows.map((r) =>
    '<tr>' + r.map((c, i) => `<td style="text-align:${align(t.alignments[i])}">${inlineHTMLWithEvidence(c)}</td>`).join('') + '</tr>',
  ).join('');
  const cls = t.rows.length > 8 ? 'table-wrap tall' : 'table-wrap';
  return `<div class="${cls}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderBlocks(blocks: MDBlock[]): string {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'heading': {
        const size = Typography.heading(b.level);
        const cls = b.level <= 2 ? 'md-h md-h-strong' : 'md-h';
        return `<div class="${cls}" style="font-size:${size}px">${inlineHTMLWithEvidence(b.text)}</div>${b.level <= 2 ? '<hr class="md-rule-soft">' : ''}`;
      }
      case 'paragraph':
        return `<p>${b.lines.map((l) => renderRichHTML(l, inlineHTMLWithEvidence)).join('<br>')}</p>`;
      case 'quote':
        return `<blockquote>${b.lines.map((l) => renderRichHTML(l, inlineHTMLWithEvidence)).join('<br>')}</blockquote>`;
      case 'bullets':
        return `<ul>${b.items.map((i) => `<li>${renderRichHTML(i, inlineHTMLWithEvidence)}</li>`).join('')}</ul>`;
      case 'ordered':
        return `<ol>${b.items.map((i) => `<li>${renderRichHTML(i, inlineHTMLWithEvidence)}</li>`).join('')}</ol>`;
      case 'table':
        return renderTable(b.table);
      case 'rule':
        return '<hr>';
      case 'mathBlock':
        // 独立公式块：能排版则排版（不溢出，超宽横向滚动），不能则整式降级为源码（默认收起）。
        return `<div class="math-block-wrap">${mathBlockHTML(b.latex).html}</div>`;
    }
  }).join('');
}

function renderMarkdown(src: string): string {
  return renderBlocks(parseMarkdown(src));
}

function statusLabel(s: string): string {
  return ({ unread: '未读', later: '稍后读', reading: '精读中', read: '已读', ignored: '忽略', deleted: '已删除' } as Record<string, string>)[s] ?? s;
}

function meta(p: any): string {
  return [p.source ?? '手动入库', p.venue ?? '', p.published ?? p.year ?? '日期未提供'].filter(Boolean).join(' · ');
}

// 出处排序权重（与 macOS FunHome 一致）
const CONF = ['MICCAI', 'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICLR', 'AAAI'];
const MED = ['ISBI', 'SPIE Medical Imaging'];
function venuePriority(source: string): number {
  if (CONF.includes(source)) return 0;
  if (MED.includes(source)) return 1;
  if (source === 'TMI' || source === 'MIA') return 2;
  if (source === 'PubMed') return 3;
  return 2;
}

// ---------- 论文卡片（对齐 macOS PaperCard） ----------
function paperCard(p: any, opts: { showCompare?: boolean } = {}): string {
  const reasons = (p.reasons ?? []).map((r: string) => `<div class="sub" style="color:var(--teal)">✦ ${inlineHTML(r)}</div>`).join('');
  const readMinutes = Math.max(8, Math.min(30, Math.round((p.abstract?.length ?? 1200) / 180)));
  const fullText = p.hasText ? '有全文缓存' : (p.hasPDF ? '有 PDF' : '需导入');
  return `<article class="card">
    <div class="row between" style="margin:0">
      <h3 style="font-size:18px">${inlineHTML(p.title ?? p.key)}</h3>
      ${p.score != null ? `<span class="pill teal">${p.score} / 100</span>` : ''}
    </div>
    <div class="sub" style="margin:0">${inlineHTML(meta(p))}</div>
    <div class="sub" style="margin:0">全文：${fullText} · 精读约 ${readMinutes} 分钟（按摘要长度估计）</div>
    ${reasons}
    ${p.abstract ? `<p class="sub" style="margin:0">${inlineHTML(String(p.abstract).slice(0, 240))}</p>` : ''}
    <div class="row" style="margin:0">
      <button class="primary" data-open="${inlineHTML(p.key)}">精读 →</button>
      <button data-later="${inlineHTML(p.key)}">稍后读</button>
      ${opts.showCompare ? `<button data-cmp="${inlineHTML(p.key)}">${p._sel ? '已选对比 ✓' : '加入对比'}</button>` : ''}
      ${p.hasText ? '' : `<button data-import="${inlineHTML(p.key)}">下载并导入</button>`}
      <span class="spacer"></span>
      <span class="sub" style="margin:0">${statusLabel(p.state?.status ?? 'unread')}</span>
    </div>
  </article>`;
}

// ---------- 今日（FunHome） ----------
async function renderToday(): Promise<void> {
  const d = await api.getDashboard();
  const today = d.today;
  (window as any).__todayKey = today?.key ?? null;
  (window as any).__topics = d.topics ?? [];
  const curStep = today ? ((await api.getProgress(today.key))?.step ?? 1) : 1;
  const takeaway = '选中原文，记录证据，把理解写成自己的研究想法。';

  $('#main').innerHTML = `
    <div class="hero">
      <div class="l1">读懂一篇 CBCT 论文。</div>
      <div class="l2">连接一个新想法。</div>
      <div class="sub">${new Date().toISOString().slice(0, 10)} · 待读 ${d.unreadCount} · 已读 ${d.readCount} · 连续 ${d.streak} 天</div>
      <div class="row" style="margin-top:4px">
        <button class="primary" id="btn-start">开始今天的精读</button>
        <button data-nav="map">打开知识地图</button>
        <span class="spacer"></span>
        <span class="sub" style="margin:0">主题 · 方法 · 数据集 · 阅读反馈</span>
        <button id="btn-refresh">${'刷新论文'}</button>
      </div>
    </div>
    ${discoveryErrorBanner(d.errors)}

    <div class="dash">
      <div class="col">
        <section class="card" style="height:520px">
          <span class="pill yellow" style="align-self:flex-start">今日阅读</span>
          <div style="font-size:20px;font-weight:800">${inlineHTML(today?.title ?? '今天，从一篇论文开始。')}</div>
          <div class="sub" style="margin:0">${inlineHTML(today?.venue || '导入 PDF 或刷新论文，开启阅读。')}</div>
          <div style="display:flex;flex-direction:column;gap:16px;margin:8px 0">
            ${adventureRow(1, '快速浏览', '它解决了什么问题？', 'fun-pink', 'pill pink', curStep === 1, !!today)}
            ${adventureRow(2, '深入精读', '方法是怎么工作的？', 'teal-soft', 'pill teal', curStep === 2, !!today)}
            ${adventureRow(4, '建立关联', '该关联到你已读的哪篇？', 'accent-soft', 'pill accent', curStep === 4, !!today)}
          </div>
          <div class="spacer"></div>
          <div class="takeaway"><div class="k">今日要点</div><div style="font-weight:600">${inlineHTML(takeaway)}</div></div>
        </section>
      </div>
      <div class="col">
        <section class="card" style="height:224px;background:var(--fun-yellow)">
          <div style="font-size:15px;font-weight:800">连续阅读</div>
          <div class="streak-num">${d.streak} 天</div>
          <div class="sub" style="margin:0;color:var(--gold)">${d.streak > 0 ? '别让链条断掉。' : '下一次精读将点亮链条。'}</div>
          <div class="spacer"></div>
          <div class="week">${(d.week ?? []).map((w: any) => `<div><div class="dot" style="${w.done ? 'background:var(--ink)' : 'background:#fff'}">${w.done ? '✓' : ''}</div><div class="d">${w.label}</div></div>`).join('')}</div>
        </section>
        <section class="card" style="height:272px;background:var(--teal-soft)">
          <div style="font-size:15px;font-weight:800">主题花园</div>
          <div class="sub" style="margin:0;color:var(--teal)">你正在关注的研究主题</div>
          ${(d.topics ?? []).length
            ? `<div class="topic-chips">${d.topics.slice(0, 6).map((t: string, i: number) => `<button class="pill ${['pink', 'accent', 'mint', 'peach', 'blue'][i % 5]}" data-topic="${inlineHTML(t)}">${inlineHTML(t)}</button>`).join('')}</div>`
            : '<div class="sub">在研究画像中种下一个主题。</div>'}
          <div class="spacer"></div>
          <div class="row" style="margin:0"><button class="small" data-nav="topics">全部主题 →</button></div>
        </section>
      </div>
      <div class="col">
        <section class="card" style="height:520px;background:var(--fun-lavender)">
          <div style="font-size:15px;font-weight:800">知识图谱</div>
          <div class="sub" style="margin:0">来自你保存的论文关联材料</div>
          ${playgroundHTML(d.topics ?? [])}
          <div class="spacer"></div>
          <div class="card flush" style="flex-direction:row;align-items:center">
            <div><div style="font-weight:800">已关联 ${d.ideasLinkedCount} 条想法</div><div class="sub" style="margin:0">来自你保存的论文关联材料</div></div>
            <span class="spacer"></span>
            <button class="primary small" data-nav="map">查看地图</button>
          </div>
        </section>
      </div>
    </div>

    <div class="row between">
      <h2 style="margin:0">为你推荐</h2>
      <button class="small" id="btn-refresh2">刷新论文</button>
    </div>
    ${(d.picks ?? []).length ? (d.picks ?? []).map((p: any) => paperCard(p)).join('') : '<div class="card"><span class="sub">暂无待读推荐。刷新论文，或从顶部「⋯ → 导入论文 PDF」加入自己的 PDF。</span></div>'}

    ${(d.todayNewCount || d.todayNewPubmed || d.todayNewPreprints) ? `<section class="card" style="background:var(--fun-yellow)">
      <div style="font-weight:800">今日新增：正式期刊/会议 ${d.todayNewCount} · PubMed ${d.todayNewPubmed} · 预印本 ${d.todayNewPreprints}</div>
      <div class="sub" style="margin:0">顶会与期刊进入主推荐；arXiv 预印本独立展示。按首次出现日期统计，旧缓存回填日期不代表发表日。</div>
    </section>` : ''}

    ${(d.preprintPicks ?? []).length ? `<h2>预印本 · 独立入口（尚未经过正式评审）</h2>${d.preprintPicks.map((p: any) => paperCard(p)).join('')}` : ''}

    ${(d.topicGroups ?? []).length ? `<h2>按主题浏览</h2>${d.topicGroups.map((g: any) => `
      <div class="row between" style="margin:10px 0 4px">
        <div><span style="font-size:17px;font-weight:700">${inlineHTML(g.topic)}</span> <span class="sub" style="margin-left:6px">${g.papers.length} 篇</span></div>
        <button class="small" data-topic="${inlineHTML(g.topic)}" data-goto-lib="1">查看全部 →</button>
      </div>
      ${g.papers.slice(0, 2).map((p: any) => paperCard(p)).join('')}`).join('')}` : ''}

    <div class="sub" style="margin-top:14px">论文与想法默认保存在本机。使用 AI 会发送相关论文材料；迁移分析还会发送研究画像约束。</div>
  `;

  $('#btn-start')?.addEventListener('click', () => { if (today) openReader(today.key, curStep); else { setMode('library'); } });
  $('#btn-refresh')?.addEventListener('click', doRefresh);
  $('#btn-refresh2')?.addEventListener('click', doRefresh);
  wireCommon();
}

function adventureRow(n: number, title: string, subtitle: string, _bg: string, pillCls: string, isCurrent: boolean, hasToday: boolean): string {
  return `<div class="adventure-row">
    <span class="num ${pillCls}">${n}</span>
    <div style="flex:1"><div style="font-weight:800">${title}</div><div class="sub" style="margin:0">${subtitle}</div></div>
    <button class="${isCurrent ? 'primary' : ''} small" data-step="${n}" ${hasToday ? '' : 'disabled'}>${isCurrent ? '继续' : '打开'}</button>
  </div>`;
}

function playgroundHTML(topics: string[]): string {
  const pts = [[19, 40], [80, 40], [50, 65], [13, 89], [85, 89]];
  const colors = ['fun-pink', 'fun-blue', 'fun-mint', 'accent-soft', 'fun-peach'];
  const show = topics.filter((t) => t.toLowerCase() !== 'cbct').slice(0, 5);
  const lines = show.map((_, i) => `<line x1="50%" y1="14%" x2="${pts[i][0]}%" y2="${pts[i][1]}%" stroke="var(--ink)" stroke-width="1.3"/>`).join('');
  const nodes = show.map((t, i) => `<div class="node" data-topic="${inlineHTML(t)}" style="left:${pts[i][0]}%;top:${pts[i][1]}%;transform:translate(-50%,-50%);background:var(--${colors[i]})">${inlineHTML(t)}</div>`).join('');
  return `<div class="playground">
    <svg width="100%" height="100%" style="position:absolute;inset:0">${lines}</svg>
    <div class="node center" data-topic="CBCT" style="left:50%;top:14%;transform:translate(-50%,-50%)">CBCT</div>
    ${nodes}
  </div>`;
}

/**
 * 发现源错误横幅。HTTP 429（外部 API 瞬时限流）不展示：主进程已自动退避重试，
 * 失败的源也已保留上次缓存条目，用户无需处理；其余故障（超时/服务不可用）仍如实提示。
 */
function discoveryErrorBanner(errors: string[] | undefined): string {
  const errs = (errors ?? []).filter((e) => !/HTTP 429/.test(e));
  return errs.length ? `<div class="warn">${errs.map((e) => inlineHTML(e) + ' · 已保留上次结果，可刷新重试').join('<br>')}</div>` : '';
}

async function doRefresh(): Promise<void> {
  const btns = ['#btn-refresh', '#btn-refresh2'].map((s) => document.querySelector(s) as HTMLButtonElement | null).filter(Boolean);
  btns.forEach((b) => { if (b) { b!.disabled = true; b!.textContent = '正在发现…'; } });
  try { await api.refreshDiscovery(); await renderToday(); }
  catch (e) { alert('抓取失败：' + (e as Error).message); await renderToday(); }
}

// ---------- 论文库（LibraryWorkspace） ----------
async function renderLibrary(): Promise<void> {
  await reloadLibrary();
  const q = workspaceSearch.toLowerCase();
  let filter = (window as any).__libFilter ?? '全部';
  const followedTopics = (await api.getDashboard()).topics ?? [];
  const matchTopic = (it: LibItem): boolean => {
    if (!workspaceTopic) return true;
    const text = ((it.paper.title ?? '') + ' ' + (it.paper.abstract ?? '')).toLowerCase();
    return (it.topicKeywords?.[workspaceTopic] ?? [workspaceTopic.toLowerCase()]).some((k: string) => text.includes(k));
  };
  const items = library.filter((it) => {
    const st = it.state;
    const hay = [it.paper.title ?? '', it.paper.abstract ?? '', (st.tags ?? []).join(' '), st.notes ?? ''].join(' ').toLowerCase();
    const topicOk = matchTopic(it);
    const searchOk = !q || hay.includes(q);
    const filterOk = filter === '全部' || (filter === '收藏' && st.favorite) || (filter === '不相关' && st.relevance === -1) || statusLabel(st.status) === filter;
    return topicOk && searchOk && filterOk;
  });
  const deleted = library.filter((it) => it.state.status === 'deleted');

  $('#main').innerHTML = `
    <div class="page-title">${workspaceTopic ? '论文库 · ' + inlineHTML(workspaceTopic) : '你的研究论文库'}</div>
    <p class="sub">阅读状态、标签、笔记与纠错随时保存；原有 Markdown 精读笔记独立保留。</p>
    ${workspaceTopic ? '<button class="small" id="clear-topic">清除主题筛选</button>' : ''}
    <div class="row">
      <input id="lib-search" placeholder="搜索标题、摘要、标签或笔记" value="${inlineHTML(workspaceSearch)}" style="min-width:280px">
      <select id="lib-filter">${['全部', '收藏', '未读', '稍后读', '精读中', '已读', '忽略', '不相关'].map((f) => `<option${f === filter ? ' selected' : ''}>${f}</option>`).join('')}</select>
      <span class="spacer"></span>
      <button class="small" id="export-cite">导出全部引用（${items.length} 篇）</button>
    </div>
    ${items.length ? items.map((it) => `
      <article class="card">
        <div class="row between" style="margin:0">
          <h3 style="font-size:17px">${inlineHTML(it.paper.title ?? it.key)}</h3>
          <button class="small" data-cmp2="${inlineHTML(it.key)}">${(window as any).__cmpSelected?.includes(it.key) ? '已选对比 ✓' : '加入对比'}</button>
        </div>
        <div class="sub" style="margin:0">${inlineHTML(it.paper.venue ?? '')} · ${statusLabel(it.state.status)}${it.state.favorite ? ' · ★ 收藏' : ''}</div>
        ${(it.state.tags ?? []).length ? `<div class="sub" style="margin:0;color:var(--teal)">${it.state.tags.map((t: string) => '#' + inlineHTML(t)).join('  ')}</div>` : ''}
        <div class="row" style="margin:0">
          <button class="primary" data-open="${inlineHTML(it.key)}">打开精读</button>
          <button data-edit="${inlineHTML(it.key)}">状态 / 标签 / 笔记 / 纠错</button>
          ${it.noteFile ? `<button data-note-file="${inlineHTML(it.noteFile)}">原有精读笔记 ↗</button>` : ''}
          <span class="spacer"></span>
          <button class="small" data-del="${inlineHTML(it.key)}">删除</button>
        </div>
      </article>`).join('') : '<div class="card"><span class="sub">没有匹配的论文。可调整筛选或导入 PDF。</span></div>'}

    ${deleted.length ? `
      <h2>回收站 · ${deleted.length} 篇</h2>
      <p class="sub">删除的论文保留标签/笔记/纠错，可恢复；「彻底删除」移除全部本地记录且不可恢复（精读记录与 Markdown 笔记保留）。</p>
      ${deleted.map((it) => `<article class="card flush">
        <div class="row between" style="margin:0">
          <div><div style="font-weight:600;color:var(--ink-soft)">${inlineHTML(it.paper.title ?? it.key)}</div><div class="sub" style="margin:0">${inlineHTML(it.paper.venue ?? '')}</div></div>
          <div class="row" style="margin:0">
            <button class="small" data-restore="${inlineHTML(it.key)}">恢复</button>
            <button class="small" data-purge="${inlineHTML(it.key)}">彻底删除</button>
          </div>
        </div>
      </article>`).join('')}` : ''}
  `;

  $('#clear-topic')?.addEventListener('click', () => { workspaceTopic = null; renderLibrary(); });
  const search = $('#lib-search') as HTMLInputElement;
  let searchDebounce: number | undefined;
  search?.addEventListener('input', () => {
    workspaceSearch = search.value;
    // 防抖：每击键全量重渲染（含 dashboard 聚合）且异步渲染互相竞争，200ms 合并一次
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      const pos = ($('#lib-search') as HTMLInputElement)?.selectionStart ?? null;
      void renderLibrary().then(() => {
        const s = $('#lib-search') as HTMLInputElement;
        if (s && pos != null) { s.focus(); s.setSelectionRange(pos, pos); }
      });
    }, 200);
  });
  ($('#lib-filter') as HTMLSelectElement)?.addEventListener('change', (e) => {
    (window as any).__libFilter = (e.target as HTMLSelectElement).value;
    renderLibrary();
  });
  $('#export-cite')?.addEventListener('click', async () => {
    const keys = items.map((i) => i.key);
    if (!keys.length) return;
    const r = await api.citationExport(keys, 'bib');
    alert(r.ok ? `已导出 ${keys.length} 篇 BibTeX` : (r.canceled ? '已取消' : '失败：' + r.error));
  });
  document.querySelectorAll('[data-edit]').forEach((el) => el.addEventListener('click', () => openLibraryEditor((el as HTMLElement).dataset.edit!)));
  document.querySelectorAll('[data-del]').forEach((el) => el.addEventListener('click', async () => {
    const r = await api.removeFromLibrary((el as HTMLElement).dataset.del!);
    if (r?.ok === false) { alert(r.error); return; }
    renderLibrary();
  }));
  document.querySelectorAll('[data-restore]').forEach((el) => el.addEventListener('click', async () => { await api.restoreFromLibrary((el as HTMLElement).dataset.restore!); renderLibrary(); }));
  document.querySelectorAll('[data-purge]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('彻底删除本地记录？不可恢复。')) return;
    await api.purgeFromLibrary((el as HTMLElement).dataset.purge!); renderLibrary();
  }));
  document.querySelectorAll('[data-cmp2]').forEach((el) => el.addEventListener('click', () => toggleCompare((el as HTMLElement).dataset.cmp2!)));
  wireCommon();
}

async function openLibraryEditor(key: string): Promise<void> {
  const it = library.find((x) => x.key === key);
  if (!it) return;
  const tg = await api.tagsFor(key);
  const sys = tg.ok ? tg.tags : [];
  const sysHtml = sys.length
    ? sys.map((t: any) => `<div class="sub" style="margin:0" title="命中依据：「${inlineHTML(t.evidence)}」">${inlineHTML(t.category)} · ${inlineHTML(t.value)}</div>`).join('')
    : '<div class="sub" style="margin:0">未从标题/摘要/实验字段中匹配到系统标签。</div>';
  const cats = ['Task', 'Domain', 'Acquisition', 'Architecture', 'Learning Paradigm', 'Dataset', 'Metric', 'Venue'];
  const covered = new Set(sys.map((t: any) => t.category));
  const missing = cats.filter((c) => !covered.has(c));

  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal">
    <h3 style="font-size:20px">${inlineHTML(it.paper.title ?? key)}</h3>
    <div class="row">
      <label>阅读状态 <select id="ed-status">${['unread', 'later', 'reading', 'read', 'ignored'].map((s) => `<option value="${s}"${s === it.state.status ? ' selected' : ''}>${statusLabel(s)}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="ed-fav" ${it.state.favorite ? 'checked' : ''}> 收藏</label>
      <label>推荐反馈 <select id="ed-rel">${[[0, '未评价'], [1, '相关'], [-1, '不相关']].map(([v, l]) => `<option value="${v}"${it.state.relevance === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <label>自定义标签，用逗号分隔<input id="ed-tags" value="${inlineHTML((it.state.tags ?? []).join(', '))}"></label>
    <div style="margin:10px 0"><div class="sub" style="color:var(--gold);font-weight:600">系统标签（自动派生，可核对依据）</div>${sysHtml}
      ${missing.length ? `<div class="sub" style="margin:0">未涉及：${missing.join('、')}</div>` : ''}</div>
    <label>个人笔记 · 自动保存<textarea id="ed-notes" style="min-height:110px">${inlineHTML(it.state.notes ?? '')}</textarea></label>
    <label>AI 纠错反馈 · 重新生成时作为待核对问题，仍以原文为准<textarea id="ed-corr" style="min-height:75px">${inlineHTML(it.state.corrections ?? '')}</textarea></label>
    <div class="row between" style="margin-top:12px">
      <button id="ed-pdf">为该论文导入全文 PDF</button>
      <div class="row" style="margin:0"><button id="ed-cancel">取消</button><button class="primary" id="ed-done">完成</button></div>
    </div>
  </div>`;
  document.body.appendChild(ov);

  const save = (patch: any): void => { void api.setLibraryState(key, patch).then((r: any) => checkSaved(r, '库状态保存失败')); };
  ($('#ed-status') as HTMLSelectElement).addEventListener('change', (e) => save({ status: (e.target as HTMLSelectElement).value }));
  ($('#ed-fav') as HTMLInputElement).addEventListener('change', (e) => save({ favorite: (e.target as HTMLInputElement).checked }));
  ($('#ed-rel') as HTMLSelectElement).addEventListener('change', (e) => save({ relevance: Number((e.target as HTMLSelectElement).value) }));
  ($('#ed-tags') as HTMLInputElement).addEventListener('input', (e) => {
    const t = (e.target as HTMLInputElement).value.replace(/，/g, ',').split(',').map((x) => x.trim()).filter(Boolean);
    save({ tags: t });
  });
  const notes = $('#ed-notes') as HTMLTextAreaElement;
  let nt: number | undefined;
  notes.addEventListener('input', () => { window.clearTimeout(nt); nt = window.setTimeout(() => save({ notes: notes.value }), 500); });
  const corr = $('#ed-corr') as HTMLTextAreaElement;
  let ct: number | undefined;
  corr.addEventListener('input', () => { window.clearTimeout(ct); ct = window.setTimeout(() => save({ corrections: corr.value }), 500); });
  $('#ed-pdf')?.addEventListener('click', async () => { const r = await api.importPDF(); if (r.ok) alert('已导入：' + r.name); });
  $('#ed-cancel')?.addEventListener('click', () => ov.remove());
  $('#ed-done')?.addEventListener('click', () => { ov.remove(); renderLibrary(); });
}

// ---------- 研究画像（ProfileWorkspace） ----------
const TOPIC_LIST = ['Sparse-view', 'Low-dose', 'Implicit', '4D-CBCT', 'Diffusion', 'TTT'];
async function renderProfile(): Promise<void> {
  const p = await api.getProfile();
  const weightLabel = ['关闭', '关注', '重点', '核心'];
  $('#main').innerHTML = `
    <div class="page-title">让推荐更贴近你的研究</div>
    <p class="sub">关闭不关注的主题，或提高权重。画像用于推荐与建议，论文事实始终以原文为准。</p>
    <section class="card" style="max-width:760px">
      <h3 style="color:var(--teal)">主题订阅与权重</h3>
      ${TOPIC_LIST.map((t) => `<div class="row" style="margin:2px 0">
        <span style="width:140px">${t}</span>
        <select data-topic-w="${t}">${weightLabel.map((l, i) => `<option value="${i}"${(p.topics?.[t] ?? 0) === i ? ' selected' : ''}>${l}</option>`).join('')}</select>
      </div>`).join('')}
    </section>
    <section class="card" style="max-width:760px">
      ${field('当前研究任务', 'task', p.task)}
      ${field('常用数据集（逗号分隔）', 'datasets', p.datasets)}
      ${field('技术偏好', 'methods', p.methods)}
      ${field('评价指标', 'metrics', p.metrics)}
      ${field('硬件与算力约束', 'hardware', p.hardware)}
    </section>
    <button class="primary" id="save-profile">保存画像并更新推荐</button>
  `;
  $('#save-profile')?.addEventListener('click', async () => {
    const topics: Record<string, number> = {};
    TOPIC_LIST.forEach((t) => { topics[t] = Number(($(`[data-topic-w="${t}"]`) as HTMLSelectElement).value); });
    const val = {
      topics, task: val0('#f-task'), datasets: val0('#f-datasets'), methods: val0('#f-methods'),
      metrics: val0('#f-metrics'), hardware: val0('#f-hardware'),
    };
    await api.setProfile(val);
    alert('研究画像已保存，推荐排序已更新');
    setMode('today');
  });
}
function field(label: string, id: string, value: string): string {
  return `<label style="display:block;margin-bottom:8px"><span class="sub" style="margin:0">${label}</span><input id="f-${id}" value="${inlineHTML(value ?? '')}" style="width:100%"></label>`;
}
const val0 = (sel: string): string => (($(sel) as HTMLInputElement)?.value ?? '').trim();

// ---------- 主题 / 知识地图（TopicMapWorkspace） ----------
async function renderTopics(): Promise<void> {
  const d = await api.getDashboard();
  const trend = await api.getTrend();
  const ideas = await api.listIdeas();
  const linked = (ideas.ideas ?? []).filter((i: any) => (i.evidence ?? []).length > 0);
  const counts: Record<string, number> = {};
  d.topics.forEach((t: string) => { counts[t] = library.filter((it: LibItem) => {
    const text = ((it.paper.title ?? '') + ' ' + (it.paper.abstract ?? '')).toLowerCase();
    return (it.topicKeywords?.[t] ?? [t.toLowerCase()]).some((k: string) => text.includes(k));
  }).length; });

  $('#main').innerHTML = `
    <div class="page-title">${currentMode === 'topics' ? '你的主题花园' : '你的知识地图'}</div>
    <p class="sub">主题按论文标题与摘要匹配；Idea 的论文关联来自你保存的材料。连线表示分类与材料关联。</p>
    <div class="row" style="align-items:flex-start;gap:18px">
      <section class="card" style="width:340px;background:var(--fun-lavender)">${playgroundHTML(d.topics)}</section>
      <div style="flex:1">
        ${d.topics.map((t: string) => `<div class="row between" style="border-bottom:1px solid var(--line);padding:8px 0">
          <button class="pill teal" data-topic="${inlineHTML(t)}">${inlineHTML(t)}</button>
          <span class="sub" style="margin:0">${counts[t] ?? 0} 篇论文 →</span>
        </div>`).join('') || '<div class="sub">尚未关注任何主题。</div>'}
        <button style="margin-top:10px" data-nav="profile">编辑关注主题</button>
      </div>
    </div>
    <h2>趋势与缺口</h2>
    <section class="card">
      <div style="font-weight:700">检索范围：${trend.sample.papers.length} 篇论文 · 时间窗口：${trend.sample.windowStart ? `${trend.sample.windowStart} – ${trend.sample.windowEnd}` : '年份未提供'}</div>
      <div class="sub" style="margin:0">样本不足 ${trend.minimumSample} 篇时只报告计数，不判断「升温 / 新兴 / 首次」。</div>
      ${(trend.findings ?? []).length ? trend.findings.slice(0, 8).map((f: any) => `
        <div style="padding:4px 0"><div style="font-weight:600">${inlineHTML(f.claim)}</div>
        <div class="sub" style="margin:0;color:var(--teal)">${inlineHTML(f.disclosure)}</div>
        <div class="sub" style="margin:0">${inlineHTML(f.caveat)}</div></div>`).join('') : '<div class="sub">尚未从论文文本中派生出系统标签，无法统计趋势。</div>'}
      <div class="sub" style="margin:8px 0 0;color:var(--gold)">${inlineHTML(trend.gapExample)}</div>
    </section>
    <h2>想法 ↔ 论文</h2>
    ${linked.length ? linked.map((idea: any) => `<section class="card">
      <div style="font-size:17px;font-weight:700">${inlineHTML(idea.question || '未命名研究想法')}</div>
      ${(idea.evidence ?? []).map((e: any) => `<div><div class="row between" style="margin:0"><span class="sub" style="margin:0">↳ ${inlineHTML(e.paperTitle)}</span><span class="sub" style="margin:0;color:var(--teal)">${inlineHTML(e.origin)}</span></div>
        ${e.page ? `<div class="sub" style="margin:0">Page ${inlineHTML(String(e.page))} · ${inlineHTML(e.excerpt ?? '')}</div>` : ''}</div>`).join('')}
      <div class="row"><button class="small" data-nav="ideas">打开想法笔记</button></div>
    </section>`).join('') : '<div class="card"><span class="sub">还没有论文关联。精读室第②步选中 PDF 原文，点「保存为 Idea 证据」。</span></div>'}
  `;
  wireCommon();
}

// ---------- 想法（IdeasWorkspace） ----------
async function renderIdeas(): Promise<void> {
  const r = await api.listIdeas();
  const ideas = r.ideas ?? [];
  const statuses = ['Idea', 'Planned', 'Running', 'Rejected', 'Adopted'];
  const labels: Record<string, string> = { Idea: '想法', Planned: '待实验', Running: '实验中', Rejected: '已否定', Adopted: '已采纳' };
  await reloadLibrary();

  $('#main').innerHTML = `
    <div class="row between">
      <div class="page-title" style="margin:0">研究想法</div>
      <button class="small" id="idea-export">导出 Markdown</button>
    </div>
    <p class="sub">共 ${ideas.length} 条 · 存在 <code>app/data/ideas.json</code>，与 macOS 版共用</p>
    ${r.ok ? '' : `<div class="warn">ideas.json 读取失败：${inlineHTML(r.error)}。为避免覆盖你的数据，这里不显示任何条目。</div>`}
    <section class="card form">
      <label>研究问题<textarea id="idea-q" placeholder="要回答什么问题？"></textarea></label>
      <label>观察<textarea id="idea-o"></textarea></label>
      <label>假设<textarea id="idea-h"></textarea></label>
      <label>方法草图<textarea id="idea-m"></textarea></label>
      <label>验证实验<textarea id="idea-e"></textarea></label>
      <fieldset class="evidence-form">
        <legend>关联证据（可选）</legend>
        <label>来源类型<select id="idea-ev-origin">${['论文原文', 'AI 解释', '研究建议', '个人笔记'].map((o) => `<option>${o}</option>`).join('')}</select></label>
        <label>论文<select id="idea-ev-paper">${library.map((it) => `<option value="${inlineHTML(it.key)}">${inlineHTML(it.paper.title ?? it.key)}</option>`).join('')}</select></label>
        <label>物理页码<input id="idea-ev-page" type="number" min="1" placeholder="仅「论文原文」需要"></label>
        <label>逐字摘录<textarea id="idea-ev-excerpt" placeholder="从该页复制原文；「论文原文」要求 ≥ 8 个非空白字符"></textarea></label>
      </fieldset>
      <div class="row"><button class="primary" id="idea-add">保存为想法</button><span id="idea-msg" class="sub"></span></div>
    </section>
    ${ideas.map((it: any) => `<article class="card">
      <div class="row between" style="margin:0"><h3>${inlineHTML(it.question || '（未填写问题）')}</h3><span class="pill teal">${typeof labels[it.status] === 'string' ? labels[it.status] : inlineHTML(String(it.status ?? ''))}</span></div>
      ${it.observation ? `<div><b>观察</b> ${inlineHTML(it.observation)}</div>` : ''}
      ${it.hypothesis ? `<div><b>假设</b> ${inlineHTML(it.hypothesis)}</div>` : ''}
      ${it.method ? `<div><b>方法</b> ${inlineHTML(it.method)}</div>` : ''}
      ${it.experiment ? `<div><b>验证</b> ${inlineHTML(it.experiment)}</div>` : ''}
      ${(it.evidence ?? []).length ? `<ul>${it.evidence.map((e: any) => `<li>${inlineHTML(e.origin)}${e.page ? ` · Page ${inlineHTML(String(e.page))}` : ''}：${inlineHTML(e.excerpt || '（无摘录）')}</li>`).join('')}</ul>` : ''}
      <div class="row" style="margin:0">
        <select data-istatus="${inlineHTML(it.id)}">${statuses.map((s) => `<option value="${s}"${s === it.status ? ' selected' : ''}>${labels[s]}</option>`).join('')}</select>
        <span class="spacer"></span>
        <button class="small" data-idel="${inlineHTML(it.id)}">删除</button>
      </div>
    </article>`).join('') || '<div class="card"><span class="sub">还没有想法。</span></div>'}
  `;

  $('#idea-export')?.addEventListener('click', () => {
    const md = ideas.map((it: any) => `# ${it.question || '未命名'}\n\n- 状态：${labels[it.status] ?? it.status}\n- 观察：${it.observation ?? ''}\n- 假设：${it.hypothesis ?? ''}\n- 方法：${it.method ?? ''}\n- 验证：${it.experiment ?? ''}\n`).join('\n---\n\n');
    void api.exportText('CBCT-ideas.md', md);
  });
  $('#idea-add')?.addEventListener('click', async () => {
    const qv = ($('#idea-q') as HTMLTextAreaElement).value.trim();
    if (!qv) { $('#idea-msg')!.textContent = '至少要填写研究问题'; return; }
    const excerpt = ($('#idea-ev-excerpt') as HTMLTextAreaElement).value.trim();
    const pageRaw = ($('#idea-ev-page') as HTMLInputElement).value.trim();
    const origin = ($('#idea-ev-origin') as HTMLSelectElement).value as any;
    const pkey = ($('#idea-ev-paper') as HTMLSelectElement).value;
    const pit = library.find((x) => x.key === pkey);
    const evidence = (excerpt || pageRaw) ? [{ id: `ev-${Date.now()}`, paperKey: pkey, paperTitle: pit?.paper.title ?? pkey, origin, page: pageRaw ? Number(pageRaw) : null, excerpt }] : [];
    const res = await api.saveIdea({
      question: qv, observation: ($('#idea-o') as HTMLTextAreaElement).value.trim(),
      hypothesis: ($('#idea-h') as HTMLTextAreaElement).value.trim(), method: ($('#idea-m') as HTMLTextAreaElement).value.trim(),
      experiment: ($('#idea-e') as HTMLTextAreaElement).value.trim(), status: 'Idea', evidence,
    });
    if (!res.ok) { $('#idea-msg')!.textContent = '未保存：' + res.error; return; }
    renderIdeas();
  });
  document.querySelectorAll('[data-idel]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('删除这条想法？此操作不可撤销。')) return;
    await api.deleteIdea((el as HTMLElement).dataset.idel!); renderIdeas();
  }));
  document.querySelectorAll('[data-istatus]').forEach((el) => el.addEventListener('change', async () => {
    const id = (el as HTMLElement).dataset.istatus!;
    const cur = ideas.find((x: any) => x.id === id);
    await api.saveIdea({ ...cur, status: (el as HTMLSelectElement).value }); renderIdeas();
  }));
}

// ---------- 对比（CompareWorkspace） ----------
let cmpSelected: string[] = [];
async function renderCompare(): Promise<void> {
  await reloadLibrary();
  const session = await api.getCompare();
  if (session.selected?.length && !cmpSelected.length) cmpSelected = session.selected;
  const pinned: string | null = session.pinned ?? null;
  const order: string[] = session.order ?? cmpSelected;
  session.selected = cmpSelected.filter((k: string) => library.some((it) => it.key === k));
  const chosen = (order.length ? order : cmpSelected).map((k) => library.find((it) => it.key === k)).filter(Boolean);
  const fields = chosen.length ? await api.compareFields(chosen.map((c: any) => c.key)) : [];
  const dimSel = (window as any).__cmpDim ?? '全部';
  const dims = dimSel === '模型结构' ? ['task', 'volume_repr', 'projection_use', 'key_modules']
    : dimSel === '实验协议' ? ['views', 'geometry', 'dataset', 'training', 'loss', 'baselines', 'metrics', 'results']
    : ['task', 'volume_repr', 'projection_use', 'geometry', 'views', 'dataset', 'training', 'baselines', 'metrics', 'results'];
  const labels: Record<string, string> = { task: '任务', volume_repr: '表示 / 网络', projection_use: '输入输出与投影约束', geometry: '几何', views: '视角数', dataset: '数据集', training: '训练与硬件', loss: '损失', baselines: '对比基线', metrics: '指标', results: '结果', key_modules: '核心模块' };
  const rows: Array<[string, string[]]> = dims.map((f) => [labels[f] ?? f, chosen.map((c: any, i: number) => {
    const fl = fields[i] ?? {};
    if (f === 'views') return fl.views ?? '论文未说明 / 尚未抽取';
    if (f === 'geometry') return fl.geometry ?? '论文未说明 / 尚未抽取';
    if (f === 'dataset') return fl.datasets ?? '论文未说明 / 尚未抽取';
    return '论文未说明 / 尚未抽取';
  })]);
  const warns: string[] = await api.compareWarnings(rows.filter(([l]) => ['视角数', '几何', '数据集'].includes(l)) as Array<[string, string[]]>);

  $('#main').innerHTML = `
    <div class="row between"><div class="page-title" style="margin:0">方法与实验对比</div><button class="small" data-nav="library">选择论文</button></div>
    <p class="sub">在论文库选择 2–8 篇。选择集与固定列自动保存，重启后恢复。</p>
    ${warns.length ? `<div class="warn">${warns.map((w) => '⚠ ' + inlineHTML(w)).join('<br>')}</div>` : ''}
    <div class="row">
      <select id="cmp-dim">${['全部', '模型结构', '实验协议'].map((x) => `<option${x === dimSel ? ' selected' : ''}>${x}</option>`).join('')}</select>
      <button class="small" id="cmp-md" ${cmpSelected.length < 2 ? 'disabled' : ''}>Markdown</button>
      <button class="small" id="cmp-csv" ${cmpSelected.length < 2 ? 'disabled' : ''}>CSV</button>
      <span class="spacer"></span>
      <button class="small" id="cmp-clear">清空选择</button>
      ${pinned ? '<button class="small" id="cmp-unpin">取消固定</button>' : ''}
    </div>
    <h2>选择论文（${cmpSelected.length} / 8）</h2>
    <div class="grid">${library.filter((it) => it.state.status !== 'deleted').map((it) => `<label class="card pick"><input type="checkbox" data-pick="${inlineHTML(it.key)}" ${cmpSelected.includes(it.key) ? 'checked' : ''}> ${inlineHTML(it.paper.title ?? it.key)}</label>`).join('')}</div>
    ${chosen.length >= 2 ? `<h2>对比表</h2>
      <div class="table-wrap"><table><thead><tr><th>维度</th>${chosen.map((c: any) => `<th>${inlineHTML(c.paper.title ?? c.key)}<br><button class="small" data-pin="${inlineHTML(c.key)}">${pinned === c.key ? '已固定 📌' : '固定此列'}</button></th>`).join('')}</tr></thead>
      <tbody>${rows.map(([l, vs]) => `<tr><th>${inlineHTML(l)}</th>${vs.map((v) => `<td>${inlineHTML(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <p class="sub">注：不同实验协议的指标不可直接排名；研究笔记字段需要回原文核对。</p>` : '<div class="card"><span class="sub">请选择至少两篇论文开始对比。</span></div>'}
  `;
  ($('#cmp-dim') as HTMLSelectElement)?.addEventListener('change', (e) => { (window as any).__cmpDim = (e.target as HTMLSelectElement).value; renderCompare(); });
  document.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('change', () => toggleCompare((el as HTMLElement).dataset.pick!, true)));
  document.querySelectorAll('[data-pin]').forEach((el) => el.addEventListener('click', async () => {
    const k = (el as HTMLElement).dataset.pin!;
    await api.setCompare(cmpSelected, pinned === k ? null : k);
    renderCompare();
  }));
  $('#cmp-clear')?.addEventListener('click', async () => { cmpSelected = []; await api.setCompare([], null); renderCompare(); });
  $('#cmp-unpin')?.addEventListener('click', async () => { await api.setCompare(cmpSelected, null); renderCompare(); });
  $('#cmp-md')?.addEventListener('click', () => exportCompare('md', rows, chosen));
  $('#cmp-csv')?.addEventListener('click', () => exportCompare('csv', rows, chosen));
  wireCommon();
}

async function toggleCompare(key: string, rerender = false): Promise<void> {
  if (cmpSelected.includes(key)) cmpSelected = cmpSelected.filter((k) => k !== key);
  else if (cmpSelected.length < 8) cmpSelected = [...cmpSelected, key];
  else { alert('最多选择 8 篇论文'); }
  (window as any).__cmpSelected = cmpSelected;
  await api.setCompare(cmpSelected, null);
  if (rerender) renderCompare(); else renderLibrary();
}

function exportCompare(fmt: string, rows: Array<[string, string[]]>, chosen: any[]): void {
  // CSV 公式注入防护：以 = + @ 制表符开头（或以 - 开头且不是数值）的单元格会被 Excel
  // 当公式执行；论文标题/摘要来自外部 API，属不可信输入。
  const csvCell = (c: unknown): string => {
    const s = String(c ?? '');
    return /^(?:[=@+\t\r]|-(?![0-9.]))/.test(s) ? `'${s}` : s;
  };
  const matrix = [['维度', ...chosen.map((c) => c.paper.title ?? c.key)], ...rows.map(([l, vs]) => [l, ...vs])];
  const text = fmt === 'csv'
    ? matrix.map((r) => r.map((c) => `"${csvCell(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')
    : matrix.map((r, i) => '| ' + r.map((c) => String(c).replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ') + ' |').join('\n');
  void api.exportText(`CBCT-comparison.${fmt}`, text);
}

// ---------- 趋势（保留原有页面，纳入「⋯」菜单） ----------
async function renderTrend(): Promise<void> {
  await reloadLibrary();
  const t = await api.getTrend();
  const smp = t.sample;
  const windowText = smp.windowStart && smp.windowEnd ? `${smp.windowStart} ~ ${smp.windowEnd}` : '时间窗口未知';
  const supported = t.findings.filter((f: any) => f.isSupported);
  const unsupported = t.findings.filter((f: any) => !f.isSupported);
  $('#main').innerHTML = `
    <div class="page-title">趋势 / Research Gap</div>
    <p class="sub">时间窗口 ${inlineHTML(windowText)} · 样本数 ${smp.papers.length} 篇 · 最小样本量 ${t.minimumSample} 篇</p>
    ${smp.papers.length < t.minimumSample ? `<div class="warn">当前检索范围只有 ${smp.papers.length} 篇，低于最小样本量 ${t.minimumSample}：<b>不下趋势判断</b>，只报告计数与证据集合。</div>` : ''}
    <h2>可下判断（样本 ≥ ${t.minimumSample}）</h2>
    ${supported.length ? supported.map((f: any) => trendCard(f)).join('') : '<div class="sub">暂无达到最小样本量的方向。</div>'}
    <h2>仅计数（样本不足，不下判断）</h2>
    ${unsupported.length ? unsupported.map((f: any) => trendCard(f)).join('') : '<div class="sub">无。</div>'}
    <h2>缺口表述示例</h2>
    <section class="card"><p>${inlineHTML(t.gapExample)}</p><p class="sub">缺口表述固定为「检索范围内未见」，不构成「首次」声明。</p></section>`;
  document.querySelectorAll('[data-redline]').forEach((el) => el.addEventListener('click', async () => {
    const r = await api.checkRedline((el as HTMLElement).dataset.redline!);
    alert(r.violates ? '该表述命中红线（声称首次/无人研究），已拒绝。' : '通过红线自检。');
  }));
}
function trendCard(f: any): string {
  return `<article class="card"><div class="row between" style="margin:0"><h3>${inlineHTML(f.topic)}</h3><span class="pill teal">${f.count} 篇</span></div>
    <p>${inlineHTML(f.claim)}</p><p class="sub" style="margin:0">${inlineHTML(f.disclosure)}</p><p class="sub" style="margin:0">${inlineHTML(f.caveat)}</p>
    <div class="row"><button class="small" data-redline="${inlineHTML(f.claim)}">检查表述红线</button></div></article>`;
}

// ---------- 设置（Settings） ----------
async function renderSettings(): Promise<void> {
  const cfg = await api.getConfig();
  $('#main').innerHTML = `
    <div class="page-title">AI 助教配置</div>
    <p class="sub">配置与 macOS 版共用 <code>app/config.json</code>。API Key 只写入本地文件，不会回显到界面。</p>
    <section class="card form">
      <label>API 地址<input id="cfg-base" value="${inlineHTML(cfg.baseURL)}" placeholder="https://api.example.com/v1"></label>
      <label>模型名<input id="cfg-model" value="${inlineHTML(cfg.model)}" placeholder="glm-4.6"></label>
      <label>API Key<input id="cfg-key" type="password" placeholder="${cfg.hasKey ? '已配置（留空表示不修改）' : '在这里填入'}"></label>
      <div class="row"><button class="primary" id="cfg-save">保存</button><span id="cfg-msg" class="sub"></span></div>
      <p class="sub">配置文件：<code>${inlineHTML(cfg.path)}</code></p>
    </section>
    <section class="card form">
      <h3>跨论文检索（R-05）</h3>
      <p class="sub">Chat 会在论文库其他论文中检索候选材料。嵌入端点不可用时自动回退关键词检索；检索只读本地索引，不阻塞问答首响应。</p>
      <div class="row"><button class="small" id="retrieval-refresh">刷新检索索引状态</button><span id="retrieval-msg" class="sub"></span></div>
    </section>`;
  $('#cfg-save')?.addEventListener('click', async () => {
    await api.setConfig({ baseURL: val0('#cfg-base'), model: val0('#cfg-model'), apiKey: ($('#cfg-key') as HTMLInputElement).value });
    $('#cfg-msg')!.textContent = '已保存';
  });
  const refreshRetrieval = async (): Promise<void> => {
    const s = await api.retrievalStatus();
    $('#retrieval-msg')!.textContent = `已有全文 ${s.cached} 篇 · 已建索引 ${s.indexed} 篇 · 含向量 ${s.embedded} 篇`;
  };
  $('#retrieval-refresh')?.addEventListener('click', refreshRetrieval);
  void refreshRetrieval();
}

// ---------- 复现准备（ReproductionPanel） ----------
let reproKey: string | null = null;
async function renderReproduction(): Promise<void> {
  const r = await api.getReproduction(reproKey);
  const doc = r.doc ?? { revisions: {} };
  const revisions: string[] = Object.keys(doc.revisions ?? {});
  const latest = revisions[revisions.length - 1];
  const analysis = latest ? (doc.analyses ?? {})[latest] : null;
  const isUnknown = (it: any): boolean => it?.finding?.page == null;
  const groups: Array<[string, string, any[]]> = analysis ? [
    ['resources', '资源 · 数据 / 代码 / 权重', analysis.resources],
    ['environment', '环境 · 依赖 / 特殊算子', analysis.environment],
    ['cost', '训练成本 · 时间 / 显存', analysis.cost],
    ['missing', '关键缺失 · 几何 / 预处理 / 参数', analysis.missing],
    ['risks', '风险 · 实现 / 评测协议', analysis.risks],
  ] : [];
  const allItems = groups.flatMap(([, , items]) => items ?? []);
  const unknownCount = allItems.filter(isUnknown).length;

  $('#main').innerHTML = `
    <div class="row between"><div class="page-title" style="margin:0">复现准备</div><button class="small" id="repro-back">返回论文库</button></div>
    <p class="sub">论文：<code>${inlineHTML(reproKey ?? '')}</code>${latest ? ` · 分析版本 ${inlineHTML(latest.slice(0, 12))}` : ''}</p>
    ${r.ok ? '' : `<div class="warn">核对清单读取失败：${inlineHTML(r.error)}</div>`}
    <section class="card form">
      <label>粘贴复现分析 JSON（由 AI 产出）<textarea id="repro-json"></textarea></label>
      <div class="row"><button class="primary" id="repro-analyze">校验并保存</button><span id="repro-msg" class="sub"></span></div>
      <p class="sub">校验要求：每组 1–4 项、标题不重复、字段/分析/核对行动都不为空；存在类字段必须有页码与逐字摘录；分析与行动里引用的 <code>Page N</code> 必须真实存在。未知项（<code>page: null</code>）仍必须给出核对行动。</p>
    </section>
    ${analysis ? `<p class="sub">共 ${allItems.length} 项，其中 ${unknownCount} 项为未知（需人工核对）。未知不计入「已确认」。</p>
      ${groups.map(([, label, items]) => `<h2>${inlineHTML(label)}</h2>
        ${(items && items.length) ? items.map((it: any) => {
          const itemId = `${it.finding.k}|${it.finding.page ?? 'unknown'}`;
          const t = latest ? ((doc.revisions?.[latest]?.[itemId]) ?? { status: 'todo', note: '' }) : { status: 'todo', note: '' };
          return `<article class="card${isUnknown(it) ? ' unknown' : ''}">
            <div class="row between" style="margin:0"><h3>${inlineHTML(it.finding.k)}${isUnknown(it) ? ' <span class="badge">未知</span>' : ''}</h3>
              <select data-repro-status="${inlineHTML(itemId)}">${[['todo', '待核对'], ['verified', '已核对'], ['blocked', '受阻']].map(([v, l]) => `<option value="${v}"${t.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
            <p>${inlineHTML(it.assessment)}</p><p class="sub" style="margin:0">核对行动：${inlineHTML(it.action)}</p>
            ${it.finding.page != null ? `<p class="sub" style="margin:0">原文：Page ${inlineHTML(String(it.finding.page))} · ${inlineHTML(it.finding.excerpt ?? '')}</p>` : '<p class="sub" style="margin:0">原文：论文未说明（保持未知，不补造）</p>'}
            <input data-repro-note="${inlineHTML(itemId)}" placeholder="核对备注（自动保存）" value="${inlineHTML(t.note ?? '')}">
          </article>`;
        }).join('') : '<div class="sub">该组暂无条目。</div>'}`).join('')}`
      : '<div class="card"><span class="sub">还没有复现分析。粘贴 AI 产出的 JSON 后点「校验并保存」。</span></div>'}`;

  $('#repro-back')?.addEventListener('click', () => setMode('library'));
  $('#repro-analyze')?.addEventListener('click', async () => {
    const raw = ($('#repro-json') as HTMLTextAreaElement).value.trim();
    if (!raw) { $('#repro-msg')!.textContent = '请先粘贴分析 JSON'; return; }
    $('#repro-msg')!.textContent = '校验中…';
    const res = await api.analyzeReproduction(reproKey, raw);
    if (!res.ok) { $('#repro-msg')!.textContent = '未保存：' + res.error; return; }
    renderReproduction();
  });
  document.querySelectorAll('[data-repro-status]').forEach((el) => el.addEventListener('change', async () => {
    if (!latest) return;
    await api.setReproductionTask(reproKey, latest, (el as HTMLElement).dataset.reproStatus!, { status: (el as HTMLSelectElement).value });
    renderReproduction();
  }));
  document.querySelectorAll('[data-repro-note]').forEach((el) => {
    let timer: number | undefined;
    el.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => { if (latest) await api.setReproductionTask(reproKey, latest, (el as HTMLElement).dataset.reproNote!, { note: (el as HTMLInputElement).value }); }, 500);
    });
  });
}

// ---------- 精读室（ReaderView，4 步） ----------
async function openReader(key: string, step = 1): Promise<void> {
  currentKey = key; currentStep = step; chatHistory = [];
  await renderReader();
}

async function renderReader(): Promise<void> {
  const key = currentKey!;
  const item = library.find((x) => x.key === key);
  const text = await api.getText(key);
  const raw = text.text ?? '';
  const noteRes = await api.getNote(key);
  const note = noteRes?.ok ? noteRes.note : null;
  const progress = (await api.getProgress(key)) ?? {};
  // 用已取到的 progress 预置反思缓存：第 3/4 步直接打开（不经 goStep）时，
  // 若缓存为空，编辑单个输入框会用 `{reflections:{那一个字段}}` 覆盖掉磁盘上已有的 q1/q2/q3/doubt（静默丢数据）。
  _progressCache = { ...(progress.reflections ?? {}) };
  if (progress.step && currentStep === 1 && !(window as any).__stepInit) currentStep = progress.step;
  const SECTION_TITLES: Record<string, string> = { summary: '一句话总结', setup: '问题设定', method: '方法核心', experiments: '实验可信度', insights: '研究启发', annotations: '我的批注' };
  const stepNames = ['① 问题感', '② 读原文', '③ 挑毛病', '④ 留笔记'];

  const noteHTML = note ? `<section class="pane">
    <div class="row between" style="margin:0"><h2 style="margin:0">精读笔记</h2><span class="sub" style="margin:0">${inlineHTML(note.file)}</span></div>
    <div class="warn">左侧「精读笔记」来自 <code>papers/</code>，与 macOS 版共用；它是研究者的笔记，不是论文原文，事实仍需回原文核对。</div>
    ${['summary', 'setup', 'method', 'experiments', 'insights', 'annotations'].filter((k) => (note.sections[k] ?? '').trim()).map((k) => `<h3>${SECTION_TITLES[k]}</h3>${renderMarkdown(note.sections[k])}`).join('')}
  </section>` : '';

  $('#main').innerHTML = `
    <div class="row between">
      <div>
        <button class="small" id="btn-back">← 工作台</button>
        <h1 style="display:inline-block;margin-left:10px">${inlineHTML(item?.paper.title ?? key)}</h1>
        <div class="sub">${inlineHTML(item?.paper.venue ?? '')}</div>
      </div>
      <div class="row" style="margin:0"><button class="small" id="btn-fav">${item?.state.favorite ? '★ 已收藏' : '☆ 收藏'}</button></div>
    </div>
    <div class="steps">${stepNames.map((n, i) => `<button class="${currentStep === i + 1 ? 'active' : ''}" data-gostep="${i + 1}">${n}</button>`).join('')}</div>
    ${text.isOCR ? '<div class="warn">该 PDF 全文来自机器 OCR：摘录校验可能失效，请务必人工核对。</div>' : ''}
    ${renderStep(raw, note, item, progress, noteHTML)}
  `;
  wireReader(key);
}

function renderStep(raw: string, note: any, item: any, progress: any, noteHTML: string): string {
  if (currentStep === 1) {
    const setup = note?.sections?.setup || note?.sections?.summary || '';
    return `<div class="reader">
      <section class="pane">
        <span class="pill yellow">今日阅读</span>
        <div style="font-weight:600">${inlineHTML(setup || '这篇论文想解决什么问题？先读摘要，再让助教给个导览。')}</div>
        <h3>带着这三个问题读</h3>
        <ol><li>它解决了什么问题？</li><li>方法是怎么工作的？</li><li>该关联到你已读的哪篇？</li></ol>
        <div class="row"><button class="small" data-gostep="2">我准备好了，开始读 →</button></div>
      </section>
      <section class="pane">
        <h2>AI 助教 · 问题感</h2>
        <div class="row"><button class="primary small" id="btn-tour">先让助教给个 3 分钟导览</button><button class="small" data-gostep="2">去读原文 →</button></div>
        <div id="chat" class="chat"></div>
      </section>
      ${noteHTML}
    </div>`;
  }
  if (currentStep === 3) {
    return `<div class="reader">
      <section class="pane">
        <h2>挑毛病</h2>
        <div class="row"><button class="primary small" id="btn-critique">让助教先挑三个刺</button><button class="small" data-gostep="2">回看原文</button></div>
        <div id="chat" class="chat"></div>
      </section>
      <section class="pane">
        <h3>我的存疑清单</h3>
        <textarea id="doubt" placeholder="记录你对这篇论文的疑问…" style="min-height:160px">${inlineHTML(progress.reflections?.doubt ?? '')}</textarea>
        <div class="row"><button class="primary small" data-gostep="4">下一步：留下我的理解 →</button></div>
      </section>
      ${noteHTML}
    </div>`;
  }
  if (currentStep === 4) {
    return `<div class="reader">
      <section class="pane">
        <h2>留笔记</h2>
        ${['1：这篇论文最重要的结论是什么？', '2：哪些地方我还不确定？', '3：能迁移到我的研究吗？'].map((q, i) => `<label style="display:block;margin-bottom:10px"><span class="sub" style="margin:0">问题 ${q}</span><textarea data-q="${i + 1}" style="min-height:64px">${inlineHTML(progress.reflections?.['q' + (i + 1)] ?? '')}</textarea></label>`).join('')}
        <label style="display:block"><span class="sub" style="margin:0">自由批注</span><textarea id="free-note" style="min-height:110px">${inlineHTML(progress.freeNote ?? '')}</textarea></label>
        <div class="row"><button class="primary" id="btn-finish">完成今天的精读</button></div>
      </section>
      <section class="pane">
        <h2>后续动作</h2>
        <div class="row"><button class="small" id="btn-goto-repro">评估复现可行性</button><button class="small" id="btn-apply">迁移到我的研究</button></div>
        <div id="apply-out"></div>
        <p class="sub">完成后会计入连续阅读；批注保存在 <code>app/data/progress.json</code>。</p>
      </section>
      ${noteHTML}
    </div>`;
  }
  // step 2：读原文 + 分层精读子面板
  const panel = (window as any).__readerPanel ?? 'method';
  const pdfMode = !!item?.hasPDF && (window as any).__readerTextMode === 'pdf';
  const panels: Array<[string, string, string]> = [
    ['motivation', '论文动机', '解析论文动机'],
    ['method', '方法与公式', '解析数据流、模块、公式与几何'],
    ['experiment', '实验配置', '抽取实验配置'],
    ['results', '结果分析', '解析结果图表与逐项解读'],
    ['code', '论文与代码', '映射论文概念到仓库代码'],
  ];
  return `<div class="reader reader-step2">
    <section class="pane pane-wide">
      <div class="row between" style="margin:0">
        <div class="row" style="margin:0"><h2 style="margin:0">原文</h2><span class="sub" style="margin:0">共 ${(raw.match(/=== Page/g) ?? []).length} 页</span></div>
        ${item?.hasPDF ? `<div class="row" style="margin:0"><button class="small ${pdfMode ? '' : 'primary'}" id="btn-mode-text">文本层</button><button class="small ${pdfMode ? 'primary' : ''}" id="btn-mode-pdf">PDF 原版</button></div>` : ''}
      </div>
      <div class="row">
        ${item?.hasPDF ? '<button class="small" id="btn-pdf">用系统阅读器打开 PDF</button>' : ''}
        ${raw ? '' : '<button class="primary small" id="btn-auto-import">下载并导入全文</button>'}
      </div>
      ${raw ? '' : '<p class="sub">本地还没有全文。点「下载并导入全文」会按论文的公开 PDF 地址下载并抽取文本（不绕过任何访问限制）。</p>'}
      ${pdfMode ? `
      <div class="row" id="pdfv-bar">
        <button class="small" id="pdfv-out" title="缩小">−</button>
        <span class="sub" id="pdfv-zoom" style="margin:0;min-width:48px;text-align:center">适宽</span>
        <button class="small" id="pdfv-in" title="放大">＋</button>
        <button class="small" id="pdfv-fit">适宽</button>
        <span class="spacer"></span>
        <span class="sub" id="pdfv-pos" style="margin:0">页 1</span>
        <input id="pdfv-jump" type="number" min="1" style="width:62px" placeholder="页码">
        <button class="small" id="pdfv-go">跳转</button>
      </div>
      <div id="pdf-view"><p class="sub">正在加载 PDF…</p></div>`
      : `<div class="text-pane" id="text-pane">${raw ? renderMarkdown(reflowPaperText(raw.replace(/=== Page (\d+) ===/g, '\n\n## Page $1\n\n'))) : '<p class="sub">没有全文缓存。可点上方按钮自动下载导入，或用顶部「⋯ → 导入论文 PDF」手动添加。</p>'}</div>`}
    </section>
    <section class="pane">
      <h2 style="margin-top:0">精读面板</h2>
      <div class="steps" style="margin-top:0">${panels.map(([k, label]) => `<button class="small ${panel === k ? 'active' : ''}" data-panel="${k}">${label}</button>`).join('')}</div>
      <div id="panel-body"></div>
    </section>
  </div>
  <button id="fab-ai" title="AI 助教">💬</button>
  <div id="ai-dock" class="ai-dock" hidden>
    <div class="row between" style="margin:0 0 8px">
      <b style="margin:0">AI 助教</b>
      <button class="small" id="dock-close" title="收起">✕</button>
    </div>
    <div class="row">
      <select id="scope">${['全文', 'Method', 'Experiment', 'Appendix', 'Figure'].map((s) => `<option>${s}</option>`).join('')}</select>
      <select id="mode"><option value="chat">自由提问</option><option value="problem">建立问题感</option><option value="critique">Critical View</option></select>
    </div>
    <div id="chat" class="chat"></div>
    <div class="row"><textarea id="q" placeholder="就这篇论文提问…（Ctrl+Enter 发送）"></textarea><button class="primary" id="btn-ask">发送</button></div>
    <p class="sub" style="margin-bottom:0">回答会标注 Page N；点 Page N 可跳转原文。没有全文缓存时不会做事实分析。</p>
  </div>`;
}

/** 渲染精读子面板内容（结果从 readings/<key>.json 读取）。 */
async function renderPanel(key: string): Promise<void> {
  const body = document.getElementById('panel-body');
  if (!body) return;
  const panel = (window as any).__readerPanel ?? 'method';
  if (panel === 'code') { await renderCodePanel(key, body); return; }
  const readings = await api.getReadingCached(key);
  const map = { motivation: 'motivation', method: 'method', experiment: 'experimentJSON', results: 'resultsJSON' } as Record<string, string>;
  const fieldName = map[panel] ?? panel;
  const cached = readings[fieldName];
  // 主进程降级保存的「未核验」标记：结果照常展示，但明确披露校验未过，不伪造背书
  const validation = readings[fieldName + 'Validation'];
  const unverified = validation && validation.ok === false
    ? `<div class="warn"><b>⚠ 本结果未通过证据校验</b>（自动修正 ${validation.attempts ?? '?'} 次后仍有个别事实缺页码或与摘录不符），已保存供参考——逐条对照原文核对后再采信。<details class="rp-quote"><summary>校验错误详情</summary><pre class="math-block" style="white-space:pre-wrap">${inlineHTML(String(validation.error ?? '').slice(0, 1500))}</pre></details></div>`
    : '';
  // 兜底修剪的「已降级」清单：输出通过了校验，但部分事实被诚实标为「论文未说明」/剔除
  const demotedList = Array.isArray(readings[fieldName + 'Demoted']) ? readings[fieldName + 'Demoted'] as string[] : [];
  const demotedNote = demotedList.length
    ? `<div class="rp-demoted"><b>已自动降级 ${demotedList.length} 条：</b>${demotedList.map((d) => inlineHTML(d)).join('；')}。保持未知是刻意的——无逐字摘录支持的事实不冒充已核验。</div>`
    : '';
  const label = ({ motivation: '论文动机', method: '方法与公式', experiment: '实验配置', results: '结果分析' } as Record<string, string>)[panel] ?? panel;
  body.innerHTML = `
    <div class="rp-bar">
      <button class="primary small" id="panel-gen">${cached ? '↻ 重新生成' : '⚡ 解析' + label}</button>
      <span id="panel-msg" class="sub rp-status">${unverified ? '<b style="color:var(--gold)">未核验，请人工核对</b>' : demotedList.length ? `<b style="color:var(--teal)">已通过校验（降级 ${demotedList.length} 条）</b>` : cached ? '已生成，可重新生成' : ''}</span>
    </div>
    <div id="panel-out">${cached ? unverified + demotedNote + renderReading(panel, cached) : '<div class="rp-empty"><b>还没有解析结果</b><span>点上方按钮让 AI 解析本篇；每条事实都必须带页码 + 原文摘录，校验不过会自动修正重试，仍不过则兜底降级保存。</span></div>'}</div>
    <div id="panel-baselines"></div>
    <div id="panel-figure"></div>
    <div id="panel-formula"></div>`;
  // 面板内容是 wireReader 之后才填充的，其中的 Page 芯片需在此接线
  body.querySelectorAll('.ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
  $('#panel-gen')?.addEventListener('click', async () => {
    const b = $('#panel-gen') as HTMLButtonElement; b.disabled = true; b.textContent = '解析中…';
    $('#panel-msg')!.textContent = '正在调用 AI 并校验证据（未通过时自动修正，最多 4 次尝试）…';
    const r = await api.generateReading(key, panel, !!cached);
    if (!r.ok) { b.disabled = false; b.textContent = (cached ? '重新生成' : '解析 ' + label); $('#panel-msg')!.textContent = '未保存：' + r.error; return; }
    renderPanel(key);
  });
  if (panel === 'experiment') void renderBaselines(key);
  if (panel === 'method') { void renderFigurePanel(key); void renderFormulaOCR(key); }
}

/**
 * 架构图解析（移植自 macOS FigureAnalysis）：定位图题 → 光栅化该页 → 视觉模型提结构
 * → 用图内 OCR 校验标签 → 分层布局渲染。标签核验不通过就不展示结构，绝不推测。
 */
async function renderFigurePanel(key: string): Promise<void> {
  const el = document.getElementById('panel-figure');
  if (!el) return;
  const loc = await api.figureLocate(key);
  el.innerHTML = `
    <details class="rp-tool">
      <summary>模型结构图解析${loc ? `<span class="rp-tag">检测到图题：${inlineHTML(String(loc.title).slice(0, 40))}</span>` : ''}</summary>
      <p class="sub">识别架构图中的模块与连接，节点标签必须能在图内 OCR 文本中找到才展示；不做结构推测。</p>
      <div class="row">
        <label class="sub" style="margin:0">页码 <input id="figure-page" type="number" min="1" value="${loc?.page ?? 1}" style="width:72px"></label>
        <button class="primary small" id="figure-run">解析结构图</button>
      </div>
      <div id="figure-msg" class="sub" style="margin:0"></div>
      <div id="figure-out"></div>
    </details>`;
  $('#figure-run')?.addEventListener('click', async () => {
    const msg = $('#figure-msg')!; const out = $('#figure-out')!;
    const page = Number(($('#figure-page') as HTMLInputElement).value || '1');
    const b = $('#figure-run') as HTMLButtonElement; b.disabled = true; b.textContent = '解析中…';
    try {
      const bytes = await api.pdfBytes(key);
      if (!bytes) { out.innerHTML = '<div class="warn">本地没有该论文 PDF，无法光栅化页面。</div>'; return; }
      msg.textContent = `光栅化第 ${page} 页…`;
      const raster = await rasterizePage(new Uint8Array(bytes), page, 1800);
      msg.textContent = '视觉模型解析 + 图内 OCR 核验…';
      const r = await api.figureAnalyze(key, raster.dataURL);
      msg.textContent = '';
      if (!r.ok) { out.innerHTML = `<div class="warn">${inlineHTML(r.error)}</div>` + (r.title ? `<div class="sub">图题：${inlineHTML(String(r.title).slice(0, 120))}</div>` : ''); return; }
      renderFigureResult(r.analysis);
    } catch (e) {
      msg.textContent = ''; out.innerHTML = `<div class="warn">${inlineHTML(e instanceof Error ? e.message : String(e))}</div>`;
    } finally { b.disabled = false; b.textContent = '解析结构图'; }
  });
}

function renderFigureResult(analysis: any): void {
  const out = document.getElementById('figure-out');
  if (!out || !analysis) return;
  const W = 640, H = 340;
  const svg = figureSVG({ placed: layoutFigure(analysis.nodes, analysis.edges, W, H, false).placed, arrows: layoutFigure(analysis.nodes, analysis.edges, W, H, false).arrows, layerCount: 0 }, W, H);
  out.innerHTML = `
    <div class="sub" style="margin:0">${analysis.title ? inlineHTML(String(analysis.title).slice(0, 120)) : '未找到图题'}</div>
    <div style="border:1px solid var(--line);border-radius:10px;background:#FBF9F3;height:${H}px">${svg}</div>
    <div class="sub" style="margin:4px 0 0">节点 ${analysis.nodes.length} · 连接 ${analysis.edges.length}${analysis.dropped?.length ? ` · 已剔除未核验标签 ${analysis.dropped.length} 个` : ''}</div>
    ${analysis.note ? `<div class="sub" style="margin:0;color:var(--gold)">${inlineHTML(analysis.note)}</div>` : ''}
    <ul>${analysis.nodes.map((n: any) => `<li class="sub">${inlineHTML(n.label)} <span style="color:var(--teal)">[${inlineHTML(n.kind)}]</span></li>`).join('')}</ul>`;
}


/**
 * 公式 OCR（移植自 macOS R-07）：把 PDF 某页光栅化后交视觉模型转写为 LaTeX，
 * 再用「原页图 + 转写」做逐符号核对。API 不支持视觉时明确降级提示，不静默失败。
 */
async function renderFormulaOCR(key: string): Promise<void> {
  const el = document.getElementById('panel-formula');
  if (!el) return;
  el.innerHTML = `
    <details class="rp-tool">
      <summary>公式 OCR<span class="rp-tag">本地页面 → LaTeX 转写</span></summary>
      <p class="sub">对没有文本层或公式运算符缺失的页面，用配置的多模态模型转写为 LaTeX，再逐符号核对。转写结果仍需人工核对。</p>
      <div class="row">
        <label class="sub" style="margin:0">页码 <input id="formula-page" type="number" min="1" value="1" style="width:72px"></label>
        <button class="primary small" id="formula-run">转写本页公式</button>
        <button class="small" id="ocr-run">OCR 本页文字</button>
      </div>
      <div id="formula-msg" class="sub" style="margin:0"></div>
      <div id="formula-out"></div>
    </details>`;
  // Windows 内置 OCR 是否可用（不可用则隐藏按钮）
  void api.ocrAvailable().then((ok: boolean) => { if (!ok) { const b = document.getElementById('ocr-run'); if (b) b.style.display = 'none'; } });
  $('#ocr-run')?.addEventListener('click', async () => {
    const msg = $('#formula-msg')!;
    const out = $('#formula-out')!;
    const page = Number(($('#formula-page') as HTMLInputElement).value || '1');
    const b = $('#ocr-run') as HTMLButtonElement;
    b.disabled = true; b.textContent = '识别中…';
    try {
      const bytes = await api.pdfBytes(key);
      if (!bytes) { out.innerHTML = '<div class="warn">本地没有该论文 PDF，无法光栅化页面。</div>'; return; }
      msg.textContent = `光栅化第 ${page} 页…`;
      const raster = await rasterizePage(new Uint8Array(bytes), page, 2400);
      msg.textContent = 'Windows OCR 识别中…';
      const r = await api.ocrPage(key, page, raster.dataURL);
      if (!r.ok) { msg.textContent = ''; out.innerHTML = `<div class="warn">${inlineHTML(r.error)}</div>`; return; }
      msg.textContent = '';
      out.innerHTML = `<div class="sub">已把第 ${page} 页 OCR 文本写入全文缓存（${r.chars} 字符，${r.lines} 行），带 OCR 标记，摘录校验可能失效，请人工核对。</div>`;
      await renderReader();
    } catch (e) {
      msg.textContent = '';
      out.innerHTML = `<div class="warn">${inlineHTML(e instanceof Error ? e.message : String(e))}</div>`;
    } finally { b.disabled = false; b.textContent = 'OCR 本页文字'; }
  });
  $('#formula-run')?.addEventListener('click', async () => {
    const msg = $('#formula-msg')!;
    const out = $('#formula-out')!;
    const page = Number(($('#formula-page') as HTMLInputElement).value || '1');
    const b = $('#formula-run') as HTMLButtonElement;
    b.disabled = true; b.textContent = '处理中…';
    try {
      msg.textContent = '读取 PDF…';
      const bytes = await api.pdfBytes(key);
      if (!bytes) { msg.textContent = ''; out.innerHTML = '<div class="warn">本地没有该论文 PDF，无法光栅化页面。</div>'; return; }
      msg.textContent = `光栅化第 ${page} 页…`;
      const raster = await rasterizePage(new Uint8Array(bytes), page);
      msg.textContent = '调用视觉模型转写…';
      const tr = await api.transcribeFormula(raster.dataURL);
      if (!tr.ok) { msg.textContent = ''; out.innerHTML = `<div class="warn">${inlineHTML(tr.error)}</div>`; return; }
      msg.textContent = '逐符号核对…';
      const vr = await api.verifyFormula(raster.dataURL, tr.text);
      const verdict = vr.ok
        ? (vr.allOk ? '<div class="sub" style="color:var(--teal)">核对通过：未发现可从原图确认的不一致。</div>'
          : `<div class="warn">核对发现不一致：<ul>${(vr.problems ?? []).map((p: string) => `<li>${inlineHTML(p)}</li>`).join('')}</ul></div>`)
        : `<div class="sub">核对未完成：${inlineHTML(vr.error ?? '')}</div>`;
      msg.textContent = '';
      out.innerHTML = `${verdict}<div class="sub">转写结果（LaTeX，均已标注「转写待核对」）：</div>` + renderTranscription(tr.text);
    } catch (e) {
      msg.textContent = '';
      out.innerHTML = `<div class="warn">${inlineHTML(e instanceof Error ? e.message : String(e))}</div>`;
    } finally {
      b.disabled = false; b.textContent = '转写本页公式';
    }
  });
}

/** 渲染转写文本：`% Eq. N` 注释 + `$$…$$` 公式块。 */
function renderTranscription(text: string): string {
  const parts = (text ?? '').split(/\$\$/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i].trim();
    if (!chunk) continue;
    if (i % 2 === 1) html += `<div class="math-block-wrap">${mathBlockHTML(chunk).html}</div>`;
    else html += chunk.split('\n').map((l) => `<div class="sub" style="margin:0">${inlineHTML(l)}</div>`).join('');
  }
  return html || '<div class="sub">（未转写到公式）</div>';
}


/** 论文 ↔ 代码映射面板（PRD 4.9）：扫描公开仓库 → 生成映射 → 人工核对。 */
async function renderCodePanel(key: string, body: HTMLElement): Promise<void> {
  const r = await api.codeGet(key);
  const snap = r.ok ? r.snapshot : null;
  const analysis = r.ok ? r.analysis : null;
  const confirmations: Record<string, string> = (r.ok ? r.confirmations : {}) ?? {};
  const todayRepo = (library.find((x) => x.key === key)?.paper as any)?.code ?? '';
  body.innerHTML = `
    <p class="sub">读取公开 GitHub 仓库（固定 commit）、建立论文概念↔代码映射。不执行仓库代码；token 只进请求头。</p>
    <div class="row">
      <input id="code-url" placeholder="https://github.com/owner/repo" value="${inlineHTML(todayRepo)}" style="min-width:260px">
      <button class="primary small" id="code-scan">${snap ? '重新扫描' : '扫描仓库'}</button>
      ${snap ? `<button class="small" id="code-map">${analysis ? '重新生成映射' : '建立映射'}</button>` : ''}
    </div>
    <div id="code-msg" class="sub" style="margin:0"></div>
    ${snap ? `<div class="card flush" style="margin:8px 0">
      <div class="sub" style="margin:0">仓库：${inlineHTML('https://github.com/' + snap.repository.owner + '/' + snap.repository.name)} · commit <code>${inlineHTML(String(snap.commit).slice(0, 12))}</code></div>
      <div class="sub" style="margin:0">读取范围：${snap.files}/${snap.paths} 个文件 · 扫描于 ${inlineHTML(String(snap.scannedAt).slice(0, 19))}</div>
      ${(snap.warnings ?? []).map((w: string) => `<div class="sub" style="margin:0;color:var(--gold)">${inlineHTML(w)}</div>`).join('')}
      <details style="margin-top:6px"><summary class="sub" style="cursor:pointer">文件清单</summary><ul>${(snap.fileList ?? []).map((f: any) => `<li class="sub">${inlineHTML(f.path)} <span style="color:var(--teal)">[${inlineHTML(f.category)}]</span> · ${f.lines} 行</li>`).join('')}</ul></details>
    </div>` : ''}
    ${r.validateError ? `<div class="warn">已保存的映射校验未通过：${inlineHTML(r.validateError)}</div>` : ''}
    ${analysis ? `<h3>映射（AI 推测；人工核对后转「明确映射」）</h3>
      ${analysis.mappings.map((m: any) => {
        const id = m.concept + '|' + m.path + '|' + m.startLine;
        const conf = confirmations[id];
        return `<article class="card flush" style="margin-bottom:8px">
          <div class="row between" style="margin:0"><div style="font-weight:700">${inlineHTML(m.concept)}</div>
            <span class="pill ${conf ? 'mint' : 'peach'}" style="height:22px">${conf ? '明确映射 · 人工核对' : 'AI 推测'} · ${Math.round((m.confidence ?? 0) * 100)}%</span></div>
          <div class="sub" style="margin:0">${inlineHTML(m.path)}:${m.startLine}–${m.endLine} · symbol ${inlineHTML(m.symbol || '未知')}</div>
          <pre class="math-block" style="max-height:120px">${inlineHTML(m.codeExcerpt)}</pre>
          <div>${inlineHTML(m.reasoning)}</div>
          <div class="sub" style="margin:0">论文依据${m.paper?.page ? ` (Page ${inlineHTML(String(m.paper.page))})` : ''}：${inlineHTML(m.paper?.excerpt ?? m.paper?.v ?? '')}</div>
          <div class="row" style="margin:6px 0 0">
            <input data-code-note="${inlineHTML(id)}" placeholder="人工核对说明（留空即取消「明确映射」）" value="${inlineHTML(conf ?? '')}" style="min-width:220px">
            <button class="small" data-code-save="${inlineHTML(id)}">保存核对依据</button>
          </div>
        </article>`;
      }).join('')}
      ${(analysis.missing ?? []).length ? `<h3>待核对</h3><ul>${analysis.missing.map((m: string) => `<li class="sub">${inlineHTML(m)}</li>`).join('')}</ul>` : ''}`
      : (snap ? '<p class="sub">还没有映射。点「建立映射」让 AI 对照论文与代码生成（需已配置 AI）。</p>' : '')}
  `;
  const msg = $('#code-msg')!;
  $('#code-scan')?.addEventListener('click', async () => {
    const url = val0('#code-url');
    if (!url) { msg.textContent = '请先填写公开 GitHub 仓库地址'; return; }
    const b = $('#code-scan') as HTMLButtonElement; b.disabled = true; b.textContent = '扫描中…';
    msg.textContent = '正在读取仓库文件树与 blobs…';
    const res = await api.codeScan(key, url);
    if (!res.ok) { b.disabled = false; b.textContent = '扫描仓库'; msg.textContent = '扫描失败：' + res.error; return; }
    renderPanel(key);
  });
  $('#code-map')?.addEventListener('click', async () => {
    const b = $('#code-map') as HTMLButtonElement; b.disabled = true; b.textContent = '生成中…';
    msg.textContent = '正在调用 AI 并校验代码摘录与行号…';
    const res = await api.codeMap(key);
    if (!res.ok) { b.disabled = false; b.textContent = '建立映射'; msg.textContent = '未保存：' + res.error; return; }
    renderPanel(key);
  });
  body.querySelectorAll('[data-code-save]').forEach((el) => el.addEventListener('click', async () => {
    const id = (el as HTMLElement).dataset.codeSave!;
    const note = (document.querySelector(`[data-code-note="${CSS.escape(id)}"]`) as HTMLInputElement)?.value ?? '';
    await api.codeConfirm(key, id, note);
    renderPanel(key);
  }));
}

async function renderBaselines(key: string): Promise<void> {
  const el = document.getElementById('panel-baselines');
  if (!el) return;
  const r = await api.getBaselines(key);
  const matched: any[] = r.matched ?? [];
  const cards: any[] = r.cards ?? [];
  el.innerHTML = `
    <h3 style="margin-top:14px">对比基线 · 领域方法参考</h3>
    <p class="sub">卡片是领域常识（非本论文抽取结果）；不确定字段标「待核对」，不补造。</p>
    ${cards.map((c: any) => `<details class="card flush" style="margin-bottom:8px">
      <summary style="cursor:pointer;font-weight:700">${inlineHTML(c.name)} <span class="pill ${c.kind === '解析重建' || c.kind === '迭代重建' ? 'teal' : 'accent'}" style="height:22px">${inlineHTML(c.kind)}</span><span class="sub" style="margin-left:6px">${c.source === '待核对' ? '待核对' : '领域常识'}</span></summary>
      <div style="margin-top:8px">
        <div class="sub" style="margin:0">论文来源：${inlineHTML(c.origin ?? '待核对')}</div>
        <div class="sub" style="margin:0">输入输出：${inlineHTML(c.inputOutput)}</div>
        <div class="sub" style="margin:0">适用设置：${inlineHTML(c.applicableSettings)}</div>
        ${c.knownLimitations ? `<div class="sub" style="margin:0">已知局限：${inlineHTML(c.knownLimitations)}</div>` : ''}
        ${matched.some((m: any) => m.id === c.id) ? `<div class="sub" style="margin:4px 0 0;color:var(--gold)">${inlineHTML(matched.find((m: any) => m.id === c.id).relation)}</div>` : ''}
      </div>
    </details>`).join('')}`;
}


/** 迁移到我的研究（ApplicationPanel）：四类建议 + 原文依据 + 转为 Idea。 */
async function renderApplication(key: string, application: any | null): Promise<void> {
  const out = document.getElementById('apply-out');
  if (!out) return;
  if (!application) {
    const cached = await api.getApplication(key);
    if (cached.ok) application = cached.application;
  }
  if (!application) {
    out.innerHTML = '<p class="sub">还没有迁移建议。点「迁移到我的研究」生成（需已配置 AI 与全文缓存）。</p>';
    return;
  }
  const groups: Array<[string, string, any[]]> = [
    ['reusable', '可直接复用 · 仍需确认前提', application.reusable],
    ['adaptation', '需要适配', application.adaptation],
    ['conflicts', '存在冲突 / 潜在冲突', application.conflicts],
    ['validation', '需要验证', application.validation],
  ];
  out.innerHTML = groups.map(([, label, items]) => `<h3>${label}</h3>
    ${(items ?? []).map((it: any) => `<div class="card flush" style="margin-bottom:8px">
      <div style="font-weight:700">${inlineHTML(it.title)}</div>
      <div>${inlineHTML(it.suggestion)}</div>
      <div class="sub" style="margin:0">研究约束：${inlineHTML(it.constraint)}</div>
      <div class="sub" style="margin:0">验证实验：${inlineHTML(it.verification)}</div>
      ${(it.evidence ?? []).map((e: any) => `<div class="sub" style="margin:0">依据${e.page ? ` (Page ${inlineHTML(String(e.page))})` : ''}：${inlineHTML(e.excerpt ?? e.v ?? '')}</div>`).join('')}
      <div class="row" style="margin:6px 0 0"><button class="small" data-mk-idea="${inlineHTML(encodeURIComponent(it.title))}|${inlineHTML(encodeURIComponent(it.suggestion))}">转为 Idea / 实验计划</button></div>
    </div>`).join('') || '<div class="sub">（无）</div>'}`).join('');
  out.querySelectorAll('[data-mk-idea]').forEach((el) => el.addEventListener('click', async () => {
    const [title, suggestion] = (el as HTMLElement).dataset.mkIdea!.split('|').map(decodeURIComponent);
    await api.saveIdea({ question: title, observation: suggestion, status: 'Planned', evidence: [] });
    alert('已转为待实验 Idea');
  }));
}

/** 事实行：键 + 值 + 可点击 Page 芯片 + 可折叠原文摘录。 */
function rpFact(k: string, v: string, page: unknown, excerpt: unknown): string {
  const chip = page != null ? `<div class="rp-ev"><span class="rp-chip ev" data-page="${inlineHTML(String(page))}">Page ${inlineHTML(String(page))}</span></div>` : '';
  const quote = excerpt ? `<details class="rp-quote"><summary>原文摘录</summary><blockquote>「${inlineHTML(String(excerpt))}」</blockquote></details>` : '';
  return `<div class="rp-fact"><span class="rp-k">${inlineHTML(k)}</span><span class="rp-v"> ${inlineHTML(v)}</span>${chip}${quote}</div>`;
}

function rpGroup(label: string, inner: string): string {
  return `<section class="rp-group"><h3>${inlineHTML(label)}</h3>${inner || '<div class="sub" style="margin:0">（无）</div>'}</section>`;
}

function renderReading(panel: string, value: string): string {
  if (panel === 'experiment') {
    try {
      const ex = JSON.parse(value.replace(/^```[a-z]*\n?|```$/g, ''));
      const groups: Array<[string, string, any[]]> = [['dataset', '数据集', ex.dataset], ['acquisition', '采集与几何', ex.acquisition], ['training', '训练', ex.training], ['loss', '损失', ex.loss], ['baselines', '对比基线', ex.baselines ?? []], ['metrics', '指标', ex.metrics], ['results', '结果', ex.results]];
      return groups.map(([, label, items]) => rpGroup(label, (items ?? []).map((f: any) => rpFact(f.k, f.v, f.page, f.excerpt)).join(''))).join('');
    } catch { return `<pre class="math-block">${inlineHTML(value)}</pre>`; }
  }
  if (panel === 'results') {
    try {
      const ra = JSON.parse(value.replace(/^```[a-z]*\n?|```$/g, ''));
      const tbl = (ra.tables ?? []).map((t: any) => `<h3>${inlineHTML(t.caption?.v ?? t.id)}</h3>
        <div class="table-wrap"><table><thead><tr><th>方法</th>${(t.columns ?? []).map((c: any) => `<th>${inlineHTML(c.label)}${c.unit && c.unit !== '论文未说明' ? `<br><span class="sub">${inlineHTML(c.unit)}</span>` : ''}</th>`).join('')}</tr></thead>
        <tbody>${(t.rows ?? []).map((row: any) => `<tr><th>${inlineHTML(row.method)}</th>${(t.columns ?? []).map((c: any) => { const cell = (row.cells ?? []).find((x: any) => x.columnID === c.id); return `<td>${inlineHTML(cell?.valueText ?? '—')}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`).join('');
      const disc = (d: any) => `<div class="rp-fact">${inlineHTML(d.interpretation)}${d.evidence?.page != null ? `<div class="rp-ev"><span class="rp-chip ev" data-page="${inlineHTML(String(d.evidence.page))}">Page ${inlineHTML(String(d.evidence.page))}</span></div>` : ''}${d.evidence?.excerpt ? `<details class="rp-quote"><summary>原文摘录</summary><blockquote>「${inlineHTML(String(d.evidence.excerpt))}」</blockquote></details>` : ''}</div>`;
      const groups: Array<[string, any[]]> = [['稳定性 / 多数据集', ra.stability], ['消融', ra.ablation], ['泛化', ra.generalization], ['效率', ra.efficiency]];
      return tbl + groups.map(([label, items]) => rpGroup(label, (items ?? []).map(disc).join(''))).join('')
        + ((ra.missing ?? []).length ? rpGroup('待核对', ra.missing.map((m: string) => `<div class="rp-fact">${inlineHTML(m)}</div>`).join('')) : '');
    } catch { return `<pre class="math-block">${inlineHTML(value)}</pre>`; }
  }
  return renderMarkdown(value);
}


function wireReader(key: string): void {
  destroyPdfViewer();
  $('#btn-back')?.addEventListener('click', () => { currentKey = null; (window as any).__stepInit = false; setMode('library'); });
  $('#btn-fav')?.addEventListener('click', async () => {
    const it = library.find((x) => x.key === key);
    const r0 = await api.setLibraryState(key, { favorite: !it?.state.favorite });
    checkSaved(r0, '收藏状态保存失败');
    const r = await reloadLibrary(); void r; renderReader();
  });
  document.querySelectorAll('[data-gostep]').forEach((el) => el.addEventListener('click', () => goStep(Number((el as HTMLElement).dataset.gostep))));
  $('#btn-pdf')?.addEventListener('click', async () => { const r = await api.openPDF(key); if (!r.ok) alert(r.error); });
  $('#btn-mode-text')?.addEventListener('click', () => { (window as any).__readerTextMode = 'text'; renderReader(); });
  $('#btn-mode-pdf')?.addEventListener('click', () => { (window as any).__readerTextMode = 'pdf'; renderReader(); });
  if ((window as any).__readerTextMode === 'pdf' && document.getElementById('pdf-view')) void initPdfViewer(key);

  // AI 助教浮窗（第②步）：右上角小图标，点击后以对话形式弹出；开关状态跨重渲染保持
  const fab = $('#fab-ai');
  const dock = $('#ai-dock') as HTMLElement | null;
  const setDock = (open: boolean): void => {
    (window as any).__aiDockOpen = open;
    if (dock) dock.hidden = !open;
    if (fab) fab.style.display = open ? 'none' : '';
    if (open) restoreChatIntoDock();
  };
  fab?.addEventListener('click', () => setDock(true));
  $('#dock-close')?.addEventListener('click', () => setDock(false));
  if ((window as any).__aiDockOpen && dock) setDock(true);
  $('#btn-auto-import')?.addEventListener('click', async () => {
    const b = $('#btn-auto-import') as HTMLButtonElement; b.textContent = '下载并抽取中…'; b.disabled = true;
    const r = await api.importPaper(key);
    if (!r.ok) { b.textContent = '下载并导入全文'; b.disabled = false; alert('导入失败：' + r.error); return; }
    await reloadLibrary(); renderReader();
  });
  $('#btn-tour')?.addEventListener('click', () => askText('请开始：帮我建立这篇论文的问题感。', 'problem'));
  $('#btn-critique')?.addEventListener('click', () => askText('请先挑三个针对这篇论文实验可信度的尖锐质疑。', 'critique'));
  $('#btn-ask')?.addEventListener('click', () => askFromInput());
  $('#q')?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askFromInput(); } });
  const doubt = $('#doubt') as HTMLTextAreaElement | null;
  if (doubt) { let t: number | undefined; doubt.addEventListener('input', () => { window.clearTimeout(t); t = window.setTimeout(() => saveReflectionField(key, 'doubt', doubt.value), 500); }); }
  document.querySelectorAll('[data-q]').forEach((el) => { let t: number | undefined; el.addEventListener('input', () => { window.clearTimeout(t); t = window.setTimeout(() => saveReflectionField(key, 'q' + (el as HTMLElement).dataset.q, (el as HTMLTextAreaElement).value), 500); }); });
  const fn = $('#free-note') as HTMLTextAreaElement | null;
  if (fn) { let t: number | undefined; fn.addEventListener('input', () => { window.clearTimeout(t); t = window.setTimeout(() => api.saveProgress(key, { freeNote: fn.value }), 500); }); }
  $('#btn-finish')?.addEventListener('click', async () => {
    await api.saveProgress(key, { doneAt: new Date().toISOString() });
    await api.setLibraryState(key, { status: 'read' });
    alert('已完成今天的精读，连续阅读已更新。'); setMode('today');
  });
  $('#btn-goto-repro')?.addEventListener('click', () => { reproKey = key; setMode('reproduction'); });
  $('#btn-apply')?.addEventListener('click', async () => {
    const out = $('#apply-out'); if (!out) return;
    out.innerHTML = '<p class="sub">正在生成迁移建议并校验原文依据…</p>';
    const r = await api.generateReading(key, 'apply', false);
    if (!r.ok) { out.innerHTML = `<div class="warn">未生成：${inlineHTML(r.error)}</div>`; return; }
    renderApplication(key, r.value);
  });
  document.querySelectorAll('[data-panel]').forEach((el) => el.addEventListener('click', () => { (window as any).__readerPanel = (el as HTMLElement).dataset.panel; renderReader(); }));
  if (currentStep === 2) void renderPanel(key);
  if (currentStep === 4) void renderApplication(key, null);
  document.querySelectorAll('.text-pane .ev, #chat .ev, .pane .ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
  const pane = $('#text-pane');
  if (pane) {
    const used = new Set<string>();
    pane.querySelectorAll('.md-h').forEach((h) => { const n = pageAnchorNumber(h.textContent ?? ''); if (n && !used.has(n)) { used.add(n); h.id = `page-${n}`; } });
  }
}

/** 挂载内置 PDF 阅读器（第②步「PDF 原版」模式）。视图被切换/重建时自动放弃过期实例。 */
async function initPdfViewer(key: string): Promise<void> {
  const host = document.getElementById('pdf-view');
  if (!host) return;
  const bytes = await api.pdfBytes(key);
  if (document.getElementById('pdf-view') !== host) return;   // 等待期间视图已重建
  if (!bytes) {
    host.innerHTML = '<div class="warn" style="margin:6px 0">本地没有找到该论文的 PDF 文件（可能只有文本层缓存）。可切回「文本层」，或用顶部「⋯ → 导入论文 PDF」添加原文件。</div>';
    return;
  }
  try {
    const viewer = await PdfViewer.open(host, new Uint8Array(bytes), {
      onPageChange: (p, total) => { const el = document.getElementById('pdfv-pos'); if (el) el.textContent = `页 ${p} / ${total}`; },
      onZoomChange: (label) => { const el = document.getElementById('pdfv-zoom'); if (el) el.textContent = label; },
    });
    if (!document.body.contains(host)) { viewer.destroy(); return; }
    pdfViewer = viewer;
    $('#pdfv-out')?.addEventListener('click', () => viewer.zoomBy(1 / 1.25));
    $('#pdfv-in')?.addEventListener('click', () => viewer.zoomBy(1.25));
    $('#pdfv-fit')?.addEventListener('click', () => viewer.zoomFit());
    const jump = (): void => { const v = Number(($('#pdfv-jump') as HTMLInputElement)?.value); if (v >= 1) void viewer.jumpToPage(v); };
    $('#pdfv-go')?.addEventListener('click', jump);
    ($('#pdfv-jump') as HTMLInputElement)?.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); });
  } catch (e) {
    if (document.body.contains(host)) {
      host.innerHTML = `<div class="warn" style="margin:6px 0">PDF 加载失败：${inlineHTML(e instanceof Error ? e.message : String(e))}</div>`;
    }
  }
}

let _progressCache: any = null;
function progressRefs(): Record<string, string> { return { ...(_progressCache ?? {}) }; }

/**
 * 更新单个反思字段并写回磁盘。
 * 必须**先并入本地缓存再发送**：否则连续编辑两个输入框时，第二次会用未更新的旧缓存
 * 覆盖掉第一次的编辑（静默丢数据）。
 */
function saveReflectionField(key: string, field: string, value: string): void {
  const next = { ...(_progressCache ?? {}) };
  next[field] = value;
  _progressCache = next;
  void api.saveProgress(key, { reflections: next }).then((r: any) => checkSaved(r, '反思/批注保存失败'));
}

async function goStep(n: number): Promise<void> {
  currentStep = n; (window as any).__stepInit = false;
  const prog = (await api.getProgress(currentKey!)) ?? {};
  _progressCache = { ...(prog.reflections ?? {}) };
  // startedAt 是 progress 顶层字段，不在 reflections 里：旧实现从 _progressCache 取，
  // 恒为 undefined，导致每次切步都把开始时间刷成 now。
  const r = await api.saveProgress(currentKey!, { step: n, startedAt: prog.startedAt ?? new Date().toISOString() });
  checkSaved(r, '进度保存失败');
  renderReader();
}

function onEvidenceClick(e: Event): void {
  const page = (e.currentTarget as HTMLElement).dataset.page;
  if (!page) return;
  // PDF 原版模式：直接跳到内置阅读器的对应页（含描边提示）
  if (pdfViewer) { void pdfViewer.jumpToPage(Number(page)); return; }
  const target = document.getElementById(`page-${page}`);
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  else {
    const box = document.getElementById('chat') ?? document.getElementById('main');
    if (box) { const tip = document.createElement('div'); tip.className = 'warn'; tip.textContent = `当前全文缓存里没有 Page ${page}（可能本次材料为子集，或页码超出范围）。点「全文」范围重试，或对照 PDF 核对。`; box.appendChild(tip); }
  }
}

function appendChat(role: string, text: string): void {
  const box = $('#chat'); if (!box) return;
  const div = document.createElement('div');
  div.className = role === 'ai' ? 'msg ai' : 'msg user';
  div.innerHTML = role === 'ai' ? renderMarkdown(text) : `<p>${inlineHTML(text)}</p>`;
  box.appendChild(div);
  box.querySelectorAll('.ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
  box.scrollTop = box.scrollHeight;
}

/** 浮窗打开时回填已有对话：视图重建会清空 #chat，但 chatHistory 是模块级的。 */
function restoreChatIntoDock(): void {
  const box = $('#chat');
  if (!box || box.children.length || !chatHistory.length) return;
  for (const m of chatHistory) appendChat(m.role, m.text);
}

function askFromInput(): void {
  const q = ($('#q') as HTMLTextAreaElement)?.value.trim();
  if (!q) return;
  ($('#q') as HTMLTextAreaElement).value = '';
  void askText(q, ($('#mode') as HTMLSelectElement)?.value ?? 'chat');
}

// 同一时间只允许一问：并发时两条流的 delta 会互相串写气泡、history 乱序。
let askBusy = false;

async function askText(q: string, mode: string): Promise<void> {
  if (askBusy) return;
  askBusy = true;
  const btn = $('#btn-ask') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const key = currentKey!;
  const scope = ($('#scope') as HTMLSelectElement)?.value ?? '全文';
  const box = $('#chat')!;
  const div = document.createElement('div'); div.className = 'msg ai'; div.textContent = '…'; box.appendChild(div);
  // off 必须进 finally：api.ask reject 时否则监听器泄漏（preload 的 onDelta 是全局 IPC 订阅），
  // 且 '…' 占位永久残留。
  let off: (() => void) | null = null;
  try {
    appendChat('user', q);
    const prep = await api.prepareAI(key, q, scope);
    if (!prep.ok) { div.className = 'msg warn'; div.textContent = `⚠️ ${prep.error}`; return; }
    if (prep.included < prep.total) appendChat('ai', `（材料范围：本次只取全文中 ${prep.included}/${prep.total} 页，未覆盖的结论请扩大范围重试。）`);
    let acc = '';
    off = api.onDelta((delta: string) => { acc += delta; div.innerHTML = renderMarkdown(acc); });
    const res = await api.ask({ key, mode, question: q, scope, pdfText: prep.material, history: chatHistory.slice(-8) });
    if (res.ok) { div.innerHTML = renderMarkdown(res.text); chatHistory.push({ role: 'user', text: q }, { role: 'ai', text: res.text }); }
    else { div.className = 'msg warn'; div.textContent = '⚠️ ' + res.error; }
  } catch (err) {
    div.className = 'msg warn';
    div.textContent = '⚠️ ' + (err instanceof Error ? err.message : String(err));
  } finally {
    off?.();
    askBusy = false;
    if (btn) btn.disabled = false;
    div.querySelectorAll('.ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
    box.scrollTop = box.scrollHeight;
  }
}

// ---------- 路由与外壳 ----------
async function reloadLibrary(): Promise<LibItem[]> {
  library = await api.listLibrary();
  (window as any).__cmpSelected = cmpSelected;
  return library;
}

function setMode(m: Mode): void {
  destroyPdfViewer();
  currentMode = m; currentKey = null; (window as any).__stepInit = false;
  document.querySelectorAll('.nav-tabs .cap').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.mode === m));
  void route();
}

/** 首屏 boot 不走 setMode，导航激活态需单独同步一次。 */
function syncNavActive(): void {
  document.querySelectorAll('.nav-tabs .cap').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.mode === currentMode));
}

async function route(): Promise<void> {
  if (currentKey) return;
  if (currentMode === 'today') await renderToday();
  else if (currentMode === 'library') await renderLibrary();
  else if (currentMode === 'profile') await renderProfile();
  else if (currentMode === 'topics' || currentMode === 'map') { await reloadLibrary(); await renderTopics(); }
  else if (currentMode === 'compare') await renderCompare();
  else if (currentMode === 'trend') await renderTrend();
  else if (currentMode === 'ideas') await renderIdeas();
  else if (currentMode === 'reproduction') await renderReproduction();
  else await renderSettings();
}

function wireCommon(): void {
  document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openReader((el as HTMLElement).dataset.open!)));
  document.querySelectorAll('[data-later]').forEach((el) => el.addEventListener('click', async () => { await api.setLibraryState((el as HTMLElement).dataset.later!, { status: 'later' }); alert('已加入稍后读'); }));
  document.querySelectorAll('[data-import]').forEach((el) => el.addEventListener('click', async () => { const b = el as HTMLButtonElement; b.textContent = '导入中…'; b.disabled = true; const r = await api.importPaper((el as HTMLElement).dataset.import!); if (r.ok) { b.textContent = `已导入（${r.pages} 页）`; await reloadLibrary(); } else { b.textContent = '下载并导入'; b.disabled = false; alert('导入失败：' + r.error); } }));
  document.querySelectorAll('[data-step]').forEach((el) => el.addEventListener('click', () => { const d = (window as any).__todayKey; if (d) openReader(d, Number((el as HTMLElement).dataset.step)); }));
  document.querySelectorAll('[data-topic]').forEach((el) => el.addEventListener('click', () => { workspaceTopic = (el as HTMLElement).dataset.topic!; workspaceSearch = ''; (window as any).__gotoLib = (el as HTMLElement).dataset.gotoLib === '1'; setMode('library'); }));
  document.querySelectorAll('[data-nav]').forEach((el) => el.addEventListener('click', () => setMode((el as HTMLElement).dataset.nav as Mode)));
  document.querySelectorAll('[data-note-file]').forEach((el) => el.addEventListener('click', () => api.openNoteFile((el as HTMLElement).dataset.noteFile!)));
}

async function boot(): Promise<void> {
  api.onWriteError?.((msg: string) => notifySaveError(msg));
  document.querySelectorAll('.nav-tabs .cap').forEach((el) => el.addEventListener('click', () => setMode((el as HTMLElement).dataset.mode as Mode)));
  syncNavActive();
  $('#brand')?.addEventListener('click', () => setMode('today'));
  const search = $('#search') as HTMLInputElement;
  search?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { workspaceSearch = search.value; workspaceTopic = null; setMode('library'); } });
  $('#btn-profile')?.addEventListener('click', () => setMode('profile'));
  $('#btn-more')?.addEventListener('click', toggleMoreMenu);
  await reloadLibrary();
  await route();
}

function toggleMoreMenu(): void {
  const existing = document.getElementById('more-menu');
  if (existing) { existing.remove(); return; }
  const el = document.createElement('div');
  el.id = 'more-menu'; el.className = 'menu-pop';
  el.innerHTML = `
    <button data-nav="compare">论文对比</button>
    <button data-nav="topics">知识地图</button>
    <button data-nav="trend">趋势与缺口</button>
    <hr>
    <button id="mm-import">导入论文 PDF</button>
    <button id="mm-export">导出研究资产</button>
    <button data-nav="settings">AI 助教设置</button>`;
  document.body.appendChild(el);
  el.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => { el.remove(); setMode((b as HTMLElement).dataset.nav as Mode); }));
  $('#mm-import')?.addEventListener('click', async () => { el.remove(); const r = await api.importPDF(); if (r.ok) { alert('已导入：' + r.name); reloadLibrary(); } });
  $('#mm-export')?.addEventListener('click', async () => { el.remove(); const r = await api.exportResearch(); alert(r.ok ? '已导出研究资产到 ' + r.path : (r.canceled ? '已取消' : '导出失败：' + r.error)); });
  setTimeout(() => document.addEventListener('click', function h(ev) { if (!el.contains(ev.target as Node) && ev.target !== $('#btn-more')) { el.remove(); document.removeEventListener('click', h); } }), 0);
}

void boot();

// 测试/诊断用：允许外部驱动页面切换（只读驱动，不改变业务逻辑）。
(window as any).__zcode = {
  setMode, openReader: (k: string, s = 1) => openReader(k, s), getMode: () => currentMode,
  renderMarkdown, mathBlockHTML,
};

