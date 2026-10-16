/**
 * 批注高亮分段（纯函数，便于单测）。
 *
 * 正文是重排后的段落，批注里的摘录来自原始抽取文本，两者的空白不一定一致。
 * 所以匹配在「压掉空白」的副本上做，再把命中位置映射回原文偏移——
 * 这样摘录中间多一个空格、或少一个换行都不会让高亮消失。
 */

export interface AnnotationLike {
  id: string;
  kind: string;
  color: string;
  quote: string;
  page?: number | null;
}

export interface Segment {
  text: string;
  annotationId?: string;
  kind?: string;
  color?: string;
}

interface Span {
  start: number;
  end: number;
  id: string;
  kind: string;
  color: string;
}

function collapseWithMap(text: string): { collapsed: string; map: number[] } {
  const collapsed: string[] = [];
  const map: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (/\s/.test(char)) continue;
    collapsed.push(char);
    map.push(index);
  }
  return { collapsed: collapsed.join(''), map };
}

/** 返回段落在原文里的 [start, end) 区间列表；无命中则空数组。 */
export function annotationSpans(text: string, annotations: AnnotationLike[]): Span[] {
  const { collapsed, map } = collapseWithMap(text);
  if (!collapsed) return [];

  const taken: Span[] = [];
  const ordered = [...annotations].sort((a, b) => collapseWithMap(b.quote).collapsed.length - collapseWithMap(a.quote).collapsed.length);

  for (const annotation of ordered) {
    const needle = collapseWithMap(annotation.quote).collapsed;
    if (needle.length < 1) continue;
    const at = collapsed.indexOf(needle);
    if (at < 0) continue;
    const start = map[at] as number;
    const end = (map[at + needle.length - 1] as number) + 1;
    // 与已命中的区间重叠就跳过：长摘录优先，短摘录不该把长摘录切成两半。
    if (taken.some((span) => start < span.end && span.start < end)) continue;
    taken.push({ start, end, id: annotation.id, kind: annotation.kind, color: annotation.color });
  }
  return taken.sort((a, b) => a.start - b.start);
}

/** 把段落切成「普通文本 / 批注片段」交替的序列，供 React 直接渲染。 */
export function segmentParagraph(text: string, annotations: AnnotationLike[]): Segment[] {
  const spans = annotationSpans(text, annotations);
  if (!spans.length) return text ? [{ text }] : [];
  const segments: Segment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: text.slice(cursor, span.start) });
    segments.push({ text: text.slice(span.start, span.end), annotationId: span.id, kind: span.kind, color: span.color });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** 该页的批注（page 为 null 的批注不绑定页，不参与正文高亮）。 */
export function annotationsForPage(annotations: AnnotationLike[], page: number | null): AnnotationLike[] {
  if (page == null) return [];
  return annotations.filter((item) => item.page === page);
}
