/**
 * SQLite implementation of the Repository seam, on the built-in `node:sqlite`
 * so there is no native dependency to compile in a container.
 *
 * The interface is async although SQLite here is synchronous: that is what
 * lets a Postgres implementation slot in later without touching callers.
 *
 * Two constraints are enforced by the schema rather than by application code,
 * because they are the ones that matter:
 *   - `calls` is keyed on (game_id, item_idx), so a call is idempotent and an
 *     undo is a plain delete. Retrying a call that already landed cannot
 *     double-fire.
 *   - `game_players` has a UNIQUE index on (game_id, char_name_key), so two
 *     players in one game cannot share a name even if a check races.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  Repository, PlayerRow, GameRow, GamePlayerRow, SessionRow,
} from "./ports.ts";
import { charNameKey } from "../shared/validate.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  pid            TEXT PRIMARY KEY,
  last_name_used TEXT,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  pid        TEXT NOT NULL REFERENCES players(pid) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_pid ON sessions(pid);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS games (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  owner_pid    TEXT NOT NULL REFERENCES players(pid),
  items_json   TEXT NOT NULL,
  items_frozen INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS games_owner ON games(owner_pid, created_at DESC);

CREATE TABLE IF NOT EXISTS game_players (
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  pid           TEXT NOT NULL REFERENCES players(pid),
  char_name     TEXT NOT NULL,
  char_name_key TEXT NOT NULL,
  board_json    TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  bingo_at      INTEGER,
  PRIMARY KEY (game_id, pid)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS game_players_name
  ON game_players(game_id, char_name_key);
CREATE INDEX IF NOT EXISTS game_players_pid ON game_players(pid);

CREATE TABLE IF NOT EXISTS calls (
  game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  item_idx  INTEGER NOT NULL,
  called_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, item_idx)
) STRICT;
`;

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const maybeNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const maybeStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const toPlayer = (r: Row): PlayerRow => ({
  pid: str(r["pid"]),
  lastNameUsed: maybeStr(r["last_name_used"]),
  createdAt: num(r["created_at"]),
  lastSeen: num(r["last_seen"]),
});

const toGame = (r: Row): GameRow => ({
  id: str(r["id"]),
  title: str(r["title"]),
  ownerPid: str(r["owner_pid"]),
  items: JSON.parse(str(r["items_json"])) as string[],
  itemsFrozen: num(r["items_frozen"]) === 1,
  createdAt: num(r["created_at"]),
  closedAt: maybeNum(r["closed_at"]),
});

const toGamePlayer = (r: Row): GamePlayerRow => ({
  gameId: str(r["game_id"]),
  pid: str(r["pid"]),
  charName: str(r["char_name"]),
  board: JSON.parse(str(r["board_json"])) as number[],
  joinedAt: num(r["joined_at"]),
  bingoAt: maybeNum(r["bingo_at"]),
});

export function createRepository(db: DatabaseSync): Repository {
  const q = {
    upsertPlayer: db.prepare(
      `INSERT INTO players (pid, last_name_used, created_at, last_seen)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(pid) DO UPDATE SET last_seen = excluded.last_seen`),
    getPlayer: db.prepare(`SELECT * FROM players WHERE pid = ?`),
    setLastName: db.prepare(`UPDATE players SET last_name_used = ? WHERE pid = ?`),

    createSession: db.prepare(
      `INSERT INTO sessions (token_hash, pid, created_at, expires_at) VALUES (?, ?, ?, ?)`),
    findSession: db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),

    createGame: db.prepare(
      `INSERT INTO games (id, title, owner_pid, items_json, items_frozen, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`),
    getGame: db.prepare(`SELECT * FROM games WHERE id = ?`),
    updateItems: db.prepare(`UPDATE games SET items_json = ? WHERE id = ? AND items_frozen = 0`),
    freezeItems: db.prepare(`UPDATE games SET items_frozen = 1 WHERE id = ?`),
    setTitle: db.prepare(`UPDATE games SET title = ? WHERE id = ?`),
    closeGame: db.prepare(`UPDATE games SET closed_at = ? WHERE id = ? AND closed_at IS NULL`),
    gamesForPlayer: db.prepare(
      `SELECT g.* FROM games g
       JOIN game_players gp ON gp.game_id = g.id
       WHERE gp.pid = ? ORDER BY g.created_at DESC`),
    previousSets: db.prepare(
      `SELECT * FROM games WHERE owner_pid = ? ORDER BY created_at DESC LIMIT ?`),

    addGamePlayer: db.prepare(
      `INSERT INTO game_players (game_id, pid, char_name, char_name_key, board_json, joined_at, bingo_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`),
    getGamePlayer: db.prepare(`SELECT * FROM game_players WHERE game_id = ? AND pid = ?`),
    roster: db.prepare(`SELECT * FROM game_players WHERE game_id = ? ORDER BY joined_at ASC`),
    nameTaken: db.prepare(
      `SELECT 1 FROM game_players WHERE game_id = ? AND char_name_key = ? LIMIT 1`),
    markBingo: db.prepare(
      `UPDATE game_players SET bingo_at = ? WHERE game_id = ? AND pid = ? AND bingo_at IS NULL`),

    addCall: db.prepare(
      `INSERT INTO calls (game_id, item_idx, called_at) VALUES (?, ?, ?)
       ON CONFLICT(game_id, item_idx) DO NOTHING`),
    removeCall: db.prepare(`DELETE FROM calls WHERE game_id = ? AND item_idx = ?`),
    calls: db.prepare(`SELECT item_idx, called_at FROM calls WHERE game_id = ?`),
  };

  return {
    async upsertPlayer(pid, now) {
      q.upsertPlayer.run(pid, now, now);
      return toPlayer(q.getPlayer.get(pid) as Row);
    },
    async getPlayer(pid) {
      const r = q.getPlayer.get(pid) as Row | undefined;
      return r ? toPlayer(r) : null;
    },
    async setLastNameUsed(pid, name) {
      q.setLastName.run(name, pid);
    },

    async createSession(row) {
      q.createSession.run(row.tokenHash, row.pid, row.createdAt, row.expiresAt);
    },
    async findSession(tokenHash, now) {
      const r = q.findSession.get(tokenHash, now) as Row | undefined;
      return r
        ? {
            tokenHash: str(r["token_hash"]),
            pid: str(r["pid"]),
            createdAt: num(r["created_at"]),
            expiresAt: num(r["expires_at"]),
          }
        : null;
    },
    async deleteSession(tokenHash) {
      q.deleteSession.run(tokenHash);
    },

    async createGame(row) {
      q.createGame.run(
        row.id, row.title, row.ownerPid, JSON.stringify(row.items),
        row.itemsFrozen ? 1 : 0, row.createdAt,
      );
    },
    async getGame(id) {
      const r = q.getGame.get(id) as Row | undefined;
      return r ? toGame(r) : null;
    },
    async updateGameItems(id, items) {
      q.updateItems.run(JSON.stringify(items), id);
    },
    async freezeGameItems(id) {
      q.freezeItems.run(id);
    },
    async setGameTitle(id, title) {
      q.setTitle.run(title, id);
    },
    async closeGame(id, now) {
      q.closeGame.run(now, id);
    },
    async gamesForPlayer(pid) {
      return (q.gamesForPlayer.all(pid) as Row[]).map(toGame);
    },
    async previousItemSets(ownerPid, limit) {
      return (q.previousSets.all(ownerPid, limit) as Row[]).map(toGame);
    },

    async addGamePlayer(row) {
      q.addGamePlayer.run(
        row.gameId, row.pid, row.charName, charNameKey(row.charName),
        JSON.stringify(row.board), row.joinedAt,
      );
    },
    async getGamePlayer(gameId, pid) {
      const r = q.getGamePlayer.get(gameId, pid) as Row | undefined;
      return r ? toGamePlayer(r) : null;
    },
    async rosterFor(gameId) {
      return (q.roster.all(gameId) as Row[]).map(toGamePlayer);
    },
    async isNameTaken(gameId, charName) {
      return q.nameTaken.get(gameId, charNameKey(charName)) !== undefined;
    },
    async markBingo(gameId, pid, at) {
      q.markBingo.run(at, gameId, pid);
    },

    async addCall(gameId, itemIndex, at) {
      q.addCall.run(gameId, itemIndex, at);
    },
    async removeCall(gameId, itemIndex) {
      q.removeCall.run(gameId, itemIndex);
    },
    async callsFor(gameId) {
      const out = new Map<number, number>();
      for (const r of q.calls.all(gameId) as Row[]) {
        out.set(num(r["item_idx"]), num(r["called_at"]));
      }
      return out;
    },
  };
}
