import type { PDFLayout, PDFTextBlock } from './pdfLayout.js';
import { joinLineContinuation } from './text.js';

export type TranslationRole = 'title' | 'heading' | 'body' | 'caption' | 'label' | 'note';
export interface TranslatedPDFBlock extends PDFTextBlock {
  sourceIndexes: number[];
  target: string;
  role: TranslationRole;
  align: 'left' | 'center' | 'justify';
  lineHeight: number;
  indent: number;
}

/**
 * 版式校正计划：来自 AI 视觉（服务端已校验）。
 *
 * 只描述结构——哪些块属于同一段（groups）、每段是什么角色、哪些块应当丢弃（drop）——
 * 绝不携带正文。段落文本仍然逐字来自这些几何块，因此翻译缓存键不受影响。
 */
export interface PDFTranslationPlan {
  groups: { from: number; to: number; role?: TranslationRole }[];
  drop?: number[];
}

const ROLES: TranslationRole[] = ['title', 'heading', 'body', 'caption', 'label', 'note'];

type JoinedBlock = PDFTextBlock & { sourceIndexes: number[]; targets: string[]; indent: number; planned?: TranslationRole };

/** Presentation only: source blocks and their translation-cache keys stay intact. */
export function typesetPDFTranslation(layout: PDFLayout, targets: string[], plan?: PDFTranslationPlan): TranslatedPDFBlock[] {
  const usable = plan && planIsUsable(layout, plan) ? plan : undefined;
  const joined = usable ? joinByPlan(layout, targets, usable) : joinByIndentation(layout, targets);
  const fontOf = (block: PDFTextBlock) => block.textFontSize ?? block.fontSize;
  const bodyCandidates = joined.filter(block => block.text.length > 100 && block.width > layout.width * .2).map(fontOf).sort((a, b) => a-b);
  const allFonts = joined.map(fontOf).sort((a, b) => a-b);
  const bodyFont = bodyCandidates[Math.floor(bodyCandidates.length / 2)] ?? allFonts[Math.floor(allFonts.length / 2)] ?? 10;
  return joined.map(block => {
    const cap = layout.ornaments?.find(cap => Math.abs(cap.y-block.y) < block.fontSize && block.x >= cap.x-1 && block.x-cap.x < cap.width+block.fontSize);
    if (cap) {
      block.width += block.x-cap.x;
      block.x = cap.x;
      block.indent = 0;
    }
    const sourceFont = fontOf(block);
    const compact = block.height < sourceFont * 2.8;
    let role: TranslationRole;
    if (block.planned) role = block.planned;
    else if (sourceFont > bodyFont * 1.4 && block.y < layout.height * .35) role = 'title';
    else if (compact && (sourceFont > bodyFont * 1.15 || (sourceFont >= bodyFont * .82 && block.text.length < 180 && /^(?:\d+(?:\.\d+)*[.\s]|[IVX]+\.\s|abstract\b|introduction\b|conclusions?\b|references\b)/i.test(block.text)))) role = 'heading';
    else if (/^(?:fig(?:ure)?\.?|table|图|表)\s*\d/i.test(block.text)) role = 'caption';
    else if (sourceFont < bodyFont * .82) role = 'note';
    else if (compact && block.width < layout.width * .2) role = 'label';
    else role = 'body';
    const centered = role === 'title' && Math.abs(block.x + block.width / 2 - layout.width / 2) < layout.width * .12;
    const fontSize = (role === 'body' ? bodyFont : sourceFont) * .98;
    const target = block.targets.join(' ').replace(/\r\n?/g, '\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/[\t ]+/g, ' ').replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff，。！？；：、])/g, '$1').trim();
    const lineHeight = role === 'title' ? 1.18 : block.height < sourceFont * 1.7 ? 1.14 : role === 'body' ? 1.42 : 1.3;
    return { ...block, fontSize, target, role, align: centered ? 'center' : role === 'body' && block.width > layout.width * .25 ? 'justify' : 'left', lineHeight };
  });
}

/** 按 AI 视觉给出的分组直接成段；drop 里的块（页眉、表格行、脚注等）不输出。 */
function joinByPlan(layout: PDFLayout, targets: string[], plan: PDFTranslationPlan): JoinedBlock[] {
  const dropped = new Set(plan.drop ?? []);
  const out: JoinedBlock[] = [];
  for (const group of [...plan.groups].sort((a, b) => a.from - b.from)) {
    const members: number[] = [];
    for (let index = group.from; index <= group.to; index += 1) {
      if (!dropped.has(index) && index >= 0 && index < layout.blocks.length) members.push(index);
    }
    if (!members.length) continue;
    const first = layout.blocks[members[0]!]!;
    const last = layout.blocks[members[members.length - 1]!]!;
    let text = first.text;
    let left = first.x;
    let right = first.x + first.width;
    for (const index of members.slice(1)) {
      const block = layout.blocks[index]!;
      text = joinLineContinuation(text, block.text);
      left = Math.min(left, block.x);
      right = Math.max(right, block.x + block.width);
    }
    out.push({
      ...first,
      text,
      x: left,
      width: right - left,
      height: last.y + last.height - first.y,
      sourceIndexes: members,
      targets: members.map(index => targets[index] ?? layout.blocks[index]!.text),
      indent: 0,
      ...(group.role ? { planned: group.role } : {}),
    });
  }
  return out;
}

/**
 * 没有视觉计划时的几何分组：把「缩进的段首 + 齐左续行」这两个独立块并回一段。
 * A first line indented by 1–2 em is often extracted separately. Join only
 * that line with its continuation, never neighboring columns or new paragraphs.
 */
function joinByIndentation(layout: PDFLayout, targets: string[]): JoinedBlock[] {
  const joined: JoinedBlock[] = [];
  for (const [index, block] of layout.blocks.entries()) {
    const preceding = joined.findLast(candidate => {
      const indent = candidate.x - block.x;
      const gap = block.y - candidate.y - candidate.height;
      const cap = layout.ornaments?.find(cap => Math.abs(cap.x - block.x) < block.fontSize && Math.abs(cap.y - candidate.y) < block.fontSize && candidate.y+candidate.height < cap.y+cap.height+block.fontSize);
      return candidate.sourceIndexes.length === 1 && candidate.height <= (cap ? cap.height+block.fontSize*.3 : candidate.fontSize * 1.6) &&
        block.width > layout.width * .25 && indent > block.fontSize * .45 && indent < (cap ? cap.width+block.fontSize : block.fontSize * 2.5) &&
        gap >= -1 && gap < block.fontSize * .85 &&
        Math.abs(candidate.fontSize - block.fontSize) < block.fontSize * .15 &&
        candidate.width > block.width * .62 && candidate.width + indent < block.width * 1.13 &&
        !/[.!?:;。！？：；]$/.test(candidate.text.trim());
    });
    if (preceding) {
      preceding.indent = preceding.x - block.x;
      preceding.height = block.y + block.height - preceding.y;
      preceding.width = Math.max(preceding.x + preceding.width, block.x + block.width) - block.x;
      preceding.x = block.x;
      preceding.text = joinLineContinuation(preceding.text, block.text);
      preceding.targets.push(targets[index] ?? block.text);
      preceding.sourceIndexes.push(index);
      if (block.textFontSize != null) preceding.textFontSize = Math.max(preceding.textFontSize ?? 0, block.textFontSize);
    } else joined.push({ ...block, sourceIndexes: [index], targets: [targets[index] ?? block.text], indent: 0 });
  }
  return joined;
}

/** 计划来自模型，客户端再做一次防御性校验；不可用就整体回退几何判读。 */
export function planIsUsable(layout: PDFLayout, plan: PDFTranslationPlan): boolean {
  if (!plan.groups.length) return false;
  const dropped = new Set(plan.drop ?? []);
  if ([...dropped].some(index => !Number.isInteger(index) || index < 0 || index >= layout.blocks.length)) return false;
  // 少块页（例如半页正文）允许丢弃的绝对数量仍然放宽，否则页眉+页脚就会顶破比例上限。
  if (dropped.size > Math.max(4, layout.blocks.length * 0.2)) return false;
  let cursor = 0;
  for (const group of [...plan.groups].sort((a, b) => a.from - b.from)) {
    if (!Number.isInteger(group.from) || !Number.isInteger(group.to)) return false;
    if (group.from !== cursor) return false;
    if (group.to < group.from || group.to >= layout.blocks.length) return false;
    if (group.role && !ROLES.includes(group.role)) return false;
    cursor = group.to + 1;
  }
  // 允许分组覆盖到 drop 位置：drop 里的块不参与段落，但要落在某个分组的跨度内。
  return cursor === layout.blocks.length;
}
