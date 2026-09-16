/**
 * Every rule that is not enforced by the schema lives here, so routes stay
 * thin and the rules stay testable without HTTP.
 */

import type { Repository, GameRow } from "./ports.ts";
import type { Clock, Rng } from "../shared/seams.ts";
import { dealUniqueBoard, hasBingo, markCount, bestLineOf, ITEM_COUNT } from "../shared/board.ts";
import { generateId } from "../shared/ids.ts";
import { checkItems, validateCharName, validateTitle, normalizeCharName } from "../shared/validate.ts";

export const IDLE_CLOSE_MS = 8 * 60 * 60 * 1000;
export const GAMES_PER_DAY = 5;
export const MAX_PREVIOUS_SETS = 8;

export type ErrorCode =
  | "not_found" | "forbidden" | "closed" | "frozen"
  | "name_taken" | "invalid" | "rate_limited" | "already_joined";

export interface ServiceError {
  code: ErrorCode;
  message: string;
  /** For a name collision: alternatives already checked against the roster. */
  suggestions?: string[];
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ServiceError };

const ok = <T,>(value: T): Result<T> => ({ ok: true, value });
const err = (code: ErrorCode, message: string, extra?: Partial<ServiceError>): Result<never> =>
  ({ ok: false, error: { code, message, ...extra } });

export interface RosterEntry {
  charName: string;
  /**
   * The most marks on any one line, 0-5.
   *
   * NOT a mark count: every player holds all 24 items and calls are global, so
   * everyone always has exactly `called + 1` marks. Arrangement is the only
   * variable, so how close someone is to a line is the only thing worth
   * ranking on.
   */
  bestLine: number;
  bingoAt: number | null;
  /** True for the viewer's own row, so the client can highlight it. */
  you: boolean;
  /** May call and undo. Always true for the owner. */
  canCall: boolean;
  /** The owner, who may also grant calling, edit the title and close. */
  isOwner: boolean;
  /** Their dealt board, so others can see how close they are. Fixed at join. */
  board: number[];
}

export interface GameView {
  id: string;
  title: string;
  closed: boolean;
  isOwner: boolean;
  /** Whether the VIEWER may call and undo — owner, or granted by them. */
  canCall: boolean;
  items: string[];
  itemsFrozen: boolean;
  /** null when the viewer has not joined yet. */
  board: number[] | null;
  charName: string | null;
  /** item index -> when it was called. */
  called: [number, number][];
  roster: RosterEntry[];
}

export interface GameSummary {
  id: string;
  title: string;
  closed: boolean;
  isOwner: boolean;
  charName: string;
  called: number;
  marks: number;
  players: number;
  bingoAt: number | null;
  createdAt: number;
}

export class GameService {
  readonly #repo: Repository;
  readonly #clock: Clock;
  readonly #rng: Rng;
  /** Game creations per pid, for the daily cap. Resets on restart; fine. */
  readonly #creations = new Map<string, number[]>();

  constructor(repo: Repository, clock: Clock, rng: Rng) {
    this.#repo = repo;
    this.#clock = clock;
    this.#rng = rng;
  }

  /** A game is closed if it was closed explicitly, or has gone quiet for 8h. */
  async #liveGame(id: string): Promise<GameRow | null> {
    const game = await this.#repo.getGame(id);
    if (game === null) return null;
    if (game.closedAt !== null) return game;

