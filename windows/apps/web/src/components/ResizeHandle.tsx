import { useRef } from 'react';

export function ResizeHandle({ label, value, onStart, onStep, onReset }: {
  label: string;
  value: number;
  onStart: () => (delta: number) => void;
  onStep: (delta: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<{ x: number; resize: (delta: number) => void } | null>(null);
  return <div role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={0} aria-valuenow={Math.round(value)} tabIndex={0}
    className="reader-resize-handle" title={`${label}；双击恢复默认宽度，方向键微调`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, resize: onStart() };
    }}
    onPointerMove={(event) => drag.current?.resize(event.clientX - drag.current.x)}
    onPointerUp={() => { drag.current = null; }}
    onPointerCancel={() => { drag.current = null; }}
    onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); onStep(event.key === 'ArrowLeft' ? -16 : 16);
      } else if (event.key === 'Home') { event.preventDefault(); onReset(); }
    }} />;
}
