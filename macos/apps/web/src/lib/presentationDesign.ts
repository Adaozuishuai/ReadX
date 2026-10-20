import type { DocumentSummary } from '@cbct/shared';
import { READING_STEPS, readingStep, type ReadingKind } from './readingSteps';

export const SLIDE_WIDTH = 13.333333;
export const SLIDE_HEIGHT = 7.5;
export const TEXT_FONT = 'Microsoft YaHei';
export const NUMBER_FONT = 'Times New Roman';
export const NUMBER_PATTERN = /([0-9０-９⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+(?:[.,][0-9]+)*(?:[eE][+-]?[0-9]+)?(?:%|°)?)/g;
export const LAYOUT_NAMES = { editorial: '重点解读', comparison: '对比分析', process: '方法流程', evidence: '图文证据', metrics: '数据聚焦', focus: '核心观点' } as const;
export type PresentationLayout = keyof typeof LAYOUT_NAMES;

export interface PresentationTheme {
  accent: string; accentDark: string; ink: string; muted: string; faint: string;
  line: string; paper: string; canvas: string; fontFace: string;
}
export const DEFAULT_PRESENTATION_THEME: PresentationTheme = {
  accent: '276653', accentDark: '173D32', ink: '21342C', muted: '65766D',
  faint: '87968D', line: 'DCE5DF', paper: 'FFFFFF', canvas: 'F4F7F3', fontFace: TEXT_FONT,
};

function luminance(hex: string) {
  const values = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0]! * .2126 + values[1]! * .7152 + values[2]! * .0722;
}
function contrast(a: string, b: string) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + .05) / (lo! + .05); }
export function readableTheme(input: PresentationTheme): PresentationTheme {
  const theme = { ...DEFAULT_PRESENTATION_THEME };
  for (const key of ['accent', 'accentDark', 'ink', 'muted', 'faint', 'line', 'paper', 'canvas'] as const) if (/^[\da-f]{6}$/i.test(input[key])) theme[key] = input[key];
  const foreground = contrast('21342C', theme.paper) >= contrast('FFFFFF', theme.paper) ? '21342C' : 'FFFFFF';
  if (contrast(theme.ink, theme.paper) < 4.5) theme.ink = foreground;
  if (contrast(theme.muted, theme.paper) < 3) theme.muted = foreground;
  if (contrast(theme.ink, theme.canvas) < 4.5) theme.canvas = theme.paper;
  if (contrast(theme.accent, theme.paper) < 3) theme.accent = foreground;
  // The cover uses white lettering even when an uploaded template is very pale.
  while (contrast('FFFFFF', theme.accentDark) < 4.5) theme.accentDark = [0, 2, 4].map((offset) => Math.floor(parseInt(theme.accentDark.slice(offset, offset + 2), 16) * .8).toString(16).padStart(2, '0')).join('');
  return theme;
}
export interface PlannedSlide {
  section: ReadingKind; title: string; bullets: string[];
  layout?: PresentationLayout; takeaway?: string; visualIds?: string[];
}
export interface PresentationPlan { slides: PlannedSlide[] }
export interface DeckVisual { id: string; section: ReadingKind; page: number; caption: string; imageURL: string; points: string[]; notes: string }
export interface DeckTable { header: string[]; rows: string[][] }
export interface DeckPage extends PlannedSlide { visual?: DeckVisual; table?: DeckTable; notes?: string }
interface Bounds { x: number; y: number; w: number; h: number }
export interface TextNode extends Bounds { kind: 'text'; text: string; lines: string[]; fontSize: number; bold: boolean; color: string; align: 'left' | 'center' | 'right'; lineHeight: number }
export interface RectNode extends Bounds { kind: 'rect'; color: string }
export interface LineNode { kind: 'line'; x: number; y: number; w: number; color: string; width: number }
export interface ImageNode extends Bounds { kind: 'image'; url: string; alt: string; visualId: string }
export interface TableNode extends Bounds { kind: 'table'; header: string[]; rows: string[][]; rowHeights: number[]; accent: string; headerInk: string; ink: string; line: string; canvas: string; paper: string; fontSize: number }
export type SlideNode = TextNode | RectNode | LineNode | ImageNode | TableNode;
export interface PresentationScene { id: string; title: string; label: string; section?: ReadingKind; background: string; nodes: SlideNode[]; notes: string }

