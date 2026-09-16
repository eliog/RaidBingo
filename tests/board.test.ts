import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_CELLS, ITEM_COUNT, FREE_CELL, FREE, LINES,
  dealBoard, isMarked, winningCells, hasBingo, markCount, bestLineOf, isValidBoard,
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

test("every player always has the SAME number of marks — only the line differs", () => {
  // Every board holds all 24 items and calls are global, so a mark count can
  // never distinguish players. This is why the roster ranks on bestLineOf and
  // not on markCount; a marks column would show one number for everybody.
  const boards = Array.from({ length: 8 }, (_, i) => dealBoard(seededRng(i + 1)));
  const called = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  const marks = new Set(boards.map((b) => markCount(b, called)));
  assert.equal(marks.size, 1, "mark counts differed, which should be impossible");
  assert.equal([...marks][0], called.size + 1, "marks are always the calls plus the free centre");

  const lines = new Set(boards.map((b) => bestLineOf(b, called)));
  assert.ok(lines.size > 1, "arrangement should separate players even when marks cannot");
});

test("bestLineOf counts the fullest line, and the free centre counts toward it", () => {
  const board = dealBoard(seededRng(4));
  assert.equal(bestLineOf(board, new Set()), 1, "the free centre alone is one");
  const diagonal = [0, 6, 18, 24].map((p) => board[p] as number);
  assert.equal(bestLineOf(board, new Set(diagonal)), 5, "four items plus the free centre wins");
});

test("isValidBoard rejects boards that could not have been dealt", () => {
  const good = dealBoard(seededRng(2));
  assert.ok(!isValidBoard(good.slice(0, 24)));                    // wrong length
  assert.ok(!isValidBoard(good.map((v, i) => (i === FREE_CELL ? 0 : v))));  // no free centre
  const dup = [...good];
  dup[0] = dup[1] as number;
  assert.ok(!isValidBoard(dup));                                  // duplicate item
});
