import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_CELLS, ITEM_COUNT, FREE_CELL, FREE, LINES,
  dealBoard, isMarked, winningCells, hasBingo, markCount, isValidBoard,
} from "../shared/board.ts";
import { seededRng, cryptoRng } from "../shared/seams.ts";

test("a dealt board is 25 cells with a free centre and every item exactly once", () => {
  for (let seed = 0; seed < 50; seed++) {
    const board = dealBoard(seededRng(seed));
    assert.equal(board.length, BOARD_CELLS);
    assert.equal(board[FREE_CELL], FREE);
    assert.ok(isValidBoard(board), `seed ${seed} produced an invalid board`);
  }
});

test("production randomness also produces valid boards", () => {
  for (let i = 0; i < 25; i++) assert.ok(isValidBoard(dealBoard(cryptoRng)));
});

test("the same seed deals the same board, so tests can assert on one", () => {
  assert.deepEqual(dealBoard(seededRng(7)), dealBoard(seededRng(7)));
});

test("different seeds generally deal different boards", () => {
  const a = dealBoard(seededRng(1)).join(",");
  const b = dealBoard(seededRng(2)).join(",");
  assert.notEqual(a, b);
});

test("there are twelve ways to win and each covers the free centre or not correctly", () => {
  assert.equal(LINES.length, 12);
  const throughCentre = LINES.filter((l) => l.includes(FREE_CELL));
  assert.equal(throughCentre.length, 4); // middle row, middle column, both diagonals
});

test("the free centre counts as marked with nothing called at all", () => {
  const board = dealBoard(seededRng(3));
  const none = new Set<number>();
  assert.ok(isMarked(board, FREE_CELL, none));
  assert.equal(markCount(board, none), 1);
  assert.ok(!hasBingo(board, none));
});

test("a completed row is a bingo and reports exactly that row's cells", () => {
  const board = dealBoard(seededRng(11));
  const topRow = [0, 1, 2, 3, 4];
  const called = new Set(topRow.map((p) => board[p] as number));
  assert.ok(hasBingo(board, called));
  assert.deepEqual([...winningCells(board, called)].sort((a, b) => a - b), topRow);
});

test("a diagonal wins with only four items, because the centre is free", () => {
  const board = dealBoard(seededRng(5));
  const diagonal = [0, 6, 12, 18, 24];
  const items = diagonal.filter((p) => p !== FREE_CELL).map((p) => board[p] as number);
  assert.equal(items.length, 4);
  assert.ok(hasBingo(board, new Set(items)));
});

test("four of five is not a bingo", () => {
  const board = dealBoard(seededRng(9));
  const called = new Set([0, 1, 2, 3].map((p) => board[p] as number));
  assert.ok(!hasBingo(board, called));
  assert.equal(winningCells(board, called).size, 0);
});

test("calling every item marks the whole board", () => {
  const board = dealBoard(seededRng(13));
  const all = new Set(Array.from({ length: ITEM_COUNT }, (_, i) => i));
  assert.equal(markCount(board, all), BOARD_CELLS);
});

test("isValidBoard rejects boards that could not have been dealt", () => {
  const good = dealBoard(seededRng(2));
  assert.ok(!isValidBoard(good.slice(0, 24)));                    // wrong length
  assert.ok(!isValidBoard(good.map((v, i) => (i === FREE_CELL ? 0 : v))));  // no free centre
  const dup = [...good];
  dup[0] = dup[1] as number;
  assert.ok(!isValidBoard(dup));                                  // duplicate item
});