export function normalizePlannedSlide(value: unknown, allowed: Set<ReadingKind>): PlannedSlide | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.section !== 'string' || !allowed.has(item.section as ReadingKind) || typeof item.title !== 'string' || !Array.isArray(item.bullets)) return null;
  const title = item.title.trim().slice(0, 160);
  const bullets = item.bullets.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean).slice(0, 6);
  if (!title || !bullets.length) return null;
  const layout = typeof item.layout === 'string' && Object.hasOwn(LAYOUT_NAMES, item.layout) ? item.layout as PresentationLayout : undefined;
  return { section: item.section as ReadingKind, title, bullets, layout,
    takeaway: typeof item.takeaway === 'string' ? item.takeaway.trim().slice(0, 240) : undefined,
    visualIds: Array.isArray(item.visualIds) ? item.visualIds.filter((v): v is string => typeof v === 'string').slice(0, 2) : [] };
}

// The same measured text boxes feed the SVG preview and native PowerPoint text.
export function textUnits(value: string): number {
  return [...value].reduce((sum, char) => sum + (/\s/.test(char) ? .28 : /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : /[MW@%]/.test(char) ? .85 : /[il.,:;'!|]/.test(char) ? .3 : /[A-Z]/.test(char) ? .66 : .54), 0);
}
export function wrapSlideText(text: string, width: number, fontSize: number): string[] {
  const limit = width * 72 / fontSize * .93;
  return text.split('\n').flatMap((paragraph) => {
    const words = paragraph.match(/[A-Za-z0-9]+(?:[-'’.,][A-Za-z0-9]+)*|\s+|./gu) ?? [''];
    const lines: string[] = []; let line = '';
    for (const word of words) {
      if (line && textUnits(line + word) > limit) { lines.push(line.trim()); line = ''; }
      // Long URLs and identifiers must also stay within the text box.
      if (textUnits(word) > limit) {
        for (const char of word) {
          if (line && textUnits(line + char) > limit) { lines.push(line.trim()); line = ''; }
          line += char;
        }
      } else line += word;
    }
    if (line.trim() || !lines.length) lines.push(line.trim());
    return lines;
  });
}
function text(scene: PresentationScene, value: string, box: Bounds, size: number, color: string, bold = false, align: TextNode['align'] = 'left') {
  if (!value.trim()) return;
  let fontSize = size;
  let lines = wrapSlideText(value, box.w, fontSize);
  while (lines.length * fontSize / 72 * 1.18 > box.h && fontSize > 11) { fontSize -= .5; lines = wrapSlideText(value, box.w, fontSize); }
  scene.nodes.push({ kind: 'text', ...box, text: value, lines, fontSize, bold, color, align, lineHeight: fontSize / 72 * 1.18 });
}
function rect(scene: PresentationScene, x: number, y: number, w: number, h: number, color: string) { scene.nodes.push({ kind: 'rect', x, y, w, h, color }); }
function line(scene: PresentationScene, x: number, y: number, w: number, color: string, width = .7) { scene.nodes.push({ kind: 'line', x, y, w, color, width }); }
function splitLead(value: string): [string, string] {
  const match = /^(.{2,32}?)[：:]\s*(.+)$/s.exec(value);
  return match ? [match[1]!, match[2]!] : ['', value];
}
export function paginatePoints(points: string[], max = 3): string[][] {
  const fragments = points.flatMap((point) => {
    if (textUnits(point) <= 94) return [point];
    const result: string[] = []; let current = '';
    for (const phrase of point.match(/[^。！？；;]+[。！？；;]?/g) ?? [point]) {
      if (current && textUnits(current + phrase) > 94) { result.push(current); current = ''; }
      if (textUnits(phrase) > 94) {
        for (const part of wrapSlideText(phrase, 7.8, 12)) result.push(part);
      } else current += phrase;
    }
    if (current.trim()) result.push(current.trim());
    return result;
  });
  const pages: string[][] = []; let current: string[] = [];
  for (const point of fragments) {
    if (current.length && (current.length >= max || current.reduce((sum, p) => sum + textUnits(p), 0) + textUnits(point) > 180)) { pages.push(current); current = []; }
    current.push(point);
  }
  if (current.length) pages.push(current);
  return pages;
}

export function paginateTable(table: DeckTable): DeckTable[] {
  const result: DeckTable[] = [];
  for (let col = 1; col < Math.max(2, table.header.length); col += 4) {
    const columns = [0, ...Array.from({ length: Math.min(4, table.header.length - col) }, (_, i) => col + i)];
    const width = 11.97 / columns.length - .28;
    const header = columns.map((c) => table.header[c] ?? '');
    const headerH = Math.max(.62, ...header.map((cell) => wrapSlideText(cell, width, 14).length * 14 / 72 * 1.18 + .24));
    let rows: string[][] = [], height = headerH;
    for (const row of table.rows) {
      const cells = columns.map((c) => wrapSlideText(row[c] ?? '', width, 14));
      const maxLines = Math.max(1, Math.floor((4.2 - headerH - .24) / (14 / 72 * 1.18)));
      const slices = Math.ceil(Math.max(...cells.map((cell) => cell.length)) / maxLines);
      for (let part = 0; part < slices; part++) {
        const chunk = cells.map((cell, i) => part && i === 0 && cell.length <= maxLines ? cell.join('\n') : cell.slice(part * maxLines, (part + 1) * maxLines).join('\n'));
        const rowH = Math.max(.62, ...chunk.map((cell) => cell.split('\n').length * 14 / 72 * 1.18 + .24));
        if (rows.length && height + rowH > 4.3) { result.push({ header, rows }); rows = []; height = headerH; }
        rows.push(chunk); height += rowH;
      }
    }
    if (rows.length) result.push({ header, rows });
  }
  return result;
}
export function chooseLayout(page: PlannedSlide, index = 0): PresentationLayout {
  if (page.visualIds?.length) return 'evidence';
  if (page.bullets.length === 1) return 'focus';
  if (page.layout && page.layout !== 'evidence') return page.layout;
  if (page.section === 'method' && page.bullets.length >= 2) return 'process';
  if (page.section === 'results' && page.bullets.filter((p) => /\d+(?:\.\d+)?\s*(?:%|dB|ms|GB|倍)/i.test(p)).length >= 2) return 'metrics';
  if (page.bullets.length === 2 && page.section === 'motivation') return 'comparison';
  return index % 3 === 2 ? 'focus' : 'editorial';
}

function base(id: string, title: string, label: string, theme: PresentationTheme, section?: ReadingKind): PresentationScene {
  return { id, title, label, section, background: theme.paper, nodes: [], notes: '' };
}
function frame(scene: PresentationScene, theme: PresentationTheme, page: number, total: number) {
  text(scene, scene.section ? readingStep(scene.section).label : 'READX / RESEARCH', { x: .66, y: .36, w: 9, h: .25 }, 10, theme.accent, true);
  line(scene, .66, 6.99, 12.01, theme.line);
  text(scene, 'ReadX', { x: .66, y: 7.11, w: 2, h: .18 }, 9, theme.faint);
  text(scene, `${String(page).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11.5, y: 7.08, w: 1.15, h: .23 }, 10, theme.faint, false, 'right');
}
function heading(scene: PresentationScene, title: string, theme: PresentationTheme) {
  text(scene, title, { x: .66, y: .9, w: 12, h: 1.03 }, 31, theme.ink, true);
}
function takeaway(scene: PresentationScene, value: string | undefined, theme: PresentationTheme) {
  if (!value) return;
  line(scene, .68, 6.12, .45, theme.accent, 2);
  text(scene, value.length > 96 ? `${value.slice(0, 95)}…` : value, { x: 1.32, y: 6.1, w: 11.18, h: .57 }, 15, theme.accent, true);
}
function point(scene: PresentationScene, value: string, x: number, y: number, w: number, h: number, theme: PresentationTheme, size = 21) {
  const [lead, detail] = splitLead(value);
  if (lead) {
    text(scene, lead, { x, y, w, h: .48 }, size, theme.ink, true);
    text(scene, detail, { x, y: y + .57, w, h: Math.max(.4, h - .57) }, size - 2, theme.muted);
  } else text(scene, value, { x, y, w, h }, size, theme.ink);
}

function contentScene(page: DeckPage, index: number, theme: PresentationTheme): PresentationScene {
  const layout = page.visual ? 'evidence' : chooseLayout(page, index);
  const scene = base(`content-${index}`, page.title, page.table ? '数据表格' : LAYOUT_NAMES[layout], theme, page.section);
  scene.notes = [page.notes, page.takeaway].filter(Boolean).join('\n\n');
  heading(scene, page.title, theme);
  const bullets = page.bullets;
  if (page.table) {
    const width = 11.97 / page.table.header.length - .28;
    const cells = [page.table.header, ...page.table.rows].map((row) => row.map((cell) => wrapSlideText(cell, width, 14).join('\n')));
    const rowHeights = cells.map((row) => Math.max(.62, ...row.map((cell) => cell.split('\n').length * 14 / 72 * 1.18 + .24)));
    scene.nodes.push({ kind: 'table', x: .68, y: 2.1, w: 11.97, h: rowHeights.reduce((a, b) => a + b, 0), header: cells[0]!, rows: cells.slice(1), rowHeights, fontSize: 14, accent: theme.accent, headerInk: contrast('FFFFFF', theme.accent) >= 4.5 ? 'FFFFFF' : '21342C', ink: theme.ink, line: theme.line, canvas: theme.canvas, paper: theme.paper });
  } else if (page.visual) {
    const v = page.visual;
    rect(scene, .66, 2.08, 8.0, 4.02, theme.canvas);
    scene.nodes.push({ kind: 'image', x: .84, y: 2.26, w: 7.64, h: 3.66, url: v.imageURL, alt: v.caption, visualId: v.id });
    const points = bullets.length ? bullets : v.points;
    const count = Math.min(points.length, 3);
    const height = 3.95 / Math.max(count, 1);
    points.slice(0, 3).forEach((value, i) => {
      text(scene, String(i + 1).padStart(2, '0'), { x: 9.02, y: 2.12 + i * height, w: .5, h: .28 }, 13, theme.accent);
      point(scene, value, 9.02, 2.49 + i * height, 3.53, height - .45, theme, 18);
    });
    text(scene, `Page ${v.page} · ${v.caption.length > 140 ? `${v.caption.slice(0, 139)}…` : v.caption}`, { x: .68, y: 6.27, w: 11.97, h: .5 }, 10.5, theme.muted);
  } else if (layout === 'process') {
    const count = Math.min(bullets.length, 4), gap = .34, width = (12 - (count - 1) * gap) / Math.max(1, count);
    bullets.slice(0, 4).forEach((value, i) => {
      const x = .68 + i * (width + gap);
      line(scene, x, 2.66, width, theme.line, 1.4);
      text(scene, String(i + 1).padStart(2, '0'), { x, y: 2.1, w: width, h: .49 }, 28, theme.accent);
      point(scene, value, x, 3.04, width - .08, 2.7, theme, 21);
    });
    takeaway(scene, page.takeaway, theme);
  } else if (layout === 'comparison') {
    const columns = [bullets.filter((_, i) => i % 2 === 0), bullets.filter((_, i) => i % 2 === 1)];
    columns.forEach((values, i) => {
      const x = .68 + i * 6.17;
      rect(scene, x, 2.14, 5.8, .06, i ? theme.accent : theme.line);
      values.forEach((value, j) => point(scene, value, x, 2.56 + j * 1.56, 5.57, 1.42, theme, 23));
    });
    takeaway(scene, page.takeaway, theme);
  } else if (layout === 'metrics' && bullets.filter((p) => /\d/.test(p)).length >= 2) {
    bullets.slice(0, 3).forEach((value, i) => {
      const width = 12 / Math.min(3, bullets.length), x = .68 + i * width;
      const match = /[+-]?\d+(?:\.\d+)?\s*(?:%|dB|ms\b|GB\b|MB\b|倍|×)/i.exec(value) ?? /(?<![\w.])\d+\.\d+(?![\w.])/.exec(value) ?? /(?<![\w.])\d+(?![\w.])/.exec(value);
      text(scene, match?.[0] ?? String(i + 1), { x, y: 2.38, w: width - .35, h: .95 }, 47, theme.accent, true);
      line(scene, x, 3.6, width - .4, theme.line);
      point(scene, value, x, 3.94, width - .4, 1.8, theme, 20);
    });
    takeaway(scene, page.takeaway, theme);
  } else if (layout === 'focus') {
    rect(scene, .66, 2.16, .06, 3.48, theme.accent);
    text(scene, bullets[0] ?? '', { x: 1.03, y: 2.27, w: 7.03, h: 3.12 }, 32, theme.ink, true);
    bullets.slice(1, 3).forEach((value, i) => point(scene, value, 8.68, 2.27 + i * 1.78, 3.93, 1.53, theme, 19));
    takeaway(scene, page.takeaway, theme);
  } else {
    const first = bullets[0] ?? '';
    text(scene, first, { x: .68, y: 2.35, w: 5.13, h: 3.27 }, 28, theme.ink, true);
    bullets.slice(1, 4).forEach((value, i, rest) => {
      const h = 3.58 / rest.length, y = 2.23 + i * h;
      line(scene, 6.43, y, 6.13, theme.line);
      point(scene, value, 6.43, y + .2, 6.1, h - .27, theme, 20);
    });
    takeaway(scene, page.takeaway, theme);
  }
  return scene;
}

export function createDeckScenes(document: DocumentSummary | null | undefined, pages: DeckPage[], inputTheme = DEFAULT_PRESENTATION_THEME, includeSummary = true): PresentationScene[] {
  const theme = readableTheme(inputTheme);
  const title = document?.title?.trim() || '论文精读报告';
  const cover = base('cover', title, '封面', theme);
  cover.background = theme.accentDark;
  text(cover, 'READX / RESEARCH PRESENTATION', { x: .8, y: .68, w: 11.7, h: .3 }, 11, 'C7DCD2', true);
  text(cover, title, { x: .8, y: 1.8, w: 11.5, h: 3.05 }, title.length > 130 ? 35 : 42, 'FFFFFF', true);
  const meta = [document?.authors?.slice(0, 5).join(', '), document?.venue, document?.year].filter(Boolean).join(' · ');
  line(cover, .83, 5.58, 1.1, '91BBA7', 2);
  text(cover, meta || '论文研读与学术汇报', { x: .83, y: 5.87, w: 11.65, h: .55 }, 14, 'C7DCD2');
  text(cover, 'ReadX', { x: .83, y: 6.93, w: 3, h: .23 }, 11, '91BBA7');
  const scenes: PresentationScene[] = [cover];
  const sections = READING_STEPS.filter((step) => pages.some((page) => page.section === step.kind));
  if (sections.length > 1) {
    const agenda = base('agenda', '研究脉络', '研究脉络', theme);
    heading(agenda, '研究脉络', theme);
    const rowH = Math.min(.81, 4.25 / sections.length);
    sections.forEach((step, i) => {
      const y = 2.12 + i * rowH;
      text(agenda, String(i + 1).padStart(2, '0'), { x: .7, y, w: .6, h: .4 }, 23, theme.accent);
      text(agenda, step.label, { x: 1.65, y, w: 3, h: .4 }, 22, theme.ink, true);
      text(agenda, pages.find((page) => page.section === step.kind)?.title ?? '', { x: 5.3, y: y + .04, w: 7.25, h: .4 }, 16, theme.muted);
      line(agenda, 1.65, y + .62, 10.94, theme.line);
    });
    scenes.push(agenda);
  }
  pages.forEach((page, index) => scenes.push(contentScene(page, index, theme)));
  if (pages.length && includeSummary) {
    const closing = base('summary', '研究总结', '研究总结', theme);
    heading(closing, '研究总结', theme);
    const summary = ['motivation', 'method', 'results'].flatMap((kind) => {
      const page = pages.find((p) => p.section === kind && !p.visual && !p.table);
      return page ? [{ kind: kind as ReadingKind, point: page.takeaway || page.bullets[0] || '' }] : [];
    });
    (summary.length ? summary : pages.slice(-2).map((page) => ({ kind: page.section, point: page.takeaway || page.bullets[0] || '' }))).slice(0, 3).forEach((item, i) => {
      const y = 2.23 + i * 1.25;
      text(closing, readingStep(item.kind).label, { x: .7, y: y + .04, w: 2.3, h: .4 }, 16, theme.accent, true);
      text(closing, item.point, { x: 3.1, y, w: 9.4, h: 1.02 }, 23, theme.ink);
    });
    scenes.push(closing);
  }
  scenes.forEach((scene, index) => { if (index) frame(scene, theme, index + 1, scenes.length); });
  return scenes;
}
