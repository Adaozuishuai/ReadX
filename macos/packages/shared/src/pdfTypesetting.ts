import type { PDFLayout, PDFTextBlock } from './pdfLayout.js';

export type TranslationRole = 'title' | 'heading' | 'body' | 'caption' | 'label' | 'note';
export interface TranslatedPDFBlock extends PDFTextBlock {
  sourceIndexes: number[];
  target: string;
  role: TranslationRole;
  align: 'left' | 'center' | 'justify';
  lineHeight: number;
  indent: number;
}

/** Presentation only: source blocks and their translation-cache keys stay intact. */
export function typesetPDFTranslation(layout: PDFLayout, targets: string[]): TranslatedPDFBlock[] {
  const joined: (PDFTextBlock & { sourceIndexes: number[]; targets: string[]; indent: number })[] = [];
  for (const [index, block] of layout.blocks.entries()) {
    // A first line indented by 1–2 em is often extracted separately. Join only
    // that line with its continuation, never neighboring columns or new paragraphs.
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
      preceding.text = preceding.text.replace(/-$/, '') + `${preceding.text.endsWith('-') ? '' : ' '}${block.text}`;
      preceding.targets.push(targets[index] ?? block.text);
      preceding.sourceIndexes.push(index);
      if (block.textFontSize != null) preceding.textFontSize = Math.max(preceding.textFontSize ?? 0, block.textFontSize);
    } else joined.push({ ...block, sourceIndexes: [index], targets: [targets[index] ?? block.text], indent: 0 });
  }
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
    let role: TranslationRole = 'body';
    if (sourceFont > bodyFont * 1.4 && block.y < layout.height * .35) role = 'title';
    else if (compact && (sourceFont > bodyFont * 1.15 || (sourceFont >= bodyFont * .82 && block.text.length < 180 && /^(?:\d+(?:\.\d+)*[.\s]|[IVX]+\.\s|abstract\b|introduction\b|conclusions?\b|references\b)/i.test(block.text)))) role = 'heading';
    else if (/^(?:fig(?:ure)?\.?|table|图|表)\s*\d/i.test(block.text)) role = 'caption';
    else if (sourceFont < bodyFont * .82) role = 'note';
    else if (compact && block.width < layout.width * .2) role = 'label';
    const centered = role === 'title' && Math.abs(block.x + block.width / 2 - layout.width / 2) < layout.width * .12;
    const fontSize = (role === 'body' ? bodyFont : sourceFont) * .98;
    const target = block.targets.join(' ').replace(/\r\n?/g, '\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/[\t ]+/g, ' ').replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff，。！？；：、])/g, '$1').trim();
    const lineHeight = role === 'title' ? 1.18 : block.height < sourceFont * 1.7 ? 1.14 : role === 'body' ? 1.42 : 1.3;
    return { ...block, fontSize, target, role, align: centered ? 'center' : role === 'body' && block.width > layout.width * .25 ? 'justify' : 'left', lineHeight };
  });
}
