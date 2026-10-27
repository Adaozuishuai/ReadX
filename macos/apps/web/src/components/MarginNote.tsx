import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Annotation, AnnotationRect } from '../api/client';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Size a fresh note to its text; coordinates remain relative to the PDF page. */
export function initialMarginRect(text: string, x: number, y: number, pageAspect = 0.707): AnnotationRect {
  const lines = text.split('\n').map((line) => Array.from(line).reduce((width, char) => width + (/[^\x00-\xff]/u.test(char) ? 1 : 0.6), 0));
  const widest = Math.max(1, ...lines);
  const width = clamp(widest * 0.022 + 0.022, 0.055, 0.24);
  const charsPerLine = Math.max(1, (width - 0.022) / 0.022);
  const lineCount = lines.reduce((total, line) => total + Math.max(1, Math.ceil(line / charsPerLine)), 0);
  const height = clamp(lineCount * 0.022 * 1.32 * pageAspect + 0.018, 0.04, 0.3);
  return { x: clamp(x, 0, 1 - width), y: clamp(y, 0, 1 - height), width, height };
}

/** Coordinates stay relative to the PDF page, so the same geometry works at every zoom. */
export function adjustNoteRect(start: AnnotationRect, dx: number, dy: number, resize: boolean): AnnotationRect {
  if (resize) return { ...start, width: clamp(start.width + dx, 0.04, 1 - start.x), height: clamp(start.height + dy, 0.04, 1 - start.y) };
  return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
}

export function MarginNote({ item, fontSize, pageAspect = 0.707, focused, onEdit, onGeometry }: {
  item: Annotation;
  fontSize: number;
  pageAspect?: number;
  focused: boolean;
  onEdit: (item: Annotation) => void;
  onGeometry: (item: Annotation, rect: AnnotationRect) => Promise<void>;
}) {
  const stored = item.locator?.noteRect ?? item.locator?.rects?.[0];
  // Notes created by the earlier fixed-size default should also fit their text.
  // Any other dimensions are user-adjusted and must remain untouched.
  const saved = stored && stored.width === 0.24 && stored.height === 0.2
    ? initialMarginRect(item.note, stored.x, stored.y, pageAspect)
    : stored;
  const [preview, setPreview] = useState<AnnotationRect | null>(null);
  const [saving, setSaving] = useState(false);
  const interaction = useRef<{ pointer: number; x: number; y: number; width: number; height: number; start: AnnotationRect; last: AnnotationRect; resize: boolean; moved: boolean } | null>(null);
  useEffect(() => { if (!saving && !interaction.current) setPreview(null); }, [saved?.x, saved?.y, saved?.width, saved?.height, saving]);
  if (!saved) return null;
  const rect = preview ?? saved;

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (saving || event.button !== 0) return;
    const page = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!page?.width || !page.height) return;
    const resize = (event.target as Element).closest('.pdf-margin-resize') !== null;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, width: page.width, height: page.height, start: rect, last: rect, resize, moved: false };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = interaction.current;
    if (!current || current.pointer !== event.pointerId) return;
    const px = event.clientX - current.x, py = event.clientY - current.y;
    if (!current.moved && Math.hypot(px, py) < 3) return;
    current.moved = true;
    current.last = adjustNoteRect(current.start, px / current.width, py / current.height, current.resize);
    setPreview(current.last);
  };
  const end = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const current = interaction.current;
    if (!current || current.pointer !== event.pointerId) return;
    event.stopPropagation();
    interaction.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) { setPreview(null); return; }
    if (!current.moved) { setPreview(null); if (!current.resize) onEdit(item); return; }
    setSaving(true);
    void onGeometry(item, current.last).catch(() => setPreview(null)).finally(() => setSaving(false));
  };

  return <div role="button" tabIndex={0} data-annotation-id={item.id} className={`pdf-margin-note pdf-margin-note--${item.color}${focused ? ' ann-focused' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`, fontSize: fontSize * clamp(rect.width / 0.24, 1, 2.5) }} title="拖动笔记可移动，拖动右下角可调整大小；点击编辑" aria-label={`页边笔记：${item.note}。点击编辑，可拖动位置和右下角调整大小`} onPointerDown={begin} onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)} onClick={(event) => event.stopPropagation()} onMouseUp={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onEdit(item); } }}>
    <span className="pdf-margin-note-text">{item.note}</span>
    <span className="pdf-margin-resize" aria-hidden="true" title="拖动调整大小" />
  </div>;
}
