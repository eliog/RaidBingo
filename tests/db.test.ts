import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, createRepository } from "../server/db.ts";
import type { Repository } from "../server/ports.ts";
import { dealBoard } from "../shared/board.ts";
import { seededRng } from "../shared/seams.ts";

const T0 = 1_700_000_000_000;
const items = () => Array.from({ length: 24 }, (_, i) => `item ${i + 1}`);

/** A real database per test — in memory, so it costs microseconds. */
async function fixture(): Promise<Repository> {
  const repo = createRepository(openDatabase(":memory:"));
  await repo.upsertPlayer("owner", T0);
  await repo.upsertPlayer("player", T0);
  await repo.createGame({
    id: "wyrm-lantern-ward", title: "Tuesday BT run", ownerPid: "owner",
    items: items(), itemsFrozen: false, createdAt: T0, closedAt: null,
  });
  return repo;
}

test("a player round-trips and upsert only moves last_seen", async () => {
  const repo = await fixture();
  const first = await repo.upsertPlayer("owner", T0 + 5000);
  assert.equal(first.createdAt, T0);
  assert.equal(first.lastSeen, T0 + 5000);
  await repo.setLastNameUsed("owner", "Felwarden");
  assert.equal((await repo.getPlayer("owner"))?.lastNameUsed, "Felwarden");
  assert.equal(await repo.getPlayer("nobody"), null);
});

test("a session is found until it expires, and can be deleted", async () => {
  const repo = await fixture();
  const row = { tokenHash: "abc", pid: "owner", createdAt: T0, expiresAt: T0 + 1000 };
  await repo.createSession(row);
  assert.equal((await repo.findSession("abc", T0 + 999))?.pid, "owner");
  assert.equal(await repo.findSession("abc", T0 + 1001), null, "expired session still found");
  await repo.deleteSession("abc");
  assert.equal(await repo.findSession("abc", T0), null);
});

test("a game round-trips with its items intact", async () => {
  const repo = await fixture();
  const game = await repo.getGame("wyrm-lantern-ward");
  assert.equal(game?.title, "Tuesday BT run");
  assert.equal(game?.itemsFrozen, false);
  assert.deepEqual(game?.items, items());
  assert.equal(await repo.getGame("no-such-game"), null);
});

test("freezing the items makes them permanently unwritable", async () => {
  const repo = await fixture();
  await repo.updateGameItems("wyrm-lantern-ward", ["changed", ...items().slice(1)]);
  assert.equal((await repo.getGame("wyrm-lantern-ward"))?.items[0], "changed");

  await repo.freezeGameItems("wyrm-lantern-ward");
  await repo.updateGameItems("wyrm-lantern-ward", ["too late", ...items().slice(1)]);

  const after = await repo.getGame("wyrm-lantern-ward");
  assert.equal(after?.itemsFrozen, true);
  assert.equal(after?.items[0], "changed", "a frozen item list must not change");
});

test("the title stays editable after the items freeze", async () => {
  const repo = await fixture();
  await repo.freezeGameItems("wyrm-lantern-ward");
  await repo.setGameTitle("wyrm-lantern-ward", "Wednesday instead");
  assert.equal((await repo.getGame("wyrm-lantern-ward"))?.title, "Wednesday instead");
});

test("closing a game records the time once and does not move it", async () => {
  const repo = await fixture();
  await repo.closeGame("wyrm-lantern-ward", T0 + 100);
  await repo.closeGame("wyrm-lantern-ward", T0 + 999);
  assert.equal((await repo.getGame("wyrm-lantern-ward"))?.closedAt, T0 + 100);
});

test("a player joins with a board and appears on the roster", async () => {
  const repo = await fixture();
  const board = dealBoard(seededRng(1));
  await repo.addGamePlayer({
    gameId: "wyrm-lantern-ward", pid: "player", charName: "Thalgrim",
    board, joinedAt: T0, bingoAt: null,
  });
  const row = await repo.getGamePlayer("wyrm-lantern-ward", "player");
  assert.deepEqual(row?.board, board, "the stored board must come back identical");
  assert.equal(row?.charName, "Thalgrim");
  assert.equal((await repo.rosterFor("wyrm-lantern-ward")).length, 1);
});

