import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { STORAGE_KEYS } from '../../lib/storage';

export type WorkspaceMode = 'research' | 'slack';

const POSITION_KEY = STORAGE_KEYS.pendantPosition;
const PENDANT_WIDTH = 68;
const EDGE_GAP = 8;

function clampLeft(left: number) {
  return Math.min(Math.max(left, EDGE_GAP), Math.max(EDGE_GAP, window.innerWidth - PENDANT_WIDTH - EDGE_GAP));
}

function initialLeft() {
  if (typeof window === 'undefined') return EDGE_GAP;
  const saved = Number(window.localStorage.getItem(POSITION_KEY));
  return clampLeft(Number.isFinite(saved) && saved > 0 ? saved : window.innerWidth - PENDANT_WIDTH - 26);
}

/** 点击挂件拉上舞台幕布，在幕布后切换工作区。原生按钮同时支持键盘操作。 */
export function ModePendant({
  mode,
  onMode,
}: {
  mode: WorkspaceMode;
  onMode: (mode: WorkspaceMode) => void;
}) {
  const next = mode === 'slack' ? 'research' : 'slack';
  const label = mode === 'slack' ? '点击挂件，拉幕返回科研界面' : '点击挂件，拉幕进入摸鱼界面';
  const [left, setLeft] = useState(initialLeft);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const leftRef = useRef(left);
  const moved = useRef(false);

  useEffect(() => {
    const onResize = () => {
      const nextLeft = clampLeft(leftRef.current);
      leftRef.current = nextLeft;
      setLeft(nextLeft);
      window.localStorage.setItem(POSITION_KEY, String(nextLeft));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startLeft: leftRef.current };
    moved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    const delta = event.clientX - activeDrag.startX;
    if (Math.abs(delta) >= 4) moved.current = true;
    if (!moved.current) return;
    const nextLeft = clampLeft(activeDrag.startLeft + delta);
    leftRef.current = nextLeft;
    setLeft(nextLeft);
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (moved.current) {
      window.localStorage.setItem(POSITION_KEY, String(leftRef.current));
      // The browser dispatches click after pointerup; suppress that click after a drag.
      window.setTimeout(() => { moved.current = false; }, 0);
    }
  };

  return (
    <div className="mode-pendant" data-mode={mode} style={{ left }}>
      <div className="mode-pendant__swing">
        <button
          type="button"
          className="mode-pendant__handle"
          aria-label={label}
          title={`${label}；按住可沿顶部拖动位置`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={() => {
            if (moved.current) return;
            onMode(next);
          }}
        >
          <img src="/slack/qwen.png" alt="" draggable={false} />
        </button>
        {mode === 'slack' ? <span className="mode-pendant__tag">摸鱼中</span> : null}
      </div>
    </div>
  );
}
