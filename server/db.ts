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
 *
 * Chat `seq` is issued from `games.chat_seq` by an UPDATE ... RETURNING in
 * the same transaction as the insert. The update takes the game's row lock,
 * so the same SQL stays correct on Postgres, where MAX(seq) + 1 would let two
 * concurrent posts collide.
 */

import { DatabaseSync } from "node:sqlite";
import type {
  Repository, PlayerRow, GameRow, GamePlayerRow, SessionRow, MessageRow,
} from "./ports.ts";
import { charNameKey, isTheme } from "../shared/validate.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  pid            TEXT PRIMARY KEY,
  last_name_used TEXT,
  theme          TEXT NOT NULL DEFAULT 'auto',
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
  closed_at    INTEGER,
  chat_seq     INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0
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
  can_call      INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS messages (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  pid     TEXT NOT NULL REFERENCES players(pid),
  text    TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, seq)
) STRICT;
`;

const SCHEMA_VERSION = 6;

/**
 * Schema changes have to reach databases that already hold real games, so
 * CREATE TABLE IF NOT EXISTS is not enough on its own. Each step is written to
 * be safe to run twice.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const from = Number(row?.user_version ?? 0);
  if (from >= SCHEMA_VERSION) return;

  if (from < 2) {
    const columns = db.prepare("PRAGMA table_info(game_players)").all() as { name?: unknown }[];
    if (!columns.some((c) => String(c["name"]) === "can_call")) {
      db.exec("ALTER TABLE game_players ADD COLUMN can_call INTEGER NOT NULL DEFAULT 0");
    }
  }

  // The messages table arrives with SCHEMA's CREATE IF NOT EXISTS; the counter
  // has to be added to games that already exist.
  if (from < 3) {
    const columns = db.prepare("PRAGMA table_info(games)").all() as { name?: unknown }[];
    if (!columns.some((c) => String(c["name"]) === "chat_seq")) {
      db.exec("ALTER TABLE games ADD COLUMN chat_seq INTEGER NOT NULL DEFAULT 0");
    }
  }

  if (from < 4) {
    const columns = db.prepare("PRAGMA table_info(players)").all() as { name?: unknown }[];
    if (!columns.some((c) => String(c["name"]) === "theme")) {
      db.exec("ALTER TABLE players ADD COLUMN theme TEXT NOT NULL DEFAULT 'auto'");
    }
  }

  // The uniqueness key gained NFKC and invisible-character stripping (#11),
  // so keys written before it are recomputed. OR IGNORE: if two existing
  // players now share a key — the impersonation this closes — both keep
  // their seats and the later one keeps its old key, rather than the
  // migration failing on the unique index and taking the app down.
  if (from < 5) {
    const rows = db.prepare("SELECT game_id, pid, char_name FROM game_players ORDER BY joined_at").all() as Row[];
    const rekey = db.prepare("UPDATE OR IGNORE game_players SET char_name_key = ? WHERE game_id = ? AND pid = ?");
    for (const r of rows) rekey.run(charNameKey(String(r["char_name"])), String(r["game_id"]), String(r["pid"]));
  }

  // The idle clock gets its own column (#13). Backfilled from what idleness
  // was measured by until now, so no existing game closes or reopens.
  if (from < 6) {
    const columns = db.prepare("PRAGMA table_info(games)").all() as { name?: unknown }[];
    if (!columns.some((c) => String(c["name"]) === "last_activity_at")) {
      db.exec("ALTER TABLE games ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`UPDATE games SET last_activity_at = MAX(created_at,
      COALESCE((SELECT MAX(called_at) FROM calls WHERE calls.game_id = games.id), 0))
      WHERE last_activity_at = 0`);
  }

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
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
  // A value this build does not know falls back to following the device.
  theme: isTheme(r["theme"]) ? r["theme"] : "auto",
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
  chatSeq: num(r["chat_seq"]),
  lastActivityAt: num(r["last_activity_at"]),
});

const toMessage = (r: Row): MessageRow => ({
  gameId: str(r["game_id"]),
  seq: num(r["seq"]),
  pid: str(r["pid"]),
  charName: str(r["char_name"]),
  text: str(r["text"]),
  sentAt: num(r["sent_at"]),
});

/** The sender's name comes from the roster at read time; pid stays server-side. */
const MESSAGE_COLUMNS = `m.game_id, m.seq, m.pid, gp.char_name, m.text, m.sent_at
       FROM messages m
       JOIN game_players gp ON gp.game_id = m.game_id AND gp.pid = m.pid`;

const toGamePlayer = (r: Row): GamePlayerRow => ({
  gameId: str(r["game_id"]),
  pid: str(r["pid"]),
  charName: str(r["char_name"]),
  board: JSON.parse(str(r["board_json"])) as number[],
  joinedAt: num(r["joined_at"]),
  bingoAt: maybeNum(r["bingo_at"]),
  canCall: num(r["can_call"]) === 1,
});

export function createRepository(db: DatabaseSync): Repository {
  const q = {
    upsertPlayer: db.prepare(
      `INSERT INTO players (pid, last_name_used, created_at, last_seen)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(pid) DO UPDATE SET last_seen = excluded.last_seen`),
    getPlayer: db.prepare(`SELECT * FROM players WHERE pid = ?`),
    setLastName: db.prepare(`UPDATE players SET last_name_used = ? WHERE pid = ?`),
    setTheme: db.prepare(`UPDATE players SET theme = ? WHERE pid = ?`),

    createSession: db.prepare(
      `INSERT INTO sessions (token_hash, pid, created_at, expires_at) VALUES (?, ?, ?, ?)`),
    findSession: db.prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    // <= because findSession treats expires_at = now as already expired.
    deleteExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),

    createGame: db.prepare(
      `INSERT INTO games (id, title, owner_pid, items_json, items_frozen, created_at, closed_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`),
    getGame: db.prepare(`SELECT * FROM games WHERE id = ?`),
    updateItems: db.prepare(`UPDATE games SET items_json = ? WHERE id = ? AND items_frozen = 0`),
    freezeItems: db.prepare(`UPDATE games SET items_frozen = 1 WHERE id = ?`),
    setTitle: db.prepare(`UPDATE games SET title = ? WHERE id = ?`),
    closeGame: db.prepare(`UPDATE games SET closed_at = ? WHERE id = ? AND closed_at IS NULL`),
    touchGame: db.prepare(`UPDATE games SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`),
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
    byName: db.prepare(
      `SELECT * FROM game_players WHERE game_id = ? AND char_name_key = ?`),
    setCanCall: db.prepare(
      `UPDATE game_players SET can_call = ? WHERE game_id = ? AND pid = ?`),
    markBingo: db.prepare(
      `UPDATE game_players SET bingo_at = ? WHERE game_id = ? AND pid = ? AND bingo_at IS NULL`),
    clearBingo: db.prepare(
      `UPDATE game_players SET bingo_at = NULL WHERE game_id = ? AND pid = ?`),

    addCall: db.prepare(
      `INSERT INTO calls (game_id, item_idx, called_at) VALUES (?, ?, ?)
       ON CONFLICT(game_id, item_idx) DO NOTHING`),
    removeCall: db.prepare(`DELETE FROM calls WHERE game_id = ? AND item_idx = ?`),
    calls: db.prepare(`SELECT item_idx, called_at FROM calls WHERE game_id = ?`),

    nextChatSeq: db.prepare(
      `UPDATE games SET chat_seq = chat_seq + 1
       WHERE id = ? AND chat_seq < ? RETURNING chat_seq`),
    addMessage: db.prepare(
      `INSERT INTO messages (game_id, seq, pid, text, sent_at) VALUES (?, ?, ?, ?, ?)`),
    message: db.prepare(`SELECT ${MESSAGE_COLUMNS} WHERE m.game_id = ? AND m.seq = ?`),
    // The LAST `limit` on each side of the cursor, re-sorted ascending.
    messagesAfter: db.prepare(
      `SELECT * FROM (SELECT ${MESSAGE_COLUMNS}
         WHERE m.game_id = ? AND m.seq > ? ORDER BY m.seq DESC LIMIT ?)
       ORDER BY seq ASC`),
    messagesBefore: db.prepare(
      `SELECT * FROM (SELECT ${MESSAGE_COLUMNS}
         WHERE m.game_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?)
       ORDER BY seq ASC`),
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

    async setTheme(pid, theme) {
      q.setTheme.run(theme, pid);
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
    async deleteExpiredSessions(now) {
      return Number(q.deleteExpiredSessions.run(now).changes);
    },

    async createGame(row) {
      q.createGame.run(
        row.id, row.title, row.ownerPid, JSON.stringify(row.items),
        row.itemsFrozen ? 1 : 0, row.createdAt, row.createdAt,
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
    async touchGame(id, at) {
      q.touchGame.run(at, id);
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
    async findByCharName(gameId, charName) {
      const r = q.byName.get(gameId, charNameKey(charName)) as Row | undefined;
      return r ? toGamePlayer(r) : null;
    },
    async setCanCall(gameId, pid, canCall) {
      q.setCanCall.run(canCall ? 1 : 0, gameId, pid);
    },
    async markBingo(gameId, pid, at) {
      q.markBingo.run(at, gameId, pid);
    },
    async clearBingo(gameId, pid) {
      q.clearBingo.run(gameId, pid);
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

    async addMessage(gameId, pid, text, at, ceiling) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const next = q.nextChatSeq.get(gameId, ceiling) as Row | undefined;
        if (next === undefined) {
          db.exec("ROLLBACK");
          return null;
        }
        const seq = num(next["chat_seq"]);
        q.addMessage.run(gameId, seq, pid, text, at);
        db.exec("COMMIT");
        return toMessage(q.message.get(gameId, seq) as Row);
      } catch (e) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw e;
      }
    },
    async messagesAfter(gameId, afterSeq, limit) {
      return (q.messagesAfter.all(gameId, afterSeq, limit) as Row[]).map(toMessage);
    },
    async messagesBefore(gameId, beforeSeq, limit) {
      return (q.messagesBefore.all(gameId, beforeSeq, limit) as Row[]).map(toMessage);
    },
  };
}
