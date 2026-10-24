/** 2048 引擎：纯函数实现，摸鱼界面的「小游戏」直接复用，测试用固定 rng 保证可复现。 */

export const GAME2048_SIZE = 4;

export type Game2048Direction = 'left' | 'right' | 'up' | 'down';

export interface Game2048State {
  board: number[];
  score: number;
  best: number;
  over: boolean;
  /** 合成过 2048 就置位并保持；之后可以继续玩，界面只提示一次。 */
  won: boolean;
}

export interface Game2048Move {
  state: Game2048State;
  moved: boolean;
}

function slideLine(line: number[]): { line: number[]; gained: number } {
  const tiles = line.filter((value) => value > 0);
  const out: number[] = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] === tiles[i + 1]) {
      const merged = tiles[i]! * 2;
      out.push(merged);
      gained += merged;
      i++;
    } else out.push(tiles[i]!);
  }
  while (out.length < GAME2048_SIZE) out.push(0);
  return { line: out, gained };
}

function lineIndices(direction: Game2048Direction, order: number): number[] {
  const indices: number[] = [];
  for (let step = 0; step < GAME2048_SIZE; step++) {
    const row = direction === 'up' || direction === 'down' ? step : order;
    const column = direction === 'up' || direction === 'down' ? order : step;
    indices.push(row * GAME2048_SIZE + column);
  }
  if (direction === 'right' || direction === 'down') indices.reverse();
  return indices;
}

/** 往随机空格里放一个新块：90% 是 2，10% 是 4；没有空格则原样返回。 */
function spawnTile(board: number[], rng: () => number): void {
  const empty: number[] = [];
  for (let index = 0; index < board.length; index++) if (!board[index]) empty.push(index);
  if (!empty.length) return;
  const index = empty[Math.min(empty.length - 1, Math.floor(rng() * empty.length))]!;
  board[index] = rng() < 0.9 ? 2 : 4;
}

export function createGame2048(rng: () => number = Math.random): Game2048State {
  const board = Array<number>(GAME2048_SIZE * GAME2048_SIZE).fill(0);
  spawnTile(board, rng);
  spawnTile(board, rng);
  return { board, score: 0, best: 0, over: false, won: false };
}

export function canMoveGame2048(board: number[]): boolean {
  for (let index = 0; index < board.length; index++) {
    const value = board[index]!;
    if (!value) return true;
    const column = index % GAME2048_SIZE;
    const row = Math.floor(index / GAME2048_SIZE);
    if (column < GAME2048_SIZE - 1 && board[index + 1] === value) return true;
    if (row < GAME2048_SIZE - 1 && board[index + GAME2048_SIZE] === value) return true;
  }
  return false;
}

export function moveGame2048(
  state: Game2048State,
  direction: Game2048Direction,
  rng: () => number = Math.random,
): Game2048Move {
  if (state.over) return { state, moved: false };
  const board = [...state.board];
  let gained = 0;
  let moved = false;
  for (let order = 0; order < GAME2048_SIZE; order++) {
    const indices = lineIndices(direction, order);
    const result = slideLine(indices.map((index) => board[index]!));
    gained += result.gained;
    indices.forEach((index, step) => {
      if (board[index] !== result.line[step]) moved = true;
      board[index] = result.line[step]!;
    });
  }
  if (!moved) return { state, moved: false };
  spawnTile(board, rng);
  const score = state.score + gained;
  return {
    state: {
      board,
      score,
      best: Math.max(state.best, score),
      over: !canMoveGame2048(board),
      won: state.won || board.includes(2048),
    },
    moved: true,
  };
}
