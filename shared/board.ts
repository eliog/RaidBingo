/**
 * Board geometry and line detection. Imported by BOTH the server (which is
 * authoritative) and the browser (which highlights instantly), so it must
 * stay free of any Node or DOM dependency.
 */

import type { Rng } from "./seams.ts";

/** Cells on a board, including the free centre. */
export const BOARD_CELLS = 25;
/** Items a game carries. The 25th cell is free. */
export const ITEM_COUNT = 24;
/** Position of the free centre square — "the Callstone". */
export const FREE_CELL = 12;
/** Value stored at the free cell instead of an item index. */
export const FREE = -1;

/**
 * Deal a board: a shuffle of item indices 0..23 with FREE at the centre.
 *
 * Boards are STORED, not derived from a seed. Deriving would mean any edit to
 * the item list, or any change to this function, silently rearranged every
 * board that ever existed — including finished games.
 */
export function dealBoard(rng: Rng): number[] {
  const items: number[] = [];
  for (let i = 0; i < ITEM_COUNT; i++) items.push(i);

  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const a = items[i] as number;
    items[i] = items[j] as number;
    items[j] = a;
  }

  return [...items.slice(0, FREE_CELL), FREE, ...items.slice(FREE_CELL)];
}

/** The twelve ways to win: five rows, five columns, two diagonals. */
export const LINES: readonly (readonly number[])[] = (() => {
  const out: number[][] = [];
  for (let r = 0; r < 5; r++) out.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
  for (let c = 0; c < 5; c++) out.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
  out.push([0, 6, 12, 18, 24]);
  out.push([4, 8, 12, 16, 20]);
  return out;
})();

/** Is the cell at this position marked? The free centre always is. */
export function isMarked(
  board: readonly number[],
  position: number,
  called: ReadonlySet<number>,
): boolean {
  const item = board[position];
  if (item === undefined) return false;
  return item === FREE || called.has(item);
}

/** Every board POSITION that sits on a completed line. Empty when there is no bingo. */
export function winningCells(
  board: readonly number[],
  called: ReadonlySet<number>,
): Set<number> {
  const won = new Set<number>();
  for (const line of LINES) {
    if (line.every((p) => isMarked(board, p, called))) {
      for (const p of line) won.add(p);
    }
  }
  return won;
}

export function hasBingo(board: readonly number[], called: ReadonlySet<number>): boolean {
  return LINES.some((line) => line.every((p) => isMarked(board, p, called)));
}

/** How many of this board's cells are marked, free centre included. */
export function markCount(board: readonly number[], called: ReadonlySet<number>): number {
  let n = 0;
  for (let p = 0; p < BOARD_CELLS; p++) if (isMarked(board, p, called)) n++;
  return n;
}

/** Reject a stored board that is not a valid permutation. */
export function isValidBoard(board: readonly number[]): boolean {
  if (board.length !== BOARD_CELLS) return false;
  if (board[FREE_CELL] !== FREE) return false;
  const seen = new Set<number>();
  for (let p = 0; p < BOARD_CELLS; p++) {
    if (p === FREE_CELL) continue;
    const item = board[p];
    if (item === undefined || !Number.isInteger(item)) return false;
    if (item < 0 || item >= ITEM_COUNT) return false;
    if (seen.has(item)) return false;
    seen.add(item);
  }
  return seen.size === ITEM_COUNT;
}
