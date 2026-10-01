import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, items, T0 } from "./helpers.ts";
import { openDatabase, createRepository } from "../server/db.ts";
import {
  CHAT_BURST, CHAT_CEILING, CHAT_PAGE, CHAT_WINDOW_MS, IDLE_CLOSE_MS,
} from "../server/game-service.ts";
import { validateMessage, CHAT_MAX } from "../shared/validate.ts";
import { timeline, type ChatMessage } from "../shared/timeline.ts";

const OWNER = "owner-pid";
const ALICE = "alice-pid";
const BOB = "bob-pid";

async function withPlayers() {
  const h = harness();
  for (const pid of [OWNER, ALICE, BOB]) await h.repo.upsertPlayer(pid, T0);
  const created = await h.service.createGame(OWNER, "Tuesday BT run", items());
  assert.ok(created.ok);
  const gameId = created.value;
  await h.service.joinGame(OWNER, gameId, "Felwarden");
  await h.service.joinGame(ALICE, gameId, "Thalgrim");
  return { ...h, gameId };
}

const textOf = (r: { ok: boolean; value?: string; reason?: string }) => (r.ok ? r.value : null);

/* ------------------------------------------------------------- validate */

test("a message must be a string", () => {
  for (const raw of [42, null, undefined, ["hi"], { text: "hi" }]) {
    assert.equal(validateMessage(raw).ok, false);
  }
});

test("a message is normalised to NFC", () => {
  // e + combining acute is the same letter as the precomposed é.
  assert.equal(textOf(validateMessage("café")), "café");
});

test("invisible and direction-spoofing characters are stripped", () => {
  assert.equal(textOf(validateMessage("a​b﻿c")), "abc");
  assert.equal(textOf(validateMessage("‮gnp.exe")), "gnp.exe");
  assert.equal(textOf(validateMessage("x⁦y⁩z")), "xyz");
  assert.equal(textOf(validateMessage("bell\u0007 and del\u007F")), "bell and del");
});

test("chat is single-line: every kind of break collapses to one space", () => {
  assert.equal(textOf(validateMessage("  wipe\n\nagain\r\nlol ok\tyes  ")), "wipe again lol ok yes");
});

test("an empty or invisible-only message is refused", () => {
  assert.equal(validateMessage("").ok, false);
  assert.equal(validateMessage("   \n ").ok, false);
  assert.equal(validateMessage("​‍").ok, false);
});

test("the cap is counted in code units, the unit maxlength uses", () => {
  assert.equal(validateMessage("x".repeat(CHAT_MAX)).ok, true);
  assert.equal(validateMessage("x".repeat(CHAT_MAX + 1)).ok, false);
  // An emoji is two code units, so 150 of them is exactly the cap.
  assert.equal(validateMessage("😀".repeat(CHAT_MAX / 2)).ok, true);
  assert.equal(validateMessage("😀".repeat(CHAT_MAX / 2) + "x").ok, false);
});

test("code-looking banter is allowed, untouched", () => {
  for (const raw of ["<3", ">inv", "{boss} pulled", "<script>alert(1)</script>"]) {
    assert.equal(textOf(validateMessage(raw)), raw);
  }
});

/* ------------------------------------------------------------- timeline */

const msg = (seq: number, at: number, text = `m${seq}`, charName = "Thalgrim"): ChatMessage =>
  ({ seq, at, text, charName });

test("events are ordered by time", () => {
  const events = timeline([[3, 200], [1, 100]], [{ charName: "A", bingoAt: 250 }], [msg(1, 150)], true);
  assert.deepEqual(events.map((e) => e.at), [100, 150, 200, 250]);
});

test("at the same instant: the call, then its bingo, then the reactions", () => {
  const events = timeline([[5, 100]], [{ charName: "A", bingoAt: 100 }], [msg(2, 100), msg(1, 100)], true);
  assert.deepEqual(events.map((e) => e.kind), ["call", "bingo", "message", "message"]);
  assert.deepEqual(events.filter((e) => e.kind === "message").map((e) => e.kind === "message" && e.seq), [1, 2]);
});

test("an undo removes its call and the bingo that rested on it", () => {
  const before = timeline([[5, 100]], [{ charName: "A", bingoAt: 100 }], [msg(1, 110)], true);
  assert.equal(before.length, 3);
  // What the next state push says after the undo: no call, no bingo.
  const after = timeline([], [{ charName: "A", bingoAt: null }], [msg(1, 110)], true);
  assert.deepEqual(after.map((e) => e.kind), ["message"]);
});

test("a bingo carries its own time and the winner's name", () => {
  const [event] = timeline([], [{ charName: "Thalgrim", bingoAt: 999 }], [], true);
  assert.deepEqual(event, { kind: "bingo", at: 999, charName: "Thalgrim" });
});

