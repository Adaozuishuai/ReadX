import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useFocusClock, type ResearchWorkbenchController } from '../../hooks/useResearchWorkbench';
import { focusSeconds, formatFocusClock, isFocusRunning, toggleFocusSession } from '../../lib/researchWorkbench';
import { readJSON, STORAGE_KEYS, writeJSON } from '../../lib/storage';
import './focus-pendant.css';

const WIDTH = 172;
const clampLeft = (value: number) => Math.min(Math.max(8, value), Math.max(8, window.innerWidth - WIDTH - 8));

export function FocusPendant({ controller, onOpenWorkbench }: { controller: ResearchWorkbenchController; onOpenWorkbench: () => void }) {
  const { data, setData } = controller;
  const session = data.focusSession;
  const now = useFocusClock(session);
  const [left, setLeft] = useState(() => {
    const saved = readJSON<number | null>(STORAGE_KEYS.focusPendantPosition, null);
    return clampLeft(typeof saved === 'number' && Number.isFinite(saved) ? saved : window.innerWidth - WIDTH - 110);
  });
  const leftRef = useRef(left);
  const drag = useRef<{ pointerId: number; x: number; left: number } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    const resize = () => {
      const next = clampLeft(leftRef.current);
      leftRef.current = next; setLeft(next);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (moved.current) writeJSON(STORAGE_KEYS.focusPendantPosition, leftRef.current);
  };
  if (!session) return null;
  const running = isFocusRunning(session);
  const clock = formatFocusClock(focusSeconds(session, now));
  const mode = session.mode === 'stopwatch' ? '正计时' : '倒计时';
  const title = data.todos.find(todo => todo.id === session.todoId)?.title || '自由专注';

  return <aside className="rw-focus-pendant" style={{ left }} aria-label="专注计时牌">
    <span className="rw-focus-pendant-string" aria-hidden="true" />
    <div className="rw-focus-pendant-card">
      <button className="rw-focus-pendant-clock" aria-label={`返回专注工作台，${mode} ${clock}${running ? '' : '，已暂停'}`} title={`${title}；点击返回工作台，按住可沿顶部拖动`}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0) return;
          drag.current = { pointerId: event.pointerId, x: event.clientX, left: leftRef.current };
          moved.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          if (drag.current?.pointerId !== event.pointerId) return;
          const delta = event.clientX - drag.current.x;
          if (Math.abs(delta) >= 4) moved.current = true;
          if (!moved.current) return;
          const next = clampLeft(drag.current.left + delta);
          leftRef.current = next; setLeft(next);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={event => { moved.current = true; finishDrag(event); }}
        onClick={event => { if (!moved.current || event.detail === 0) onOpenWorkbench(); }}>
        <strong role="timer">{clock}</strong>
      </button>
      <button className={`rw-focus-hourglass${running ? ' is-running' : ''}`} aria-label={running ? '暂停专注' : '继续专注'} title={running ? '暂停专注' : '继续专注'} onClick={() => setData(current => toggleFocusSession(current, Date.now()))}>
        <svg viewBox="0 0 28 36" fill="none" aria-hidden="true">
          <g className="rw-focus-hourglass-turn">
            <path d="M6 5h16M6 31h16M8 5v5c0 4 3 5 6 8-3 3-6 4-6 8v5M20 5v5c0 4-3 5-6 8 3 3 6 4 6 8v5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            <path className="rw-focus-hourglass-upper" d="M10 10h8c0 2.5-2 4-4 6-2-2-4-3.5-4-6Z" fill="currentColor" />
            <path className="rw-focus-hourglass-stream" d="M14 18v8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path className="rw-focus-hourglass-lower" d="m14 23 4 5h-8l4-5Z" fill="currentColor" />
          </g>
        </svg>
      </button>
    </div>
  </aside>;
}
