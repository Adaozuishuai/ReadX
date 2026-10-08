// 渲染进程入口。复用 src/core 的解析器（同一份实现，不另写一套 JS 渲染逻辑）。
import { parseMarkdown, MDBlock, inlineHTML, inlineHTMLWithEvidence, pageAnchorNumber } from '../core/markdown';
import { plainText, MarkdownTable } from '../core/markdownTable';
import { Typography } from '../core/typography';
import { linked } from '../core/evidence';

declare const window: any;
const api = window.cbct;

interface LibItem {
  key: string; paper: any; state: any; score: number;
  reasons: string[]; matchesProfile: boolean; hasPDF: boolean; hasText: boolean;
}

let library: LibItem[] = [];
let currentKey: string | null = null;
let currentMode: 'library' | 'today' | 'compare' | 'settings' | 'trend' | 'ideas' | 'reproduction' = 'today';
let chatHistory: Array<{ role: string; text: string }> = [];

const $ = (sel: string): HTMLElement => document.querySelector(sel) as HTMLElement;

// ---------- Markdown 渲染（表格/公式/标题） ----------

function renderTable(t: MarkdownTable): string {
  const align = (a: string): string => (a === 'center' ? 'center' : a === 'trailing' ? 'right' : 'left');
  const head = t.header.map((h, i) => `<th style="text-align:${align(t.alignments[i])}">${inlineHTML(h)}</th>`).join('');
  const body = t.rows.map((r) =>
    '<tr>' + r.map((c, i) => `<td style="text-align:${align(t.alignments[i])}">${inlineHTMLWithEvidence(c)}</td>`).join('') + '</tr>',
  ).join('');
  // 超宽横向滚动、超高内部纵向滚动并固定表头（与 macOS 版同一策略）
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
        return `<p>${b.lines.map((l) => inlineHTMLWithEvidence(l)).join('<br>')}</p>`;
      case 'quote':
        return `<blockquote>${b.lines.map((l) => inlineHTMLWithEvidence(l)).join('<br>')}</blockquote>`;
      case 'bullets':
        return `<ul>${b.items.map((i) => `<li>${inlineHTMLWithEvidence(i)}</li>`).join('')}</ul>`;
      case 'ordered':
        return `<ol>${b.items.map((i) => `<li>${inlineHTMLWithEvidence(i)}</li>`).join('')}</ol>`;
      case 'table':
        return renderTable(b.table);
      case 'rule':
        return '<hr>';
      case 'mathBlock':
        // 不做 LaTeX 排版：转义后按源码展示，并明确标注需核对原 PDF
        return `<pre class="math-block">${inlineHTML(b.latex)}</pre>`;
    }
  }).join('');
}

function renderMarkdown(src: string): string {
  return renderBlocks(parseMarkdown(src));
}

// ---------- 视图 ----------

function statusLabel(s: string): string {
  return ({ unread: '未读', later: '稍后读', reading: '精读中', read: '已读', ignored: '忽略', deleted: '已删除' } as Record<string, string>)[s] ?? s;
}