test("until the first message is loaded, older events are held back", () => {
  const called: [number, number][] = [[1, 50], [2, 150], [3, 250]];
  const partial = timeline(called, [], [msg(40, 100), msg(41, 200)], false);
  assert.deepEqual(partial.filter((e) => e.kind === "call").map((e) => e.at), [150, 250]);

  // With the whole chat loaded — or no chat at all — every event shows.
  assert.equal(timeline(called, [], [msg(40, 100)], true).filter((e) => e.kind === "call").length, 3);
  assert.equal(timeline(called, [], [], false).length, 3);
});

/* ------------------------------------------------------------- database */

test("an insert returns its seq and the sender's name, and advances chat_seq", async () => {
  const h = await withPlayers();
  const first = await h.repo.addMessage(h.gameId, ALICE, "pull already", T0 + 1, CHAT_CEILING);
  assert.deepEqual(first && { seq: first.seq, charName: first.charName, text: first.text, sentAt: first.sentAt },
    { seq: 1, charName: "Thalgrim", text: "pull already", sentAt: T0 + 1 });
  await h.repo.addMessage(h.gameId, OWNER, "patience", T0 + 2, CHAT_CEILING);
  assert.equal((await h.repo.getGame(h.gameId))?.chatSeq, 2);
});

test("seq is per game and starts at 1 in each", async () => {
  const h = await withPlayers();
  const other = await h.service.createGame(OWNER, "Wednesday", items());
  assert.ok(other.ok);
  await h.service.joinGame(OWNER, other.value, "Felwarden");
  await h.repo.addMessage(h.gameId, ALICE, "a", T0, CHAT_CEILING);
  await h.repo.addMessage(h.gameId, ALICE, "b", T0, CHAT_CEILING);
  const there = await h.repo.addMessage(other.value, OWNER, "c", T0, CHAT_CEILING);
  assert.equal(there?.seq, 1, "one game's traffic must not show in another's numbering");
});

test("the ceiling is part of the insert: nothing lands at the limit", async () => {
  const h = await withPlayers();
  assert.ok(await h.repo.addMessage(h.gameId, ALICE, "a", T0, 2));
  assert.ok(await h.repo.addMessage(h.gameId, ALICE, "b", T0, 2));
  assert.equal(await h.repo.addMessage(h.gameId, ALICE, "c", T0, 2), null);
  assert.equal((await h.repo.getGame(h.gameId))?.chatSeq, 2, "a refused post issues no seq");
  assert.equal((await h.repo.messagesAfter(h.gameId, 0, 10)).length, 2);
});

test("pages are the LAST n on their side of the cursor, ascending", async () => {
  const h = await withPlayers();
  for (let i = 1; i <= 10; i++) await h.repo.addMessage(h.gameId, ALICE, `m${i}`, T0 + i, CHAT_CEILING);
  const seqs = (rows: { seq: number }[]) => rows.map((r) => r.seq);
  assert.deepEqual(seqs(await h.repo.messagesAfter(h.gameId, 0, 3)), [8, 9, 10]);
  assert.deepEqual(seqs(await h.repo.messagesAfter(h.gameId, 8, 5)), [9, 10]);
  assert.deepEqual(seqs(await h.repo.messagesBefore(h.gameId, 8, 3)), [5, 6, 7]);
  assert.deepEqual(seqs(await h.repo.messagesBefore(h.gameId, 2, 5)), [1]);
  assert.deepEqual(seqs(await h.repo.messagesBefore(h.gameId, 1, 5)), []);
});

test("every stored message is reachable by paging back", async () => {
  const h = await withPlayers();
  const total = CHAT_PAGE * 2 + 17;
  for (let i = 1; i <= total; i++) await h.repo.addMessage(h.gameId, ALICE, `m${i}`, T0 + i, CHAT_CEILING);
  let page = await h.repo.messagesAfter(h.gameId, 0, CHAT_PAGE);
  const seen = new Set(page.map((m) => m.seq));
  while (page.length > 0) {
    page = await h.repo.messagesBefore(h.gameId, page[0]!.seq, CHAT_PAGE);
    for (const m of page) seen.add(m.seq);
  }
  assert.equal(seen.size, total);
});

