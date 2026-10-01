/**
 * The other two of the four seams. Both are interfaces so tests can supply a
 * recording fake — no test ever touches the real Discord API, and no test
 * needs a database file on disk.
 */

import type { Theme } from "../shared/validate.ts";

/** What we ask Discord for, and the only thing we take back. */
export interface DiscordPort {
  /** The url to send the browser to. `state` is echoed back to the callback. */
  authorizeUrl(state: string): string;

  /**
   * Exchange an OAuth code for the user's Discord id.
   *
   * Returns the id ONLY. The profile payload is not returned, stored or
   * logged: everything downstream works from HMAC(discordUserId), and the
   * display name is typed by the player.
   */
  exchangeCode(code: string): Promise<{ discordUserId: string }>;
}

export interface PlayerRow {
  pid: string;
  lastNameUsed: string | null;
  theme: Theme;
  createdAt: number;
  lastSeen: number;
}

export interface GameRow {
  id: string;
  title: string;
  ownerPid: string;
  items: string[];
  itemsFrozen: boolean;
  createdAt: number;
  closedAt: number | null;
  /** The last chat `seq` issued. Nothing deletes a message, so also the count. */
  chatSeq: number;
}

export interface GamePlayerRow {
  gameId: string;
  pid: string;
  charName: string;
  board: number[];
  joinedAt: number;
  bingoAt: number | null;
  /** Granted by the owner. The owner always may, without a row flag. */
  canCall: boolean;
}

/** `charName` is resolved from the roster at read time. `pid` never leaves the server. */
export interface MessageRow {
  gameId: string;
  seq: number;
  pid: string;
  charName: string;
  text: string;
  sentAt: number;
}

export interface SessionRow {
  tokenHash: string;
  pid: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Every read and write goes through here, with plain SQL behind it. This is
 * the seam that lets tests run against in-memory SQLite, and the one that
 * would let SQLite be swapped for Postgres as a second implementation rather
 * than a rewrite.
 */
export interface Repository {
  upsertPlayer(pid: string, now: number): Promise<PlayerRow>;
  getPlayer(pid: string): Promise<PlayerRow | null>;
  setLastNameUsed(pid: string, name: string): Promise<void>;
  setTheme(pid: string, theme: Theme): Promise<void>;

  createSession(row: SessionRow): Promise<void>;
  findSession(tokenHash: string, now: number): Promise<SessionRow | null>;
  deleteSession(tokenHash: string): Promise<void>;

  /** A new game has issued no chat `seq` yet, so `chatSeq` is not the caller's to set. */
  createGame(row: Omit<GameRow, "chatSeq">): Promise<void>;
  getGame(id: string): Promise<GameRow | null>;
  updateGameItems(id: string, items: string[]): Promise<void>;
  freezeGameItems(id: string): Promise<void>;
  setGameTitle(id: string, title: string): Promise<void>;
  closeGame(id: string, now: number): Promise<void>;
  gamesForPlayer(pid: string): Promise<GameRow[]>;
  previousItemSets(ownerPid: string, limit: number): Promise<GameRow[]>;

  addGamePlayer(row: GamePlayerRow): Promise<void>;
  getGamePlayer(gameId: string, pid: string): Promise<GamePlayerRow | null>;
  rosterFor(gameId: string): Promise<GamePlayerRow[]>;
  /** Case-insensitive, whitespace-collapsed. `char_name` is the only visible identity. */
  isNameTaken(gameId: string, charName: string): Promise<boolean>;
  /** Resolve a roster member by the only identity the client ever sees. */
  findByCharName(gameId: string, charName: string): Promise<GamePlayerRow | null>;
  setCanCall(gameId: string, pid: string, canCall: boolean): Promise<void>;
  markBingo(gameId: string, pid: string, at: number): Promise<void>;
  /** Undoing the call a line depended on takes the bingo back with it. */
  clearBingo(gameId: string, pid: string): Promise<void>;

  /** Idempotent: calling an already-called square is a no-op, not an error. */
  addCall(gameId: string, itemIndex: number, at: number): Promise<void>;
  removeCall(gameId: string, itemIndex: number): Promise<void>;
  callsFor(gameId: string): Promise<Map<number, number>>;

  /**
   * Issues the next per-game `seq` and inserts, in one transaction. Returns
   * null, inserting nothing, when the game already holds `ceiling` messages:
   * the check is part of the same UPDATE, so two posts racing at the limit
   * cannot both land.
   */
  addMessage(gameId: string, pid: string, text: string, at: number, ceiling: number): Promise<MessageRow | null>;
  /** The last `limit` with seq > afterSeq, ascending. */
  messagesAfter(gameId: string, afterSeq: number, limit: number): Promise<MessageRow[]>;
  /** The last `limit` with seq < beforeSeq, ascending. How older history is reached. */
  messagesBefore(gameId: string, beforeSeq: number, limit: number): Promise<MessageRow[]>;
}
