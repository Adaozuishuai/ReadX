// 迷你 Markdown 块级解析。与 native/Sources/CBCTReading/Markdown.swift 语义一致。

import { MarkdownTable, isDelimiterRow, parseTable } from './markdownTable';

export type MDBlock =
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'table'; table: MarkdownTable }
  | { kind: 'rule' }
  | { kind: 'mathBlock'; latex: string };

/** 水平分隔线：--- / *** / ___（也可写成 - - -），至少 3 个相同字符。
 *  必须排除表格分隔行（含 |），否则表格会被误判成 hr。 */
export function isHorizontalRule(t: string): boolean {
  const body = t.replace(/ /g, '');
  if (body.includes('|') || body.length < 3) return false;
  return /^-+$/.test(body) || /^\*+$/.test(body) || /^_+$/.test(body);
}

/** 收集独立公式块：从未闭合时返回 null，交给常规解析按普通文本处理（不吞掉正文）。 */
export function collectMathBlock(lines: string[], start: number): { latex: string; next: number } | null {
  const first = lines[start].trim();
  const isDoubleDollar = first.startsWith('$$');
  const open = isDoubleDollar ? '$$' : '\\[';
  const close = isDoubleDollar ? '$$' : '\\]';
  let body = first.slice(open.length);
  const same = body.indexOf(close);
  if (same >= 0) return { latex: body.slice(0, same).trim(), next: start + 1 };

  let idx = start + 1;
  const parts = [body];
  while (idx < lines.length) {
    const line = lines[idx];
    const at = line.indexOf(close);
    if (at >= 0) {
      parts.push(line.slice(0, at));
      return { latex: parts.join('\n').trim(), next: idx + 1 };
    }
    parts.push(line);
    idx++;
    if (idx - start > 12) break;   // 防止吞掉整篇文档
  }
  return null;
}

export function parseMarkdown(src: string): MDBlock[] {
  const blocks: MDBlock[] = [];
  let kind: MDBlock | null = null;
  let buf: string[] = [];

  const flush = (): void => {
    if (!kind) { buf = []; return; }
    switch (kind.kind) {
      case 'heading': blocks.push(kind); break;
      case 'quote': blocks.push({ kind: 'quote', lines: buf }); break;
      case 'bullets': blocks.push({ kind: 'bullets', items: buf }); break;
      case 'ordered': blocks.push({ kind: 'ordered', items: buf }); break;
      case 'paragraph': if (buf.length) blocks.push({ kind: 'paragraph', lines: buf }); break;
      case 'mathBlock': blocks.push(kind); break;
      default: break;
    }
    buf = [];
    kind = null;
  };

  const lines = src.split('\n');
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx];
    const t = line.trim();

    if (!t) { flush(); idx++; continue; }

    // 独立公式块可能跨多行，直到出现闭合定界符
    if (t.startsWith('$$') || t.startsWith('\\[')) {
      flush();
      const found = collectMathBlock(lines, idx);
      if (found) { blocks.push({ kind: 'mathBlock', latex: found.latex }); idx = found.next; continue; }
    }

    if (t.startsWith('### ')) { flush(); blocks.push({ kind: 'heading', text: t.slice(4), level: 3 }); idx++; continue; }
    if (t.startsWith('## ')) { flush(); blocks.push({ kind: 'heading', text: t.slice(3), level: 2 }); idx++; continue; }
    if (t.startsWith('# ')) { flush(); blocks.push({ kind: 'heading', text: t.slice(2), level: 1 }); idx++; continue; }

    if (isHorizontalRule(t)) { flush(); blocks.push({ kind: 'rule' }); idx++; continue; }

    // 孤立的分隔行（只有表头+分隔行、没有数据行）不能并进上一段，
    // 否则会显示成 "| A | B | |---|---|" 这类糊在一起的一行。
    if (isDelimiterRow(t)) { flush(); blocks.push({ kind: 'paragraph', lines: [t] }); idx++; continue; }

    // 表格必须在段落判定之前，否则整块会被并进 paragraph
    const tbl = parseTable(lines, idx);
    if (tbl) { flush(); blocks.push({ kind: 'table', table: tbl.table }); idx += tbl.consumed; continue; }

    if (t.startsWith('> ') || t === '>') {
      const body = t.slice(2);
      if (kind?.kind === 'quote') buf.push(body);
      else { flush(); kind = { kind: 'quote', lines: [] }; buf.push(body); }
      idx++; continue;
    }

    if (t.startsWith('- ') || t.startsWith('* ')) {
      const item = t.slice(2);
      if (kind?.kind === 'bullets') buf.push(item);
      else { flush(); kind = { kind: 'bullets', items: [] }; buf.push(item); }
      idx++; continue;
    }

    // 有序列表：点号前必须全是数字、点号后必须紧跟空格。
    // 只判「首字符是数字 + 点号在前 2 字符内」会把小数与编号章节误判成列表，
    // 并把首个数字连同小数点一起吃掉（0.5 mm -> 列表项 "5 mm"）。
    const dot = t.indexOf('.');
    if (dot > 0 && /^[0-9]+$/.test(t.slice(0, dot)) && dot <= 2 &&
        t.length > dot + 1 && t[dot + 1] === ' ') {
      const body = t.slice(dot + 1).trim();
      if (kind?.kind === 'ordered') buf.push(body);
      else { flush(); kind = { kind: 'ordered', items: [] }; buf.push(body); }
      idx++; continue;
    }

    if (kind?.kind === 'paragraph') buf.push(t);
    else { flush(); kind = { kind: 'paragraph', lines: [] }; buf.push(t); }
    idx++;
  }
  flush();
  return blocks;
}

/** 极简行内标记 -> HTML。刻意不支持原始 HTML，避免 XSS。 */
export function inlineHTML(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

/**
 * 行内渲染 + 证据页码链接化。
 *
 * 关键顺序：**先转义、再插入链接**。如果在已生成的 HTML 字符串上跑链接正则，
 * 会改写 href 属性里的文字，把标签结构弄坏（实测会生成嵌套 <a>）。
 * 这里在「纯文本」阶段把 Page N 换成占位符，转义后替换成真实标签。
 */
export function inlineHTMLWithEvidence(s: string): string {
  const PLACEHOLDER = '\u0000EV';
  const pages: string[] = [];
  const marked = s.replace(/Page\s+(\d+)/g, (_full, n: string) => {
    pages.push(n);
    return `${PLACEHOLDER}${pages.length - 1}\u0000`;
  });
  const html = inlineHTML(marked);
  return html.replace(/\u0000EV(\d+)\u0000/g, (_m, i: string) =>
    `<a class="ev" data-page="${pages[Number(i)]}">Page ${pages[Number(i)]}</a>`);
}

/** 从标题文本解析页码锚点编号（仅匹配「整行就是 Page N」的标题）。 */
export function pageAnchorNumber(text: string): string | null {
  return /^\s*Page\s+(\d+)\s*$/.exec(text)?.[1] ?? null;
}