test("a version 2 database gains chat, and its games start at chat_seq 0", () => {
  const file = `/tmp/rb-migrate3-${process.pid}-${Date.now()}.db`;
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE players (pid TEXT PRIMARY KEY, last_name_used TEXT,
      created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL) STRICT;
    CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT NOT NULL, owner_pid TEXT NOT NULL,
      items_json TEXT NOT NULL, items_frozen INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, closed_at INTEGER) STRICT;
    PRAGMA user_version = 2;`);
  old.prepare("INSERT INTO players VALUES (?, NULL, ?, ?)").run("owner", T0, T0);
  old.prepare("INSERT INTO games VALUES (?, ?, ?, ?, 1, ?, NULL)").run("a-b-c", "Old night", "owner", "[]", T0);
  old.close();

  const db = openDatabase(file);
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  assert.equal((db.prepare("SELECT chat_seq FROM games WHERE id = 'a-b-c'").get() as { chat_seq: number }).chat_seq, 0);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get());
  db.close();
  // Safe to run twice.
  openDatabase(file).close();
});

/* -------------------------------------------------------------- service */

test("each refusal, in order", async () => {
  const h = await withPlayers();
  const code = async (gameId: string, pid: string, raw: unknown) => {
    const r = await h.service.postMessage(gameId, pid, raw);
    return r.ok ? "ok" : r.error.code;
  };
  assert.equal(await code("no-such-game", ALICE, ""), "not_found");
  assert.equal(await code(h.gameId, BOB, ""), "forbidden", "membership comes before content");
  assert.equal(await code(h.gameId, ALICE, "   "), "invalid");
  assert.equal(await code(h.gameId, ALICE, "fine"), "ok");
  await h.service.closeGame(OWNER, h.gameId);
  assert.equal(await code(h.gameId, ALICE, ""), "closed", "closed comes before content");
});

test("five posts in ten seconds, then a wait, then posting again", async () => {
  const h = await withPlayers();
  for (let i = 0; i < CHAT_BURST; i++) {
    assert.ok((await h.service.postMessage(h.gameId, ALICE, `spam ${i}`)).ok);
  }
  const limited = await h.service.postMessage(h.gameId, ALICE, "one more");
  assert.equal(limited.ok ? "" : limited.error.code, "rate_limited");
  assert.match(limited.ok ? "" : limited.error.message, /\d+ second/);

  // Someone else is not slowed down by Alice.
  assert.ok((await h.service.postMessage(h.gameId, OWNER, "calm down")).ok);

  h.clock.advance(CHAT_WINDOW_MS);
  assert.ok((await h.service.postMessage(h.gameId, ALICE, "back")).ok);
});

test("a full chat says full, and the refusal spends no limiter slot", async () => {
  const h = await withPlayers();
  // Fill straight through the repository: the limiter would otherwise make
  // this test take 5,000 posts' worth of simulated time.
  for (let i = 0; i < CHAT_CEILING; i++) await h.repo.addMessage(h.gameId, OWNER, `m${i}`, T0, CHAT_CEILING);
  for (let i = 0; i < CHAT_BURST + 3; i++) {
    const r = await h.service.postMessage(h.gameId, ALICE, "hello?");
    assert.equal(r.ok ? "" : r.error.code, "full", `attempt ${i + 1} should be full, never rate_limited`);
  }
});

test("posting does not keep a game alive: the idle clock runs on calls alone", async () => {
  const h = await withPlayers();
  h.clock.advance(IDLE_CLOSE_MS - 1000);
  assert.ok((await h.service.postMessage(h.gameId, ALICE, "anyone?")).ok);
  h.clock.advance(2000);
  const r = await h.service.postMessage(h.gameId, ALICE, "hello?");
  assert.equal(r.ok ? "" : r.error.code, "closed");
});

test("a closed game's chat is readable to the first message", async () => {
  const h = await withPlayers();
  for (let i = 1; i <= CHAT_PAGE + 5; i++) await h.repo.addMessage(h.gameId, ALICE, `m${i}`, T0 + i, CHAT_CEILING);
  await h.service.closeGame(OWNER, h.gameId);
  const latest = await h.service.messagesAfter(h.gameId, ALICE, 0);
  assert.ok(latest.ok);
  assert.equal(latest.value.length, CHAT_PAGE);
  const older = await h.service.messagesBefore(h.gameId, ALICE, latest.value[0]!.seq);
  assert.ok(older.ok);
  assert.deepEqual(older.value.map((m) => m.seq), [1, 2, 3, 4, 5]);
});

test("reading is roster-only, and a view never carries a pid", async () => {
  const h = await withPlayers();
  await h.service.postMessage(h.gameId, ALICE, "hi");
  const outsider = await h.service.messagesAfter(h.gameId, BOB, 0);
  assert.equal(outsider.ok ? "" : outsider.error.code, "forbidden");
  const page = await h.service.messagesAfter(h.gameId, OWNER, 0);
  assert.ok(page.ok);
  assert.deepEqual(Object.keys(page.value[0]!).sort(), ["at", "charName", "seq", "text"]);
  assert.ok(!JSON.stringify(page.value).includes(ALICE));
});

test("a bingo's time is exactly the time of the call that completed it", async () => {
  const h = await withPlayers();
  const game = await h.repo.getGame(h.gameId);
  const alice = await h.repo.getGamePlayer(h.gameId, ALICE);
  assert.ok(game && alice);
  // Call Alice's first row, one square at a time, with the clock moving.
  const row = alice.board.slice(0, 5);
  for (const item of row) {
    h.clock.advance(1000);
    await h.service.call(OWNER, h.gameId, item);
  }
  const calls = await h.repo.callsFor(h.gameId);
  const won = await h.repo.getGamePlayer(h.gameId, ALICE);
  assert.equal(won?.bingoAt, calls.get(row[4]!));
});
