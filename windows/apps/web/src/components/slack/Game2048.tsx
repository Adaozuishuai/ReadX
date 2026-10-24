import { useCallback, useEffect, useRef, useState } from 'react';
import { createGame2048, moveGame2048, type Game2048Direction, type Game2048State } from '@cbct/shared';
import { STORAGE_KEYS, writeJSON } from '../../lib/storage';

const KEY_MAP: Record<string, Game2048Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
};
/** 数字块配色按 2 的幂分档，超表回到通用档。 */
const TILE_LEVELS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

function tileLevel(value: number): number {
  const index = TILE_LEVELS.indexOf(value);
  return index >= 0 ? index : TILE_LEVELS.length;
}

function loadSaved(): Game2048State | null {
  let parsed: Partial<Game2048State> | null = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.game2048) ?? 'null') as Partial<Game2048State> | null;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.board) || parsed.board.length !== 16) return null;
  return {
    board: parsed.board.map((value) => (Number.isInteger(value) && value > 0 ? value : 0)),
    score: Math.max(0, Math.round(Number(parsed.score) || 0)),
    best: Math.max(0, Math.round(Number(parsed.best) || 0)),
    over: Boolean(parsed.over),
    won: Boolean(parsed.won),
  };
}

export function Game2048() {
  const [state, setState] = useState<Game2048State>(() => loadSaved() ?? createGame2048());
  const history = useRef<Game2048State[]>([]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    writeJSON(STORAGE_KEYS.game2048, state);
  }, [state]);

  const doMove = useCallback((direction: Game2048Direction) => {
    if (state.over) return;
    const { state: next, moved } = moveGame2048(state, direction);
    if (!moved) return;
    history.current = [...history.current.slice(-11), state];
    setState(next);
    setNotice(next.won && !state.won ? '已合成 2048，继续冲更高分' : next.over ? '这局走不动了' : '');
  }, [state]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      const direction = KEY_MAP[event.key] ?? KEY_MAP[event.key.toLowerCase()];
      if (!direction) return;
      event.preventDefault();
      doMove(direction);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [doMove]);

  const undo = () => {
    const previous = history.current.pop();
    if (!previous) return;
    setNotice('');
    setState(previous);
  };

  const restart = () => {
    history.current = [];
    setNotice('');
    setState((current) => ({ ...createGame2048(), best: current.best }));
  };

  return (
    <main className="slack-game">
      <header className="slack-game__hud">
        <h1>2048</h1>
        <p>方向键 / WASD / 滑动屏幕移动，相同数字撞在一起翻倍。</p>
        <div className="slack-game__scores">
          <span>分数 <strong>{state.score}</strong></span>
          <span>最佳 <strong>{state.best}</strong></span>
        </div>
      </header>

      <div
        className="slack-game__board"
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch') return;
          touchStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={(event) => {
          const start = touchStart.current;
          touchStart.current = null;
          if (!start || event.pointerType !== 'touch') return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
          doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
        }}
        role="grid"
        aria-label="2048 棋盘"
      >
        {state.board.map((value, index) => (
          <span
            key={index}
            className={`slack-game__tile${value ? ` slack-game__tile--l${tileLevel(value)}` : ''}`}
            role="gridcell"
            aria-label={value ? String(value) : '空'}
          >
            {value || ''}
          </span>
        ))}
        {state.over ? (
          <div className="slack-game__overlay" role="status">
            <strong>走不动了</strong>
            <span>本局 {state.score} 分</span>
            <button type="button" className="slack-primary" onClick={restart}>再来一局</button>
          </div>
        ) : null}
      </div>

      <div className="slack-game__controls">
        <div className="slack-game__pad" aria-label="方向按钮">
          <span />
          <button type="button" onClick={() => doMove('up')} aria-label="上移">↑</button>
          <span />
          <button type="button" onClick={() => doMove('left')} aria-label="左移">←</button>
          <button type="button" onClick={() => doMove('down')} aria-label="下移">↓</button>
          <button type="button" onClick={() => doMove('right')} aria-label="右移">→</button>
        </div>
        <div className="slack-game__actions">
          <button type="button" onClick={undo} disabled={!history.current.length}>撤销一步</button>
          <button type="button" onClick={restart}>新的一局</button>
          {notice ? <span className="slack-game__notice" role="status">{notice}</span> : null}
        </div>
      </div>
    </main>
  );
}
