import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, createRepository } from "../server/db.ts";
import { GameService } from "../server/game-service.ts";
import { fixedClock, seededRng } from "../shared/seams.ts";
import { harness, items, T0 } from "./helpers.ts";

const OWNER = "owner-pid", ALICE = "alice-pid", BOB = "bob-pid";

async function withGame() {
  const h = harness(5);
  for (const pid of [OWNER, ALICE, BOB]) await h.repo.upsertPlayer(pid, T0);
  const created = await h.service.createGame(OWNER, "Tuesday BT run", items());
  assert.ok(created.ok);
  const gameId = created.value;
  await h.service.joinGame(OWNER, gameId, "Felwarden");
  await h.service.joinGame(ALICE, gameId, "Thalgrim");
  await h.service.joinGame(BOB, gameId, "Bonkgrog");
  return { ...h, gameId };
}

test("a player cannot call until the owner says so", async () => {
  const h = await withGame();
  const before = await h.service.call(ALICE, h.gameId, 1);
  assert.equal(before.ok, false);
  assert.equal(before.ok ? "" : before.error.code, "forbidden");

  assert.ok((await h.service.setCaller(OWNER, h.gameId, "Thalgrim", true)).ok);
  assert.ok((await h.service.call(ALICE, h.gameId, 1)).ok);
  assert.ok((await h.service.undo(ALICE, h.gameId, 1)).ok);
});

test("revoking takes calling back", async () => {
  const h = await withGame();
  await h.service.setCaller(OWNER, h.gameId, "Thalgrim", true);
  assert.ok((await h.service.call(ALICE, h.gameId, 2)).ok);

  assert.ok((await h.service.setCaller(OWNER, h.gameId, "Thalgrim", false)).ok);
  const after = await h.service.call(ALICE, h.gameId, 3);
  assert.equal(after.ok, false);
  assert.equal(after.ok ? "" : after.error.code, "forbidden");
  // What they already called stands; revoking is not a rollback.
  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  assert.deepEqual(view.value.called.map(([i]) => i), [2]);
});

test("granting does not pass on the power to grant", async () => {
  const h = await withGame();
  await h.service.setCaller(OWNER, h.gameId, "Thalgrim", true);
  const r = await h.service.setCaller(ALICE, h.gameId, "Bonkgrog", true);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "forbidden");
});

test("a plain player cannot grant themselves calling", async () => {
  const h = await withGame();
  const r = await h.service.setCaller(BOB, h.gameId, "Bonkgrog", true);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "forbidden");
  assert.equal((await h.service.call(BOB, h.gameId, 1)).ok, false);
});

test("the owner is told they already can, rather than silently no-opping", async () => {
  const h = await withGame();
  const r = await h.service.setCaller(OWNER, h.gameId, "Felwarden", true);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "invalid");
});

test("granting to someone not in the game says so", async () => {
  const h = await withGame();
  const r = await h.service.setCaller(OWNER, h.gameId, "Nobody", true);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "not_found");
});

test("names resolve case-insensitively, as they do everywhere else", async () => {
  const h = await withGame();
  assert.ok((await h.service.setCaller(OWNER, h.gameId, "  thal GRIM ", true)).ok);
  assert.ok((await h.service.call(ALICE, h.gameId, 4)).ok);
});

test("a closed game hands out nothing", async () => {
  const h = await withGame();
  await h.service.closeGame(OWNER, h.gameId);
  const r = await h.service.setCaller(OWNER, h.gameId, "Thalgrim", true);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "closed");
});

test("the roster shows who may call, and the view tells you about yourself", async () => {
  const h = await withGame();
  await h.service.setCaller(OWNER, h.gameId, "Thalgrim", true);

  const asAlice = await h.service.view(ALICE, h.gameId);
  assert.ok(asAlice.ok);
  assert.equal(asAlice.value.canCall, true);
  assert.equal(asAlice.value.isOwner, false);

  const asBob = await h.service.view(BOB, h.gameId);
  assert.ok(asBob.ok);
  assert.equal(asBob.value.canCall, false);

  const byName = Object.fromEntries(asBob.value.roster.map((r) => [r.charName, r]));
  assert.equal(byName["Felwarden"]?.canCall, true, "the owner always may");
  assert.equal(byName["Felwarden"]?.isOwner, true);
  assert.equal(byName["Thalgrim"]?.canCall, true);
  assert.equal(byName["Bonkgrog"]?.canCall, false);
  // Still no pid anywhere near the client.
  assert.ok(!JSON.stringify(asBob.value).includes(ALICE));
});

test("a database written before the column gains it, defaulting to no", async () => {
  // The production database predates can_call, so the migration has to reach
  // rows that already exist rather than only new ones.
  const file = `/tmp/rb-migrate-${process.pid}-${Date.now()}.db`;
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE game_players (
    game_id TEXT NOT NULL, pid TEXT NOT NULL, char_name TEXT NOT NULL,
    char_name_key TEXT NOT NULL, board_json TEXT NOT NULL,
    joined_at INTEGER NOT NULL, bingo_at INTEGER,
    PRIMARY KEY (game_id, pid)) STRICT`);
  old.prepare(`INSERT INTO game_players VALUES (?,?,?,?,?,?,NULL)`)
    .run("g", "p", "Thalgrim", "thalgrim", "[]", T0);
  old.close();

  const db = openDatabase(file);
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  assert.equal(version.user_version, 2);

  const row = db.prepare("SELECT can_call FROM game_players WHERE pid = ?").get("p") as { can_call: number };
  assert.equal(row.can_call, 0, "an existing player must not silently gain calling");

  // Running it again must be a no-op, not an error.
  db.close();
  openDatabase(file).close();
});

test("a granted caller survives a restart, because it is in the database", async () => {
  const file = `/tmp/rb-persist-${process.pid}-${Date.now()}.db`;
  const clock = fixedClock(T0);
  const make = () => {
    const repo = createRepository(openDatabase(file));
    return { repo, service: new GameService(repo, clock, seededRng(9)) };
  };

  const first = make();
  await first.repo.upsertPlayer(OWNER, T0);
  await first.repo.upsertPlayer(ALICE, T0);
  const created = await first.service.createGame(OWNER, "Tuesday BT run", items());
  assert.ok(created.ok);
  await first.service.joinGame(OWNER, created.value, "Felwarden");
  await first.service.joinGame(ALICE, created.value, "Thalgrim");
  await first.service.setCaller(OWNER, created.value, "Thalgrim", true);

  const second = make();
  assert.ok((await second.service.call(ALICE, created.value, 6)).ok);
});