async function renderToday(): Promise<void> {
  const discovery = await api.getDiscovery();
  const errors: string[] = discovery.errors ?? [];
  const legacyPreprints = (discovery.papers ?? []).filter((p: any) => (p.source ?? '').toLowerCase().includes('arxiv'));
  const venuePriority = (paper: any): number => {
    const source = paper.source ?? '';
    if (['MICCAI', 'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'ICLR', 'AAAI'].includes(source)) return 0;
    if (['ISBI', 'SPIE Medical Imaging'].includes(source)) return 1;
    if (['TMI', 'MIA'].includes(source)) return 2;
    return source.toLowerCase() === 'pubmed' ? 3 : 2;
  };
  const formalPapers = (discovery.papers ?? [])
    .filter((p: any) => !(p.source ?? '').toLowerCase().includes('arxiv'))
    .sort((a: any, b: any) => venuePriority(a) - venuePriority(b));
  const allPreprints = [...(discovery.preprints ?? []), ...legacyPreprints];
  const papers = formalPapers.slice(0, 12);
  const preprints = allPreprints.slice(0, 12);
  const day = new Date().toISOString().slice(0, 10);
  const todayNew = [...(discovery.papers ?? []), ...(discovery.preprints ?? [])].filter((p: any) => discovery.firstSeen?.[p.arxiv ?? p.id] === day);

  $('#main').innerHTML = `
    <h1>今日论文</h1>
    <p class="sub">正式期刊/会议 ${formalPapers.length} 篇 · 预印本 ${allPreprints.length} 篇 · 今日首次发现 ${todayNew.length} 篇 · 抓取于 ${discovery.fetchedAt || '尚未抓取'}</p>
    ${errors.length ? `<div class="warn">${errors.map((e) => inlineHTML(e)).join('<br>')}</div>` : ''}
    <div class="row"><button id="btn-refresh">刷新论文源</button></div>
    <div class="grid">
      ${papers.map((p: any) => {
        const key = p.arxiv ?? p.id ?? '';
        const abstract = (p.abstract ?? '').slice(0, 260);
        return `<article class="card">
          <h3>${inlineHTML(p.title ?? '（无标题）')}</h3>
          <p class="meta">${inlineHTML((p.authors ?? []).slice(0, 3).join(', '))} · ${inlineHTML(p.venue ?? '')} · ${inlineHTML(p.source ?? '')}</p>
          <p>${inlineHTML(abstract)}</p>
          <div class="row">
            <button data-open="${inlineHTML(key)}">精读</button>
            <button class="ghost" data-later="${inlineHTML(key)}">稍后读</button>
          </div>
        </article>`;
      }).join('') || '<p class="sub">还没有发现结果，点「刷新论文源」抓取。</p>'}
    </div>`;
  if (preprints.length) {
    $('#main').insertAdjacentHTML('beforeend', `
      <h2>预印本 · 单独浏览（尚未经过正式评审）</h2>
      <div class="grid">${preprints.map((p: any) => {
        const key = p.arxiv ?? p.id ?? '';
        const abstract = (p.abstract ?? '').slice(0, 260);
        return `<article class="card">
          <h3>${inlineHTML(p.title ?? '（无标题）')}</h3>
          <p class="meta">${inlineHTML((p.authors ?? []).slice(0, 3).join(', '))} · ${inlineHTML(p.venue ?? 'arXiv')} · 预印本</p>
          <p>${inlineHTML(abstract)}</p>
          <div class="row"><button data-open="${inlineHTML(key)}">精读</button><button class="ghost" data-later="${inlineHTML(key)}">稍后读</button></div>
        </article>`;
      }).join('')}</div>`);
  }

  $('#btn-refresh')?.addEventListener('click', async () => {
    $('#btn-refresh').textContent = '抓取中…';
    try { await api.refreshDiscovery(); await renderToday(); }
    catch (e) { alert('抓取失败：' + (e as Error).message); $('#btn-refresh')!.textContent = '刷新论文源'; }
  });

  document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => {
    openReader((el as HTMLElement).dataset.open!);
  }));
  document.querySelectorAll('[data-later]').forEach((el) => el.addEventListener('click', async () => {
    await api.setLibraryState((el as HTMLElement).dataset.later!, { status: 'later' });
    alert('已加入稍后读');
  }));
}

function renderLibrary(): void {
  const q = ($('#search') as HTMLInputElement)?.value?.toLowerCase() ?? '';
  const items = library.filter((it) => {
    if (!q) return true;
    return ((it.paper.title ?? '') + ' ' + (it.paper.abstract ?? '')).toLowerCase().includes(q);
  });
  $('#main').innerHTML = `
    <h1>论文库</h1>
    <p class="sub">共 ${library.length} 篇 · 显示 ${items.length} 篇</p>
    <div class="grid">
      ${items.map((it) => `
        <article class="card">
          <div class="row between">
            <h3>${inlineHTML(it.paper.title ?? it.key)}</h3>
            <span class="badge">${statusLabel(it.state.status)}</span>
          </div>
          <p class="meta">匹配分 ${it.score} · ${it.hasText ? '有全文缓存' : '缺全文缓存'} · ${it.hasPDF ? '有 PDF' : '无 PDF'}</p>
          ${it.reasons.length ? `<ul class="reasons">${it.reasons.map((r) => `<li>${inlineHTML(r)}</li>`).join('')}</ul>` : ''}
          <textarea data-notes="${inlineHTML(it.key)}" placeholder="个人笔记（自动保存）">${inlineHTML(it.state.notes ?? '')}</textarea>
          <div class="row">
            <button data-open="${inlineHTML(it.key)}">精读</button>
            <select data-status="${inlineHTML(it.key)}">
              ${['unread', 'later', 'reading', 'read', 'ignored'].map((s) => `<option value="${s}"${s === it.state.status ? ' selected' : ''}>${statusLabel(s)}</option>`).join('')}
            </select>
            <button class="ghost" data-fav="${inlineHTML(it.key)}">${it.state.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
            ${it.hasText ? `<button class="ghost" data-repro="${inlineHTML(it.key)}">复现准备</button>` : ''}
          </div>
        </article>`).join('') || '<p class="sub">论文库为空。可以从「今日论文」精读后入库。</p>'}
    </div>`;

  document.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => openReader((el as HTMLElement).dataset.open!)));
  document.querySelectorAll('[data-status]').forEach((el) => el.addEventListener('change', async () => {
    const key = (el as HTMLElement).dataset.status!;
    await api.setLibraryState(key, { status: (el as HTMLSelectElement).value });
    await reloadLibrary(); renderLibrary();
  }));
  document.querySelectorAll('[data-fav]').forEach((el) => el.addEventListener('click', async () => {
    const key = (el as HTMLElement).dataset.fav!;
    const it = library.find((x) => x.key === key)!;
    await api.setLibraryState(key, { favorite: !it.state.favorite });
    await reloadLibrary(); renderLibrary();
  }));
  document.querySelectorAll('[data-repro]').forEach((el) => el.addEventListener('click', () => {
    reproKey = (el as HTMLElement).dataset.repro!;
    currentMode = 'reproduction';
    void route();
  }));
  // 笔记自动保存
  document.querySelectorAll('[data-notes]').forEach((el) => {
    let timer: number | undefined;
    el.addEventListener('input', () => {
      const key = (el as HTMLElement).dataset.notes!;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => api.setLibraryState(key, { notes: (el as HTMLTextAreaElement).value }), 500);
    });
  });
}