test("two players in one game cannot share a name, even case-shifted", async () => {
  // Enforced by a UNIQUE index rather than by a check that could race.
  const repo = await fixture();
  const join = (pid: string, charName: string) =>
    repo.addGamePlayer({
      gameId: "wyrm-lantern-ward", pid, charName,
      board: dealBoard(seededRng(2)), joinedAt: T0, bingoAt: null,
    });
  await join("player", "Thalgrim");
  await repo.upsertPlayer("third", T0);
  await assert.rejects(() => join("third", "  thal GRIM "));
});

test("isNameTaken matches the same normalisation", async () => {
  const repo = await fixture();
  await repo.addGamePlayer({
    gameId: "wyrm-lantern-ward", pid: "player", charName: "Thalgrim",
    board: dealBoard(seededRng(3)), joinedAt: T0, bingoAt: null,
  });
  assert.equal(await repo.isNameTaken("wyrm-lantern-ward", "THALGRIM"), true);
  assert.equal(await repo.isNameTaken("wyrm-lantern-ward", "Thal grim"), true);
  assert.equal(await repo.isNameTaken("wyrm-lantern-ward", "Thalgrimm"), false);
  assert.equal(await repo.isNameTaken("another-game-entirely", "Thalgrim"), false);
});

test("the same name is free again in a different game", async () => {
  const repo = await fixture();
  await repo.createGame({
    id: "frost-raven-keep", title: "Other night", ownerPid: "owner",
    items: items(), itemsFrozen: false, createdAt: T0, closedAt: null,
  });
  const join = (gameId: string) =>
    repo.addGamePlayer({
      gameId, pid: "player", charName: "Thalgrim",
      board: dealBoard(seededRng(4)), joinedAt: T0, bingoAt: null,
    });
  await join("wyrm-lantern-ward");
  await join("frost-raven-keep");
  assert.equal((await repo.gamesForPlayer("player")).length, 2);
});

test("calling twice is idempotent and keeps the first time", async () => {
  // This is what makes the owner's reflex double-tap safe.
  const repo = await fixture();
  await repo.addCall("wyrm-lantern-ward", 7, T0 + 10);
  await repo.addCall("wyrm-lantern-ward", 7, T0 + 9999);
  const calls = await repo.callsFor("wyrm-lantern-ward");
  assert.equal(calls.size, 1);
  assert.equal(calls.get(7), T0 + 10);
});

test("undo is a plain delete, and re-calling afterwards works", async () => {
  const repo = await fixture();
  await repo.addCall("wyrm-lantern-ward", 3, T0);
  await repo.removeCall("wyrm-lantern-ward", 3);
  assert.equal((await repo.callsFor("wyrm-lantern-ward")).size, 0);
  await repo.removeCall("wyrm-lantern-ward", 3); // undoing nothing is not an error
  await repo.addCall("wyrm-lantern-ward", 3, T0 + 500);
  assert.equal((await repo.callsFor("wyrm-lantern-ward")).get(3), T0 + 500);
});

test("bingo is stamped once, so the winner ranking cannot be rewritten", async () => {
  const repo = await fixture();
  await repo.addGamePlayer({
    gameId: "wyrm-lantern-ward", pid: "player", charName: "Thalgrim",
    board: dealBoard(seededRng(5)), joinedAt: T0, bingoAt: null,
  });
  await repo.markBingo("wyrm-lantern-ward", "player", T0 + 60_000);
  await repo.markBingo("wyrm-lantern-ward", "player", T0 + 120_000);
  assert.equal((await repo.getGamePlayer("wyrm-lantern-ward", "player"))?.bingoAt, T0 + 60_000);
});

test("previous item sets come back newest first, for reuse when creating a game", async () => {
  const repo = await fixture();
  await repo.createGame({
    id: "frost-raven-keep", title: "Later night", ownerPid: "owner",
    items: items(), itemsFrozen: false, createdAt: T0 + 1000, closedAt: null,
  });
  const sets = await repo.previousItemSets("owner", 10);
  assert.deepEqual(sets.map((g) => g.title), ["Later night", "Tuesday BT run"]);
  assert.equal((await repo.previousItemSets("player", 10)).length, 0);
});
