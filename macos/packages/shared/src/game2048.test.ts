import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GAME2048_SIZE,
  canMoveGame2048,
  createGame2048,
  moveGame2048,
  type Game2048State,
} from './game2048.js';

function fromBoard(board: number[], score = 0): Game2048State {
  return { board, score, best: score, over: false, won: false };
}

test('开局是空棋盘加两块， rng 固定时完全可复现', () => {
  const first = createGame2048(() => 0);
  assert.equal(first.board.filter((value) => value > 0).length, 2);
  assert.deepEqual(first.board, [2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(createGame2048(() => 0).board, first.board);
  assert.equal(first.score, 0);
});

test('向左合并：一次滑动合并相邻同值并计分', () => {
  const state = fromBoard([
    2, 2, 4, 4,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const { state: next, moved } = moveGame2048(state, 'left', () => 0);
  assert.equal(moved, true);
  // rng=0 → 新块值为 2，落在合并后第一个空格（首行第 3 格）。
  assert.deepEqual(next.board, [
    4, 8, 2, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  assert.equal(next.score, 12);
  assert.equal(next.best, 12);
});

test('向右滑动把块推到行尾', () => {
  const state = fromBoard([
    2, 0, 0, 2,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const { state: next } = moveGame2048(state, 'right', () => 0);
  // 合并出 4 靠行尾，新块 2 落回行首空位。
  assert.deepEqual(next.board.slice(0, 4), [2, 0, 0, 4]);
  assert.equal(next.score, 4);
});

test('上下按列合并', () => {
  const state = fromBoard([
    2, 0, 0, 0,
    2, 0, 0, 0,
    4, 0, 0, 0,
    4, 0, 0, 0,
  ]);
  const up = moveGame2048(state, 'up', () => 0);
  assert.equal(up.state.board[0], 4);
  assert.equal(up.state.board[4], 8);
  const down = moveGame2048(state, 'down', () => 0);
  // 向下时贴近行底的一对先合并：4+4 落底，2+2 在其上。
  assert.equal(down.state.board[12], 8);
  assert.equal(down.state.board[8], 4);
});

test('无法移动时原样返回，不生成新块也不计分', () => {
  const board = [
    2, 4, 2, 4,
    4, 2, 4, 2,
    2, 4, 2, 4,
    4, 2, 4, 2,
  ];
  const state = fromBoard(board, 7);
  for (const direction of ['left', 'right', 'up', 'down'] as const) {
    const result = moveGame2048(state, direction, () => 0);
    assert.equal(result.moved, false);
    assert.equal(result.state, state);
  }
  assert.equal(canMoveGame2048(board), false);
});

test('合成 2048 时置位 won，步死后置位 over', () => {
  const won = moveGame2048(
    fromBoard([
      1024, 1024, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]),
    'left',
    () => 0,
  );
  assert.equal(won.state.won, true);
  assert.equal(won.state.board[0], 2048);

  // 死局：唯一的合并走完后，新块恰好把棋盘填死且再无相邻同值。
  const stuck = moveGame2048(
    fromBoard([
      2, 2, 8, 16,
      16, 32, 64, 128,
      256, 512, 2, 4,
      8, 16, 32, 64,
    ]),
    'left',
    () => 0,
  );
  assert.equal(stuck.moved, true);
  assert.deepEqual(stuck.state.board, [
    4, 8, 16, 2,
    16, 32, 64, 128,
    256, 512, 2, 4,
    8, 16, 32, 64,
  ]);
  assert.equal(stuck.state.over, true);
});

test('over 之后不再接受移动', () => {
  const dead: Game2048State = {
    board: [
      2, 4, 2, 4,
      4, 2, 4, 2,
      2, 4, 2, 4,
      4, 2, 4, 2,
    ],
    score: 10,
    best: 10,
    over: true,
    won: false,
  };
  const result = moveGame2048(dead, 'left', () => 0);
  assert.equal(result.moved, false);
  assert.equal(result.state, dead);
});

test('棋盘尺寸与空位判断', () => {
  assert.equal(GAME2048_SIZE, 4);
  assert.equal(canMoveGame2048(Array(16).fill(0)), true);
  assert.equal(canMoveGame2048([2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2, 4, 8, 16, 32, 64]), false);
});