async function renderCompare(): Promise<void> {
  const session = await api.getCompare();
  const sel: string[] = session.selected ?? [];
  const pinned: string | null = session.pinned ?? null;
  const order: string[] = session.order ?? sel;
  const chosen = order.map((k) => library.find((it) => it.key === k)).filter(Boolean);

  // 字段来自笔记 frontmatter 与已抽取实验字段（论文级事实），不是库状态。
  const fields: any[] = chosen.length ? await api.compareFields(chosen.map((c: any) => c.key)) : [];
  const colOf = (name: string): string[] => fields.map((f) => String(f[name] ?? '尚未抽取'));
  const rows: Array<[string, string[]]> = [
    ['venue', colOf('venue')],
    ['year', colOf('year')],
    ['数据集', colOf('datasets')],
    ['视角数', colOf('views')],
    ['几何', colOf('geometry')],
  ];
  // 只有「两个以上不同的已知值」才警示；未知值不参与判断，避免误报
  const warns: string[] = await api.compareWarnings(
    rows.filter(([l]) => ['视角数', '几何', '数据集'].includes(l)) as Array<[string, string[]]>,
  );

  $('#main').innerHTML = `
    <h1>论文对比</h1>
    <p class="sub">已选 ${sel.length} 篇（2–8 篇）${pinned ? ` · 已固定：${inlineHTML(pinned)}` : ''}</p>
    <div class="grid">
      ${library.map((it) => `<label class="card pick"><input type="checkbox" data-pick="${inlineHTML(it.key)}" ${sel.includes(it.key) ? 'checked' : ''}> ${inlineHTML(it.paper.title ?? it.key)}</label>`).join('')}
    </div>
    ${warns.length ? `<div class="warn">${warns.map((w) => inlineHTML(w)).join('<br>')}</div>` : ''}
    ${chosen.length >= 2 ? `
      <h2>对比表</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>字段</th>${chosen.map((c: any) => `<th>
          <span>${inlineHTML(c.paper.title ?? c.key)}</span>
          <button class="ghost pin" data-pin="${inlineHTML(c.key)}" title="固定该列到最前">${pinned === c.key ? '★ 已固定' : '☆ 固定'}</button>
        </th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(([label, values]) => `<tr><th>${inlineHTML(label)}</th>${values.map((v) => `<td>${inlineHTML(v)}</td>`).join('')}</tr>`).join('')}
          <tr><th>状态</th>${chosen.map((c: any) => `<td>${statusLabel(c.state.status)}</td>`).join('')}</tr>
        </tbody>
      </table></div>
      <p class="sub">不同实验协议的指标不能直接排名；未知字段显示「尚未抽取」，不补造数值。</p>
      <div class="row">
        <button id="cite-bib">导出 BibTeX</button>
        <button id="cite-ris" class="ghost">导出 RIS</button>
      </div>
      <p class="sub" id="cite-msg"></p>` : '<p class="sub">至少选 2 篇才能对比。</p>'}`;

  document.querySelectorAll('[data-pick]').forEach((el) => el.addEventListener('change', async () => {
    const key = (el as HTMLElement).dataset.pick!;
    const cur = new Set<string>(sel);
    if ((el as HTMLInputElement).checked) cur.add(key); else cur.delete(key);
    await api.setCompare([...cur], pinned);
    await renderCompare();
  }));

  // 固定列：再点一次取消。固定列会被提到最前，其余保持相对顺序。
  document.querySelectorAll('[data-pin]').forEach((el) => el.addEventListener('click', async () => {
    const key = (el as HTMLElement).dataset.pin!;
    await api.setCompare(sel, pinned === key ? null : key);
    await renderCompare();
  }));

  const exportCite = async (fmt: 'bib' | 'ris'): Promise<void> => {
    const keys = chosen.map((c: any) => c.key);
    if (!keys.length) return;
    const r = await api.citationExport(keys, fmt);
    const msg = $('#cite-msg');
    if (msg) {
      msg.textContent = r.ok ? `已导出 ${keys.length} 篇到 ${r.path}（${r.bytes} 字节）`
        : (r.canceled ? '已取消' : `导出失败：${r.error}`);
    }
  };
  $('#cite-bib')?.addEventListener('click', () => void exportCite('bib'));
  $('#cite-ris')?.addEventListener('click', () => void exportCite('ris'));
}

async function renderSettings(): Promise<void> {
  const cfg = await api.getConfig();
  $('#main').innerHTML = `
    <h1>设置</h1>
    <p class="sub">配置与 macOS 版共用 <code>app/config.json</code>。API Key 只写入本地文件，不会回显到界面。</p>
    <div class="card form">
      <label>API 地址<input id="cfg-base" value="${inlineHTML(cfg.baseURL)}" placeholder="https://api.example.com/v1"></label>
      <label>模型名<input id="cfg-model" value="${inlineHTML(cfg.model)}" placeholder="glm-4.6"></label>
      <label>API Key<input id="cfg-key" type="password" placeholder="${cfg.hasKey ? '已配置（留空表示不修改）' : '在这里填入'}"></label>
      <div class="row"><button id="cfg-save">保存</button><span id="cfg-msg" class="sub"></span></div>
      <p class="sub">配置文件：<code>${inlineHTML(cfg.path)}</code></p>
    </div>`;

  $('#cfg-save')?.addEventListener('click', async () => {
    await api.setConfig({
      baseURL: ($('#cfg-base') as HTMLInputElement).value.trim(),
      model: ($('#cfg-model') as HTMLInputElement).value.trim(),
      apiKey: ($('#cfg-key') as HTMLInputElement).value,
    });
    $('#cfg-msg')!.textContent = '已保存';
  });
}

// ---------- 精读室 ----------

async function openReader(key: string): Promise<void> {
  currentKey = key;
  chatHistory = [];
  const item = library.find((x) => x.key === key);
  const text = await api.getText(key);
  const raw = text.text ?? '';
  const noteRes = await api.getNote(key);
  const note = noteRes?.ok ? noteRes.note : null;
  const SECTION_TITLES: Record<string, string> = {
    summary: '一句话总结', setup: '问题设定', method: '方法核心',
    experiments: '实验可信度', insights: '研究启发', annotations: '我的批注',
  };
  const noteHTML = note ? `
    <section class="pane">
      <div class="row between"><h2>精读笔记</h2><span class="sub">${inlineHTML(note.file)}</span></div>
      ${(note.sections.method ?? '').match(/\\\[|\\\]|\$\$|\\begin\{(?:equation|align)/) ? '<div class="warn">Windows 版暂不提供本地公式 OCR；公式转写请在 macOS 版完成，或打开原 PDF 对照。识别文本未经核对时不要作为准确公式引用。</div>' : ''}
      ${['summary', 'setup', 'method', 'experiments', 'insights', 'annotations']
        .filter((k) => (note.sections[k] ?? '').trim())
        .map((k) => `<h3>${SECTION_TITLES[k]}</h3>${renderMarkdown(note.sections[k])}`)
        .join('')}
    </section>` : '';

  $('#main').innerHTML = `
    <div class="row between">
      <h1>${inlineHTML(item?.paper.title ?? key)}</h1>
      <button class="ghost" id="btn-back">返回</button>
    </div>
    ${text.isOCR ? '<div class="warn">该 PDF 全文来自机器 OCR：摘录校验可能失效，请务必人工核对。</div>' : ''}
    ${note ? '<div class="warn">左侧「精读笔记」来自 <code>papers/</code>，与 macOS 版共用同一份 Markdown；它是研究者的笔记，不是论文原文，事实仍需回原文核对。</div>' : ''}
    <div class="reader">
      <section class="pane">
        <div class="row between"><h2>原文</h2><span class="sub" id="page-hint">共 ${(raw.match(/=== Page/g) ?? []).length} 页</span></div>
        ${item?.hasPDF ? '<div class="row"><button id="btn-pdf">用系统阅读器打开 PDF</button></div>' : '<p class="sub">本地没有该论文 PDF，可先用「导入 PDF」添加。</p>'}
        <div class="text-pane" id="text-pane">${raw ? renderMarkdown(raw.replace(/=== Page (\d+) ===/g, '\n\n## Page $1\n\n')) : '<p class="sub">没有全文缓存。全文缓存由 macOS 版抽取后保存在 library/text/，两边共用同一文件。</p>'}</div>
      </section>
      <section class="pane">
        <h2>AI 助教</h2>
        <div class="row">
          <select id="scope">
            ${['全文', 'Method', 'Experiment', 'Appendix', 'Figure'].map((s) => `<option>${s}</option>`).join('')}
          </select>
          <select id="mode">
            <option value="chat">自由提问</option>
            <option value="problem">建立问题感</option>
            <option value="critique">Critical View</option>
          </select>
        </div>
        <div id="chat" class="chat"></div>
        <div class="row">
          <textarea id="q" placeholder="就这篇论文提问…（Ctrl+Enter 发送）"></textarea>
          <button id="btn-ask">发送</button>
        </div>
        <p class="sub">回答会标注 Page N；点 Page N 可跳转原文。没有全文缓存时不会做事实分析。</p>
      </section>
      ${noteHTML}
    </div>`;

  $('#btn-back')?.addEventListener('click', () => { currentKey = null; void route(); });
  $('#btn-pdf')?.addEventListener('click', async () => {
    const r = await api.openPDF(key);
    if (!r.ok) alert(r.error);
  });
  $('#btn-ask')?.addEventListener('click', () => void ask());
  $('#q')?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void ask(); }
  });
  document.querySelectorAll('.text-pane .ev, #chat .ev, .pane .ev').forEach((el) => el.addEventListener('click', onEvidenceClick));

  // 页面锚点：把渲染出的 Page N 标题变成可跳转目标。
  // 注意标题渲染成的是 .md-h 容器（不是 h2），且其中的 "Page N" 已被证据链接化，
  // 所以要用 textContent 匹配 .md-h，而不是查询 h2 或读 innerHTML。
  if (raw) {
    const pane = $('#text-pane')!;
    const used = new Set<string>();
    pane.querySelectorAll('.md-h').forEach((h) => {
      const n = pageAnchorNumber(h.textContent ?? '');
      if (n && !used.has(n)) { used.add(n); h.id = `page-${n}`; }
    });
  }
}

function onEvidenceClick(e: Event): void {
  const page = (e.currentTarget as HTMLElement).dataset.page;
  if (!page) return;
  const target = document.getElementById(`page-${page}`);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  } else {
    // 用内联提示替代阻塞式 alert：桌面应用里弹窗会打断阅读，且无法复制
    const box = document.getElementById('chat') ?? document.getElementById('main');
    if (box) {
      const tip = document.createElement('div');
      tip.className = 'warn';
      tip.textContent = `当前全文缓存里没有 Page ${page}（可能本次材料为子集，或页码超出范围）。点「全文」范围重试，或对照 PDF 核对。`;
      box.appendChild(tip);
      tip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function appendChat(role: string, text: string): void {
  const box = $('#chat')!;
  const div = document.createElement('div');
  div.className = role === 'ai' ? 'msg ai' : 'msg user';
  div.innerHTML = role === 'ai' ? renderMarkdown(text) : `<p>${inlineHTML(text)}</p>`;
  box.appendChild(div);
  box.querySelectorAll('.ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
  box.scrollTop = box.scrollHeight;
}

async function ask(): Promise<void> {
  const q = ($('#q') as HTMLTextAreaElement).value.trim();
  if (!q || !currentKey) return;
  const scope = ($('#scope') as HTMLSelectElement).value;
  const mode = ($('#mode') as HTMLSelectElement).value;

  appendChat('user', q);
  ($('#q') as HTMLTextAreaElement).value = '';

  // 先准备材料：无原文就不做事实问答（与 macOS 版一致的硬约束）
  const prep = await api.prepareAI(currentKey, q, scope);
  if (!prep.ok) { appendChat('ai', `⚠️ ${prep.error}`); return; }
  if (prep.included < prep.total) {
    appendChat('ai', `（材料范围：本次只取全文中 ${prep.included}/${prep.total} 页，未覆盖的结论请扩大范围重试。）`);
  }

  const box = $('#chat')!;
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.textContent = '…';
  box.appendChild(div);

  let acc = '';
  const off = api.onDelta((delta: string) => {
    acc += delta;
    div.innerHTML = renderMarkdown(acc);
  });

  const history = chatHistory.slice(-8);
  const res = await api.ask({ key: currentKey, mode, question: q, scope, pdfText: prep.material, history });
  off();

  if (res.ok) {
    div.innerHTML = renderMarkdown(res.text);
    chatHistory.push({ role: 'user', text: q }, { role: 'ai', text: res.text });
  } else {
    // 失败的回答不进入历史，避免污染后续上下文
    div.className = 'msg warn';
    div.textContent = '⚠️ ' + res.error;
  }
  div.querySelectorAll('.ev').forEach((el) => el.addEventListener('click', onEvidenceClick));
  box.scrollTop = box.scrollHeight;
}

// ---------- 路由 ----------

async function reloadLibrary(): Promise<void> {
  library = await api.listLibrary();
}

async function route(): Promise<void> {
  if (currentKey) return; // 精读室自管理
  if (currentMode === 'today') await renderToday();
  else if (currentMode === 'library') { await reloadLibrary(); renderLibrary(); }
  else if (currentMode === 'compare') { await reloadLibrary(); await renderCompare(); }
  else if (currentMode === 'trend') { await reloadLibrary(); await renderTrend(); }
  else if (currentMode === 'ideas') { await renderIdeas(); }
  else if (currentMode === 'reproduction') { await reloadLibrary(); await renderReproduction(); }
  else await renderSettings();
}

async function boot(): Promise<void> {
  const info = await api.info();
  $('#root-path')!.textContent = info.root;

  document.querySelectorAll('nav button').forEach((el) => el.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
    el.classList.add('active');
    currentMode = (el as HTMLElement).dataset.mode as typeof currentMode;
    currentKey = null;
    void route();
  }));

  $('#btn-import')?.addEventListener('click', async () => {
    const r = await api.importPDF();
    if (r.ok) alert('已导入：' + r.name);
  });

  await reloadLibrary();
  await route();
}

void boot();

// ---------- 趋势 / Research Gap ----------
// PRD 硬约束：必须同时展示 时间窗口 + 样本数 + 证据集合；
// 样本不足时只报告计数，不输出「升温/新兴」这类趋势判断。

async function renderTrend(): Promise<void> {
  const t = await api.getTrend();
  const smp = t.sample;
  const windowText = smp.windowStart && smp.windowEnd ? `${smp.windowStart} ~ ${smp.windowEnd}` : '时间窗口未知';
  const supported = t.findings.filter((f: any) => f.isSupported);
  const unsupported = t.findings.filter((f: any) => !f.isSupported);

  $('#main').innerHTML = `
    <h1>趋势 / Research Gap</h1>
    <p class="sub">时间窗口 ${inlineHTML(windowText)} · 样本数 ${smp.papers.length} 篇 · 最小样本量 ${t.minimumSample} 篇</p>
    ${smp.papers.length < t.minimumSample
      ? `<div class="warn">当前检索范围只有 ${smp.papers.length} 篇，低于最小样本量 ${t.minimumSample}：<b>不下趋势判断</b>，只报告计数与证据集合。请扩大检索范围后重试。</div>`
      : ''}
    <h2>可下判断（样本 ≥ ${t.minimumSample}）</h2>
    ${supported.length ? supported.map((f: any) => trendCard(f, true)).join('') : '<p class="sub">暂无达到最小样本量的方向。</p>'}
    <h2>仅计数（样本不足，不下判断）</h2>
    ${unsupported.length ? unsupported.map((f: any) => trendCard(f, false)).join('') : '<p class="sub">无。</p>'}
    <h2>缺口表述示例</h2>
    <div class="card"><p>${inlineHTML(t.gapExample)}</p>
      <p class="sub">缺口表述固定为「检索范围内未见」，不构成「首次」声明。</p></div>`;

  document.querySelectorAll('[data-redline]').forEach((el) => el.addEventListener('click', async () => {
    const text = (el as HTMLElement).dataset.redline!;
    const r = await api.checkRedline(text);
    alert(r.violates ? '该表述命中红线（声称首次/无人研究），已拒绝。' : '通过红线自检。');
  }));
}

function trendCard(f: any, isSupported: boolean): string {
  return `<article class="card">
    <div class="row between"><h3>${inlineHTML(f.topic)}</h3><span class="badge">${f.count} 篇</span></div>
    <p>${inlineHTML(f.claim)}</p>
    <p class="sub">${inlineHTML(f.disclosure)}</p>
    <p class="caveat">${inlineHTML(f.caveat)}</p>
    <div class="row">
      <button class="ghost" data-redline="${inlineHTML(f.claim)}">检查表述红线</button>
    </div>
  </article>`;
}

// ---------- 研究想法 (Idea) ----------

async function renderIdeas(): Promise<void> {
  const r = await api.listIdeas();
  const ideas = r.ideas ?? [];
  const statuses = ['Idea', 'Planned', 'Running', 'Rejected', 'Adopted'];
  const labels: Record<string, string> = { Idea: '想法', Planned: '待实验', Running: '实验中', Rejected: '已否定', Adopted: '已采纳' };

  $('#main').innerHTML = `
    <h1>研究想法</h1>
    <p class="sub">共 ${ideas.length} 条 · 存在 <code>app/data/ideas.json</code>，与 macOS 版共用</p>
    ${r.ok ? '' : `<div class="warn">ideas.json 读取失败：${inlineHTML(r.error)}。为避免覆盖你的数据，这里不显示任何条目。</div>`}
    <div class="card form">
      <label>研究问题<textarea id="idea-q" placeholder="要回答什么问题？"></textarea></label>
      <label>观察<textarea id="idea-o" placeholder="观察到什么现象？"></textarea></label>
      <label>假设<textarea id="idea-h" placeholder="你的假设是什么？"></textarea></label>
      <label>方法草图<textarea id="idea-m" placeholder="打算怎么做？"></textarea></label>
      <label>验证实验<textarea id="idea-e" placeholder="怎么验证它？"></textarea></label>
      <fieldset class="evidence-form">
        <legend>关联证据（可选）</legend>
        <label>来源类型
          <select id="idea-ev-origin">
            ${['论文原文', 'AI 解释', '研究建议', '个人笔记'].map((o) => `<option>${o}</option>`).join('')}
          </select>
        </label>
        <label>论文<select id="idea-ev-paper">${library.map((it) => `<option value="${inlineHTML(it.key)}">${inlineHTML(it.paper.title ?? it.key)}</option>`).join('')}</select></label>
        <label>物理页码<input id="idea-ev-page" type="number" min="1" placeholder="仅「论文原文」需要"></label>
        <label>逐字摘录<textarea id="idea-ev-excerpt" placeholder="从该页复制原文；「论文原文」要求 ≥ 8 个非空白字符"></textarea></label>
        <p class="sub">选「论文原文」时会在保存前校验：页码必须存在，且摘录必须能在该页逐字找到。其余来源不需要证据，但会被单独标识。</p>
      </fieldset>
      <div class="row"><button id="idea-add">保存为想法</button><span id="idea-msg" class="sub"></span></div>
      <p class="sub">论文事实类证据必须带页码与逐字摘录；AI 解释与研究建议无需证据，但会被单独标识。</p>
    </div>
    <div class="grid">
      ${ideas.map((it: any) => `<article class="card">
        <div class="row between"><h3>${inlineHTML(it.question || '（未填写问题）')}</h3><span class="badge">${labels[it.status] ?? it.status}</span></div>
        ${it.observation ? `<p><b>观察</b> ${inlineHTML(it.observation)}</p>` : ''}
        ${it.hypothesis ? `<p><b>假设</b> ${inlineHTML(it.hypothesis)}</p>` : ''}
        ${it.method ? `<p><b>方法</b> ${inlineHTML(it.method)}</p>` : ''}
        ${it.experiment ? `<p><b>验证</b> ${inlineHTML(it.experiment)}</p>` : ''}
        ${(it.evidence ?? []).length ? `<ul class="reasons">${it.evidence.map((e: any) => `<li>${inlineHTML(e.origin)}${e.page ? ` · Page ${e.page}` : ''}：${inlineHTML(e.excerpt || '（无摘录）')}</li>`).join('')}</ul>` : ''}
        <p class="sub">更新于 ${inlineHTML(it.updatedAt ?? '')}</p>
        <div class="row">
          <select data-istatus="${inlineHTML(it.id)}">${statuses.map((s) => `<option value="${s}"${s === it.status ? ' selected' : ''}>${labels[s]}</option>`).join('')}</select>
          <button class="ghost" data-idel="${inlineHTML(it.id)}">删除</button>
        </div>
      </article>`).join('') || '<p class="sub">还没有想法。</p>'}
    </div>`;

  $('#idea-add')?.addEventListener('click', async () => {
    const q = ($('#idea-q') as HTMLTextAreaElement).value.trim();
    if (!q) { $('#idea-msg')!.textContent = '至少要填写研究问题'; return; }
    // 证据只有在用户填写了摘录或页码时才带上；否则保持空数组
    const excerpt = ($('#idea-ev-excerpt') as HTMLTextAreaElement).value.trim();
    const pageRaw = ($('#idea-ev-page') as HTMLInputElement).value.trim();
    const origin = ($('#idea-ev-origin') as HTMLSelectElement).value as any;
    const paperKey = ($('#idea-ev-paper') as HTMLSelectElement).value;
    const paperItem = library.find((it) => it.key === paperKey);
    const evidence = (excerpt || pageRaw) ? [{
      id: `ev-${Date.now()}`, paperKey,
      paperTitle: paperItem?.paper.title ?? paperKey,
      origin, page: pageRaw ? Number(pageRaw) : null, excerpt,
    }] : [];

    const res = await api.saveIdea({
      question: q,
      observation: ($('#idea-o') as HTMLTextAreaElement).value.trim(),
      hypothesis: ($('#idea-h') as HTMLTextAreaElement).value.trim(),
      method: ($('#idea-m') as HTMLTextAreaElement).value.trim(),
      experiment: ($('#idea-e') as HTMLTextAreaElement).value.trim(),
      status: 'Idea', evidence,
    });
    // 校验失败就地显示原因，不弹窗丢失已填内容
    if (!res.ok) { $('#idea-msg')!.textContent = '未保存：' + res.error; return; }
    await renderIdeas();
  });
  document.querySelectorAll('[data-idel]').forEach((el) => el.addEventListener('click', async () => {
    if (!confirm('删除这条想法？此操作不可撤销。')) return;
    await api.deleteIdea((el as HTMLElement).dataset.idel!);
    await renderIdeas();
  }));
  document.querySelectorAll('[data-istatus]').forEach((el) => el.addEventListener('change', async () => {
    const id = (el as HTMLElement).dataset.istatus!;
    const cur = ideas.find((x: any) => x.id === id);
    await api.saveIdea({ ...cur, status: (el as HTMLSelectElement).value });
    await renderIdeas();
  }));
}

// ---------- 复现准备 ----------
// 分析必须先过校验（每组 1–4 项、字段不空白、页码真实存在），再按内容指纹归档；
// 核对状态按指纹隔离，新版分析不会继承旧核对结果。

let reproKey: string | null = null;

async function renderReproduction(): Promise<void> {
  const r = await api.getReproduction(reproKey);
  const doc = r.doc ?? { revisions: {} };
  const revisions: string[] = Object.keys(doc.revisions ?? {});
  const latest = revisions[revisions.length - 1];
  const analysis = latest ? (doc.analyses ?? {})[latest] : null;
  const isUnknown = (it: any): boolean => it?.finding?.page == null;
  const titleOf = (it: any): string => it?.finding?.k ?? '';
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
    <div class="row between">
      <h1>复现准备</h1>
      <button class="ghost" id="repro-back">返回</button>
    </div>
    <p class="sub">论文：<code>${inlineHTML(reproKey ?? '')}</code>${latest ? ` · 分析版本 ${inlineHTML(latest.slice(0, 12))}` : ''}</p>
    ${r.ok ? '' : `<div class="warn">核对清单读取失败：${inlineHTML(r.error)}</div>`}

    <div class="card form">
      <label>粘贴复现分析 JSON（由 AI 产出）
        <textarea id="repro-json" placeholder='{"resources":[{"finding":{"k":"数据集","v":"...","page":4,"excerpt":"..."},"assessment":"...","action":"..."}],"environment":[],"cost":[],"missing":[],"risks":[]}'></textarea>
      </label>
      <div class="row"><button id="repro-analyze">校验并保存</button><span id="repro-msg" class="sub"></span></div>
      <p class="sub">校验要求：每组 1–4 项、标题不重复、字段/分析/核对行动都不为空；存在类字段必须有页码与逐字摘录；分析与行动里引用的 <code>Page N</code> 必须真实存在。未知项（<code>page: null</code>）仍然必须给出核对行动。</p>
    </div>

    ${analysis ? `
      <p class="sub">共 ${allItems.length} 项，其中 ${unknownCount} 项为未知（需人工核对）。未知不计入「已确认」。</p>
      ${groups.map(([gid, label, items]) => `
        <h2>${inlineHTML(label)}</h2>
        ${ (items && items.length) ? items.map((it: any) => {
          const t = latest ? ((doc.revisions?.[latest]?.[`${it.finding.k}|${it.finding.page ?? 'unknown'}`]) ?? { status: 'todo', note: '' }) : { status: 'todo', note: '' };
          const itemId = `${it.finding.k}|${it.finding.page ?? 'unknown'}`;
          return `<article class="card${isUnknown(it) ? ' unknown' : ''}">
            <div class="row between">
              <h3>${inlineHTML(titleOf(it))}${isUnknown(it) ? ' <span class="badge">未知</span>' : ''}</h3>
              <select data-repro-status="${inlineHTML(itemId)}">
                ${[['todo', '待核对'], ['verified', '已核对'], ['blocked', '受阻']].map(([v, l]) => `<option value="${v}"${t.status === v ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <p>${inlineHTML(it.assessment)}</p>
            <p class="sub">核对行动：${inlineHTML(it.action)}</p>
            ${it.finding.page != null ? `<p class="sub">原文：Page ${it.finding.page} · ${inlineHTML(it.finding.excerpt ?? '')}</p>` : '<p class="sub">原文：论文未说明（保持未知，不补造）</p>'}
            <input data-repro-note="${inlineHTML(itemId)}" placeholder="核对备注（自动保存）" value="${inlineHTML(t.note ?? '')}">
          </article>`;
        }).join('') : '<p class="sub">该组暂无条目。</p>'}`).join('')}
    ` : '<p class="sub">还没有复现分析。粘贴 AI 产出的 JSON 后点「校验并保存」。</p>'}`;

  $('#repro-back')?.addEventListener('click', () => { reproKey = null; currentMode = 'library'; void route(); });
  $('#repro-analyze')?.addEventListener('click', async () => {
    const raw = ($('#repro-json') as HTMLTextAreaElement).value.trim();
    if (!raw) { $('#repro-msg')!.textContent = '请先粘贴分析 JSON'; return; }
    $('#repro-msg')!.textContent = '校验中…';
    const res = await api.analyzeReproduction(reproKey, raw);
    if (!res.ok) { $('#repro-msg')!.textContent = '未保存：' + res.error; return; }
    await renderReproduction();
  });
  document.querySelectorAll('[data-repro-status]').forEach((el) => el.addEventListener('change', async () => {
    const itemId = (el as HTMLElement).dataset.reproStatus!;
    if (!latest) return;
    await api.setReproductionTask(reproKey, latest, itemId, { status: (el as HTMLSelectElement).value });
    await renderReproduction();
  }));
  document.querySelectorAll('[data-repro-note]').forEach((el) => {
    let timer: number | undefined;
    el.addEventListener('input', () => {
      const itemId = (el as HTMLElement).dataset.reproNote!;
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        if (latest) await api.setReproductionTask(reproKey, latest, itemId, { note: (el as HTMLInputElement).value });
      }, 500);
    });
  });
}
