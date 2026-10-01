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

/** Colour scheme. "auto" follows the device, so it is the default. */
export const THEMES = ["auto", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const isTheme = (v: unknown): v is Theme => (THEMES as readonly unknown[]).includes(v);

export type Valid<T> = { ok: true; value: T };
export type Invalid = { ok: false; reason: string };
export type Result<T> = Valid<T> | Invalid;

const ok = <T,>(value: T): Valid<T> => ({ ok: true, value });
const bad = (reason: string): Invalid => ({ ok: false, reason });

/**
 * Characters that render as nothing or rearrange what is around them: every
 * control (Cc) and format (Cf) character — which covers zero-width spaces,
 * the soft hyphen, BOM, every bidi mark, embedding, override and isolate, and
 * the tag block — plus the blank fillers and joiners that are letters or marks
 * on paper but draw nothing: Hangul fillers, the braille blank, the combining
 * grapheme joiner, Khmer inherent vowels, Mongolian selectors and the
 * variation selectors. Lone surrogates (Cs) and noncharacters go too: they
 * are not text, and XML refuses them, which broke the link preview (#17).
 *
 * Stripped rather than refused: a stray one from a paste should not cost
 * someone their message.
 */
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/**
 * Kept in free text (chat, titles, squares), never in a name. The joiners
 * hold 🧙‍♂️ and 🏳️‍🌈 together and shape real text in several scripts; U+FE0E and
 * U+FE0F pick text or emoji style. A name has no use for any of them, and in
 * a name they only make two identical-looking names count as different.
 */
const KEEP_IN_TEXT = new Set(["\u200C", "\u200D", "\uFE0E", "\uFE0F"]);

/**
 * The one clean-up for anything a player types that others will see: NFC,
 * invisible characters out, whitespace collapsed. Line breaks and the other
 * separators become spaces first, so a pasted two-liner keeps its word break.
 */
export function cleanText(raw: string, mode: "text" | "name" = "text"): string {
  return raw
    .normalize("NFC")
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, " ")
    .replace(INVISIBLE, (c) => (mode === "text" && KEEP_IN_TEXT.has(c) ? c : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse runs of whitespace, strip the invisible, and trim. What gets displayed. */
export function normalizeCharName(raw: string): string {
  return cleanText(raw, "name");
}

/**
 * The key uniqueness is checked against. `char_name` is the ONLY identity that
 * reaches the client, so two players called Thalgrim would make the roster,
 * the bingo call-out and the winner ranking ambiguous for the whole night.
 * `Thalgrim`, `thalgrim` and `Thal grim` are all the same person to this.
 */
export function charNameKey(raw: string): string {
  // NFKC folds compatibility forms — fullwidth Ｔ, ligatures, superscripts —
  // onto the letter they draw as.
  return cleanText(normalizeCharName(raw).normalize("NFKC"), "name").toLowerCase().replaceAll(" ", "");
}

/**
 * Latin next to Cyrillic or Greek in one name is how `Thаlgrim` (Cyrillic а)
 * passes for `Thalgrim`. Each script alone is fine.
 */
function mixesLookalikeScripts(name: string): boolean {
  return /\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name);
}

export function validateCharName(raw: string): Result<string> {
  const name = normalizeCharName(raw);
  if (name === "") return bad("Enter the character you're raiding on.");
  if (name.length > CHAR_NAME_MAX) {
    return bad(`Character names are at most ${CHAR_NAME_MAX} characters.`);
  }
  if (!/[\p{L}\p{N}]/u.test(name)) return bad("That name has no letters in it.");
  if (mixesLookalikeScripts(name)) {
    return bad("That name mixes Latin letters with Cyrillic or Greek ones. Use one alphabet.");
  }
  return ok(name);
}

export function validateTitle(raw: string): Result<string> {
  const title = cleanText(raw);
  if (title === "") return bad("Give the game a title — it's what people see in Discord.");
  if (title.length > TITLE_MAX) return bad(`Titles are at most ${TITLE_MAX} characters.`);
  return ok(title);
}

/**
 * Chat cap, in UTF-16 code units: `.length`, the same unit an input's
 * `maxlength` counts, so the field and the server never disagree about an
 * emoji.
 */
export const CHAT_MAX = 300;

/**
 * There is deliberately no blocklist of code-looking text: `<3` and `>inv`
 * are banter. Rendering through textContent is the injection defence.
 */
export function validateMessage(raw: unknown): Result<string> {
  if (typeof raw !== "string") return bad("A message has to be text.");
  const text = cleanText(raw);
  if (text === "" || !/[\p{L}\p{N}\p{P}\p{S}]/u.test(text)) return bad("Type something first.");
  if (text.length > CHAT_MAX) return bad(`Messages are at most ${CHAT_MAX} characters.`);
  return ok(text);
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
  const items = raw.map((s) => cleanText(s));
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
