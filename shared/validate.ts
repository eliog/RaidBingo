/**
 * Validation shared by the server (authoritative) and the browser (instant
 * feedback in the item editor and the name gate). No Node or DOM imports.
 */

import { ITEM_COUNT } from "./board.ts";

export const CHAR_NAME_MAX = 24;
export const TITLE_MAX = 40;

/**
 * Item length. The hard cap keeps a square renderable; the soft cap is where
 * the editor warns. Under 48 characters every item fits at 10.5px in a 74px
 * phone cell, which is the narrowest case the board has to survive.
 */
export const ITEM_MAX = 60;
export const ITEM_SOFT_MAX = 48;

export type Valid<T> = { ok: true; value: T };
export type Invalid = { ok: false; reason: string };
export type Result<T> = Valid<T> | Invalid;

const ok = <T,>(value: T): Valid<T> => ({ ok: true, value });
const bad = (reason: string): Invalid => ({ ok: false, reason });

/** Collapse runs of whitespace and trim. What gets displayed. */
export function normalizeCharName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * The key uniqueness is checked against. `char_name` is the ONLY identity that
 * reaches the client, so two players called Thalgrim would make the roster,
 * the bingo call-out and the winner ranking ambiguous for the whole night.
 * `Thalgrim`, `thalgrim` and `Thal grim` are all the same person to this.
 */
export function charNameKey(raw: string): string {
  return normalizeCharName(raw).toLowerCase().replaceAll(" ", "");
}

export function validateCharName(raw: string): Result<string> {
  const name = normalizeCharName(raw);
  if (name === "") return bad("Enter the character you're raiding on.");
  if (name.length > CHAR_NAME_MAX) {
    return bad(`Character names are at most ${CHAR_NAME_MAX} characters.`);
  }
  if (charNameKey(name) === "") return bad("That name has no letters in it.");
  return ok(name);
}

export function validateTitle(raw: string): Result<string> {
  const title = raw.replace(/\s+/g, " ").trim();
  if (title === "") return bad("Give the game a title — it's what people see in Discord.");
  if (title.length > TITLE_MAX) return bad(`Titles are at most ${TITLE_MAX} characters.`);
  return ok(title);
}

export interface ItemProblem {
  /** Zero-based slot, so the editor can point at the right field. */
  index: number;
  kind: "empty" | "too-long" | "duplicate";
  message: string;
  /** For a duplicate, the earlier slot it clashes with. */
  clashesWith?: number;
}

export interface ItemCheck {
  ok: boolean;
  items: string[];
  problems: ItemProblem[];
  /** Over the soft cap but under the hard cap — a warning, not a failure. */
  warnings: ItemProblem[];
  filled: number;
}

/**
 * A game needs exactly 24 items. Duplicates are reported against the earlier
 * slot they clash with, because "one of these two is wrong" is not actionable
 * on its own.
 */
export function checkItems(raw: readonly string[]): ItemCheck {
  const items = raw.map((s) => s.replace(/\s+/g, " ").trim());
  const problems: ItemProblem[] = [];
  const warnings: ItemProblem[] = [];
  const firstSeen = new Map<string, number>();

  items.forEach((item, index) => {
    if (item === "") {
      problems.push({ index, kind: "empty", message: "This square is empty." });
      return;
    }
    if (item.length > ITEM_MAX) {
      problems.push({
        index,
        kind: "too-long",
        message: `${item.length} characters — the limit is ${ITEM_MAX}.`,
      });
    } else if (item.length > ITEM_SOFT_MAX) {
      warnings.push({
        index,
        kind: "too-long",
        message: `${item.length} characters — tight at phone width.`,
      });
    }
    const key = item.toLowerCase();
    const earlier = firstSeen.get(key);
    if (earlier === undefined) {
      firstSeen.set(key, index);
    } else {
      problems.push({
        index,
        kind: "duplicate",
        message: `Same as ${earlier + 1} — change one of them.`,
        clashesWith: earlier,
      });
    }
  });

  const filled = items.filter((s) => s !== "").length;
  const rightCount = items.length === ITEM_COUNT;
  return { ok: rightCount && problems.length === 0, items, problems, warnings, filled };
}
