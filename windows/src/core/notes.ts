// 精读笔记（papers/*.md）解析：与 macOS 版 Store.loadNotes / parseFrontmatter / splitSections 对齐。
//
// 为什么需要它：macOS 版的「今日」优先展示 papers/ 里有笔记的论文，库状态/进度也以
// 笔记的 key 为准。只读 queue.json 会让「有笔记但不在队列里」的论文（例如 NAF）
// 在 Windows 版完全不可见——那不是空列表，而是功能缺失。

import * as fs from 'fs';
import * as path from 'path';
import { arxivKey } from './paper';

export interface Note {
  id: string;
  file: string;
  meta: Record<string, string>;
  sections: Record<string, string>;
}

/** key：arxiv 归一化后优先，否则用文件名 stem。 */
export function noteKey(n: Note): string {
  const raw = n.meta.arxiv ?? '';
  const a = arxivKey(raw);
  return a || n.id;
}

export function noteTitle(n: Note): string {
  return n.meta.title ?? n.id;
}

/** 解析 YAML frontmatter：只支持 `key: value` 与 `[a, b]` 列表，够用即可。 */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const lines = text.split('\n');
  if (!lines.length || lines[0].trim() !== '---') return { meta, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) return { meta, body: text }; // 未闭合的 frontmatter：按普通正文处理，不崩
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const k = line.slice(0, at).trim();
    let v = line.slice(at + 1).trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).replace(/["']/g, '').trim();
    v = v.replace(/^["']|["']$/g, '');
    if (k) meta[k] = v;
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

/**
 * 按 `## 标题` 切分正文段落。
 *
 * 真实笔记的标题带编号与空格（如 `## 1. 问题设定`、`## 2. 方法核心`），
 * 因此必须先去编号再比对；否则除「一句话总结」外全部段落会被静默丢弃。
 */
export function splitSections(body: string): Record<string, string> {
  const order = ['summary', 'setup', 'method', 'experiments', 'insights', 'annotations'];
  const titles: Record<string, string[]> = {
    summary: ['一句话总结', 'tl;dr', 'tldr', 'summary'],
    setup: ['问题设定', 'setup', 'problem'],
    method: ['方法核心', 'method'],
    experiments: ['实验可信度', 'experiments'],
    insights: ['研究启发', 'insights'],
    annotations: ['我的批注', 'annotations'],
  };
  /**
   * 去掉 `1.` / `1.2` / `一、` 这类前导编号，便于比对标题本体。
   *
   * 分隔符必须是**必需**项，不能写成可选：`一句话总结` 会被 `一` 吃掉变成「句话总结」，
   * `3D 重建` 会被 `3` 吃掉变成「D 重建」。中文数字与阿拉伯数字都是正常词首字符。
   */
  const normalizeHeading = (h: string): string =>
    h.trim().toLowerCase()
      .replace(/^[0-9]+(?:\.[0-9]+)*[.、)]\s*/, '')
      .replace(/^[一二三四五六七八九十]+[、.)]\s*/, '')
      .trim();

  const out: Record<string, string> = {};
  const lines = body.split('\n');
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = (): void => { if (cur) out[cur] = (out[cur] ? out[cur] + '\n' : '') + buf.join('\n').trim(); buf = []; };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      const heading = normalizeHeading(m[1]);
      cur = order.find((k) => (titles[k] ?? []).some((t) => heading === t.toLowerCase())) ?? null;
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return out;
}

export interface LoadNotesResult { notes: Note[]; failed: string[] }

/** 读取 papers/*.md。读不出来的文件要显式报告，不能静默跳过。 */
export function loadNotes(papersDir: string): LoadNotesResult {
  const notes: Note[] = [];
  const failed: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(papersDir);
  } catch {
    return { notes, failed };
  }
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;   // _template.md 跳过
    try {
      const raw = fs.readFileSync(path.join(papersDir, f), 'utf8');
      if (!raw.trim()) { failed.push(`${f}（空文件）`); continue; }
      const { meta, body } = parseFrontmatter(raw);
      notes.push({ id: f.replace(/\.md$/, ''), file: f, meta, sections: splitSections(body) });
    } catch (e) {
      failed.push(`${f}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { notes, failed };
}

/** 队列条目 -> 笔记匹配（语义与 macOS 版 noteForQueue 一致）。 */
export function noteForQueue(notes: Note[], q: { arxiv?: string | null; id?: string | null; key?: string; title?: string | null }): Note | null {
  for (const note of notes) {
    if (q.arxiv && note.meta.arxiv === q.arxiv) return note;
    if (q.id && note.id === q.id) return note;
    const key = q.key ?? (q.arxiv ? arxivKey(q.arxiv) : (q.id ?? ''));
    // 文件名子串匹配仅兜底：短 key 可能误配，故要求 key 足够长
    if (key.length >= 6 && note.file.toLowerCase().includes(key.toLowerCase())) return note;
    const a = (note.meta.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const b = (q.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (a.length > 20 && a === b) return note;
  }
  return null;
}