    const calls = await this.#repo.callsFor(id);
    const last = Math.max(game.createdAt, ...calls.values());
    if (this.#clock.now() - last > IDLE_CLOSE_MS) {
      await this.#repo.closeGame(id, last + IDLE_CLOSE_MS);
      return await this.#repo.getGame(id);
    }
    return game;
  }

  async createGame(pid: string, rawTitle: string, rawItems: string[]): Promise<Result<string>> {
    const now = this.#clock.now();
    const recent = (this.#creations.get(pid) ?? []).filter((t) => now - t < 24 * 60 * 60 * 1000);
    if (recent.length >= GAMES_PER_DAY) {
      const oldest = recent[0] as number;
      const mins = Math.ceil((24 * 60 * 60 * 1000 - (now - oldest)) / 60000);
      return err("rate_limited", `You've started ${GAMES_PER_DAY} games today. You can start another in about ${mins} minutes.`);
    }

    const title = validateTitle(rawTitle);
    if (!title.ok) return err("invalid", title.reason);

    const check = checkItems(rawItems);
    if (rawItems.length !== ITEM_COUNT) {
      return err("invalid", `A game needs exactly ${ITEM_COUNT} squares — you have ${check.filled}.`);
    }
    if (!check.ok) {
      const first = check.problems[0];
      return err("invalid", first ? `Square ${first.index + 1}: ${first.message}` : "Check the squares.");
    }

    let id = generateId(this.#rng);
    for (let i = 0; i < 20 && (await this.#repo.getGame(id)) !== null; i++) {
      id = generateId(this.#rng);
    }

    await this.#repo.createGame({
      id, title: title.value, ownerPid: pid, items: check.items,
      itemsFrozen: false, createdAt: now, closedAt: null,
    });
    this.#creations.set(pid, [...recent, now]);
    return ok(id);
  }

  async setItems(pid: string, gameId: string, rawItems: string[]): Promise<Result<null>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (game.ownerPid !== pid) return err("forbidden", "Only the game's owner can change the squares.");
    if (game.closedAt !== null) return err("closed", "That game is closed.");
    if (game.itemsFrozen) {
      return err("frozen", "The squares locked when the first player joined — boards point at them.");
    }
    const check = checkItems(rawItems);
    if (rawItems.length !== ITEM_COUNT || !check.ok) {
      const first = check.problems[0];
      return err("invalid", first ? `Square ${first.index + 1}: ${first.message}` : `A game needs exactly ${ITEM_COUNT} squares.`);
    }
    await this.#repo.updateGameItems(gameId, check.items);
    return ok(null);
  }

  async setTitle(pid: string, gameId: string, rawTitle: string): Promise<Result<string>> {
    const game = await this.#repo.getGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (game.ownerPid !== pid) return err("forbidden", "Only the game's owner can rename it.");
    const title = validateTitle(rawTitle);
    if (!title.ok) return err("invalid", title.reason);
    await this.#repo.setGameTitle(gameId, title.value);
    return ok(title.value);
  }

  async closeGame(pid: string, gameId: string): Promise<Result<null>> {
    const game = await this.#repo.getGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (game.ownerPid !== pid) return err("forbidden", "Only the game's owner can close it.");
    await this.#repo.closeGame(gameId, this.#clock.now());
    return ok(null);
  }

  /** Alternatives that are actually free, so the UI never offers a taken one. */
  async #suggestNames(gameId: string, name: string): Promise<string[]> {
    const out: string[] = [];
    const numerals = ["II", "III", "IV", "V"];
    for (const n of numerals) {
      const candidate = `${name} ${n}`;
      if (!(await this.#repo.isNameTaken(gameId, candidate))) { out.push(candidate); break; }
    }
    const last = name.at(-1) ?? "";
    if (/[a-z]/i.test(last) && !"aeiou".includes(last.toLowerCase())) {
      const doubled = name + last;
      if (!(await this.#repo.isNameTaken(gameId, doubled))) out.push(doubled);
    } else {
      const second = `${name} the Second`;
      if (!(await this.#repo.isNameTaken(gameId, second))) out.push(second);
    }
    return out.slice(0, 2);
  }

  async joinGame(pid: string, gameId: string, rawName: string): Promise<Result<GameView>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (game.closedAt !== null) return err("closed", "That game is closed.");

    const existing = await this.#repo.getGamePlayer(gameId, pid);
    if (existing !== null) return await this.view(pid, gameId);

    const name = validateCharName(rawName);
    if (!name.ok) return err("invalid", name.reason);
    if (await this.#repo.isNameTaken(gameId, name.value)) {
      return err("name_taken",
        `Someone in this game is already playing as ${name.value}.`,
        { suggestions: await this.#suggestNames(gameId, name.value) });
    }

    const now = this.#clock.now();
    // The owner takes a board through this same gate, so only a NON-owner
    // join may freeze the item list — otherwise editing would end before it
    // began.
    if (!game.itemsFrozen && game.ownerPid !== pid) {
      await this.#repo.freezeGameItems(gameId);
    }

    // No two players in one game hold the same board, by construction.
    const taken = (await this.#repo.rosterFor(gameId)).map((r) => r.board);
    await this.#repo.addGamePlayer({
      gameId, pid, charName: normalizeCharName(name.value),
      board: dealUniqueBoard(this.#rng, taken), joinedAt: now, bingoAt: null, canCall: false,
    });
    await this.#repo.setLastNameUsed(pid, normalizeCharName(name.value));

    // A late joiner inherits every call already made, which can be an
    // instant bingo.
    await this.#reconcileBingos(gameId);
    return await this.view(pid, gameId);
  }

  /**
   * Bring every player's bingo into line with the calls that actually stand.
   *
   * Run after a call AND after an undo: an undo has to leave no trace, so a
   * bingo that depended on the undone call is taken back with it. A player who
   * still holds a line some other way keeps theirs, and their original time.
   *
   * Returns the character names that newly completed a line.
   */
  async #reconcileBingos(gameId: string): Promise<string[]> {
    const called = new Set((await this.#repo.callsFor(gameId)).keys());
    const now = this.#clock.now();
    const fresh: string[] = [];
    for (const row of await this.#repo.rosterFor(gameId)) {
      const won = hasBingo(row.board, called);
      if (won && row.bingoAt === null) {
        await this.#repo.markBingo(gameId, row.pid, now);
        fresh.push(row.charName);
      } else if (!won && row.bingoAt !== null) {
        await this.#repo.clearBingo(gameId, row.pid);
      }
    }
    return fresh;
  }

  /** The owner always may; anyone else needs the flag the owner sets. */
  async #mayCall(gameId: string, ownerPid: string, pid: string): Promise<boolean> {
    if (ownerPid === pid) return true;
    const row = await this.#repo.getGamePlayer(gameId, pid);
    return row?.canCall === true;
  }

  /**
   * The owner hands calling to someone else — a second caller for the night,
   * so they are not tied to their phone. Only the owner may grant it, and
   * granting does not pass on the power to grant.
   *
   * The player is named by `charName` because that is the only identity the
   * client ever sees; it resolves because names are unique within a game.
   */
  async setCaller(pid: string, gameId: string, charName: string, canCall: boolean): Promise<Result<string>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (game.ownerPid !== pid) return err("forbidden", "Only the game's owner can hand out calling.");
    if (game.closedAt !== null) return err("closed", "That game is closed.");

    const target = await this.#repo.findByCharName(gameId, charName);
    if (target === null) return err("not_found", `${charName} isn't in this game.`);
    if (target.pid === game.ownerPid) {
      return err("invalid", "You're the owner — you can always call.");
    }

    await this.#repo.setCanCall(gameId, target.pid, canCall);
    return ok(target.charName);
  }

  async call(pid: string, gameId: string, itemIndex: number): Promise<Result<{ winners: string[] }>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (!(await this.#mayCall(gameId, game.ownerPid, pid))) {
      return err("forbidden", "You're not a caller for this game.");
    }
    if (game.closedAt !== null) return err("closed", "That game is closed. No more calls.");
    if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= ITEM_COUNT) {
      return err("invalid", "That square isn't on this board.");
    }
    // Idempotent by primary key, so the reflex double-tap is safe.
    await this.#repo.addCall(gameId, itemIndex, this.#clock.now());
    return ok({ winners: await this.#reconcileBingos(gameId) });
  }

  async undo(pid: string, gameId: string, itemIndex: number): Promise<Result<null>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");
    if (!(await this.#mayCall(gameId, game.ownerPid, pid))) {
      return err("forbidden", "You're not a caller for this game.");
    }
    if (game.closedAt !== null) return err("closed", "That game is closed.");
    await this.#repo.removeCall(gameId, itemIndex);
    // An undo means it never happened, so any bingo that rested on this call
    // goes with it.
    await this.#reconcileBingos(gameId);
    return ok(null);
  }

  async view(pid: string, gameId: string): Promise<Result<GameView>> {
    const game = await this.#liveGame(gameId);
    if (game === null) return err("not_found", "That game doesn't exist.");

    const calls = await this.#repo.callsFor(gameId);
    const called = new Set(calls.keys());
    const roster = await this.#repo.rosterFor(gameId);
    const mine = roster.find((r) => r.pid === pid) ?? null;

    return ok({
      id: game.id,
      title: game.title,
      closed: game.closedAt !== null,
      isOwner: game.ownerPid === pid,
      canCall: game.ownerPid === pid || mine?.canCall === true,
      items: game.items,
      itemsFrozen: game.itemsFrozen,
      board: mine?.board ?? null,
      charName: mine?.charName ?? null,
      called: [...calls.entries()].sort((a, b) => a[1] - b[1]),
      // pid is never included: char_name is the only identity the client sees.
      roster: roster
        .map((r) => ({
          charName: r.charName,
          bestLine: bestLineOf(r.board, called),
          bingoAt: r.bingoAt,
          you: r.pid === pid,
          canCall: r.pid === game.ownerPid || r.canCall,
          isOwner: r.pid === game.ownerPid,
          board: r.board,
        }))
        .sort((a, b) => {
          if ((a.bingoAt === null) !== (b.bingoAt === null)) return a.bingoAt === null ? 1 : -1;
          if (a.bingoAt !== null && b.bingoAt !== null) return a.bingoAt - b.bingoAt;
          return b.bestLine - a.bestLine;
        }),
    });
  }

  async lobby(pid: string): Promise<{ active: GameSummary[]; past: GameSummary[] }> {
    const games = await this.#repo.gamesForPlayer(pid);
    const active: GameSummary[] = [];
    const past: GameSummary[] = [];

    for (const game of games) {
      const live = await this.#liveGame(game.id);
      if (live === null) continue;
      const calls = await this.#repo.callsFor(game.id);
      const called = new Set(calls.keys());
      const roster = await this.#repo.rosterFor(game.id);
      const mine = roster.find((r) => r.pid === pid);
      if (mine === undefined) continue;

      const summary: GameSummary = {
        id: live.id,
        title: live.title,
        closed: live.closedAt !== null,
        isOwner: live.ownerPid === pid,
        charName: mine.charName,
        called: called.size,
        marks: markCount(mine.board, called),
        players: roster.length,
        bingoAt: mine.bingoAt,
        createdAt: live.createdAt,
      };
      (summary.closed ? past : active).push(summary);
    }
    return { active, past };
  }

  async previousItemSets(pid: string): Promise<{ id: string; title: string; createdAt: number; items: string[] }[]> {
    const games = await this.#repo.previousItemSets(pid, MAX_PREVIOUS_SETS);
    return games.map((g) => ({ id: g.id, title: g.title, createdAt: g.createdAt, items: g.items }));
  }
}
