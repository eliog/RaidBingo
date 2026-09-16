import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, items, T0 } from "./helpers.ts";
import { IDLE_CLOSE_MS, GAMES_PER_DAY } from "../server/game-service.ts";
import { ITEM_COUNT, isValidBoard } from "../shared/board.ts";

const OWNER = "owner-pid";
const ALICE = "alice-pid";
const BOB = "bob-pid";

async function withGame(seed = 1) {
  const h = harness(seed);
  await h.repo.upsertPlayer(OWNER, T0);
  await h.repo.upsertPlayer(ALICE, T0);
  await h.repo.upsertPlayer(BOB, T0);
  const created = await h.service.createGame(OWNER, "Tuesday BT run", items());
  assert.ok(created.ok);
  return { ...h, gameId: created.value };
}

test("a game needs a title and exactly 24 clean squares", async () => {
  const h = harness();
  await h.repo.upsertPlayer(OWNER, T0);
  assert.equal((await h.service.createGame(OWNER, "", items())).ok, false);
  assert.equal((await h.service.createGame(OWNER, "ok", items(23))).ok, false);
  const dup = items();
  dup[4] = dup[3] as string;
  const r = await h.service.createGame(OWNER, "ok", dup);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error.message, /Square 5/);
});

test("game ids are three words and unique per game", async () => {
  const h = await withGame();
  assert.match(h.gameId, /^[a-z]+-[a-z]+-[a-z]+$/);
  const second = await h.service.createGame(OWNER, "Another", items());
  assert.ok(second.ok);
  assert.notEqual(second.value, h.gameId);
});

test("creating too many games in a day is refused with a real wait time", async () => {
  const h = harness();
  await h.repo.upsertPlayer(OWNER, T0);
  for (let i = 0; i < GAMES_PER_DAY; i++) {
    assert.ok((await h.service.createGame(OWNER, `Game ${i}`, items())).ok);
  }
  const over = await h.service.createGame(OWNER, "One too many", items());
  assert.equal(over.ok, false);
  assert.equal(over.ok ? "" : over.error.code, "rate_limited");
  assert.match(over.ok ? "" : over.error.message, /minutes/);
});

test("the owner joining does NOT freeze the squares", async () => {
  // The owner takes a board through the same gate as everyone else, so
  // counting their join would end editing before it began.
  const h = await withGame();
  assert.ok((await h.service.joinGame(OWNER, h.gameId, "Felwarden")).ok);
  const view = await h.service.view(OWNER, h.gameId);
  assert.ok(view.ok);
  assert.equal(view.value.itemsFrozen, false);
  assert.ok((await h.service.setItems(OWNER, h.gameId, items())).ok);
});

test("the first non-owner joining freezes the squares for good", async () => {
  const h = await withGame();
  await h.service.joinGame(OWNER, h.gameId, "Felwarden");
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");

  const view = await h.service.view(OWNER, h.gameId);
  assert.ok(view.ok && view.value.itemsFrozen);

  const late = await h.service.setItems(OWNER, h.gameId, items());
  assert.equal(late.ok, false);
  assert.equal(late.ok ? "" : late.error.code, "frozen");
});

test("a taken name is refused with alternatives that are actually free", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const clash = await h.service.joinGame(BOB, h.gameId, "  thal GRIM ");
  assert.equal(clash.ok, false);
  if (clash.ok) return;
  assert.equal(clash.error.code, "name_taken");
  const suggestions = clash.error.suggestions ?? [];
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) {
    assert.ok((await h.service.joinGame(BOB, h.gameId, s)).ok, `${s} was offered but rejected`);
    break;
  }
});

test("joining twice is idempotent and keeps the first board", async () => {
  const h = await withGame();
  const first = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const again = await h.service.joinGame(ALICE, h.gameId, "SomeoneElse");
  assert.ok(first.ok && again.ok);
  assert.deepEqual(again.value.board, first.value.board);
  assert.equal(again.value.charName, "Thalgrim");
});

test("only the owner can call or undo", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const call = await h.service.call(ALICE, h.gameId, 3);
  assert.equal(call.ok, false);
  assert.equal(call.ok ? "" : call.error.code, "forbidden");
  const undo = await h.service.undo(ALICE, h.gameId, 3);
  assert.equal(undo.ok, false);
});

test("a call reaches every board, and an undo takes it back", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  await h.service.call(OWNER, h.gameId, 3);
  let view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  assert.deepEqual(view.value.called.map(([i]) => i), [3]);

  await h.service.undo(OWNER, h.gameId, 3);
  view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok && view.value.called.length === 0);
});

test("calling an item that is not on the board is refused", async () => {
  const h = await withGame();
  assert.equal((await h.service.call(OWNER, h.gameId, ITEM_COUNT)).ok, false);
  assert.equal((await h.service.call(OWNER, h.gameId, -1)).ok, false);
});

test("completing a line stamps a bingo and names the winner", async () => {
  const h = await withGame();
  const joined = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.ok(joined.ok);
  const board = joined.value.board as number[];

  const topRow = [0, 1, 2, 3, 4].map((p) => board[p] as number);
  let winners: string[] = [];
  for (const item of topRow) {
    const r = await h.service.call(OWNER, h.gameId, item);
    assert.ok(r.ok);
    winners = r.value.winners;
  }
  assert.deepEqual(winners, ["Thalgrim"]);

  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  assert.equal(view.value.roster[0]?.bingoAt, T0);
});

test("undoing the call a line rested on takes the bingo back with it", async () => {
  const h = await withGame();
  const joined = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.ok(joined.ok);
  const board = joined.value.board as number[];
  for (const p of [0, 1, 2, 3, 4]) await h.service.call(OWNER, h.gameId, board[p] as number);

  let view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok && view.value.roster[0]?.bingoAt !== null);

  await h.service.undo(OWNER, h.gameId, board[0] as number);
  view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  assert.equal(view.value.roster[0]?.bingoAt, null, "the bingo should be gone entirely");
});

test("a bingo survives an undo if another line still holds", async () => {
  const h = await withGame();
  const joined = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.ok(joined.ok);
  const board = joined.value.board as number[];
  // Top row and left column share the corner at position 0.
  for (const p of [0, 1, 2, 3, 4, 5, 10, 15, 20]) {
    await h.service.call(OWNER, h.gameId, board[p] as number);
  }
  // Break the top row at position 4; the left column is untouched.
  await h.service.undo(OWNER, h.gameId, board[4] as number);

  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  assert.notEqual(view.value.roster[0]?.bingoAt, null, "the column still wins");
});

test("re-calling after an undo restores the bingo", async () => {
  const h = await withGame();
  const joined = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.ok(joined.ok);
  const board = joined.value.board as number[];
  for (const p of [0, 1, 2, 3, 4]) await h.service.call(OWNER, h.gameId, board[p] as number);
  await h.service.undo(OWNER, h.gameId, board[0] as number);
  const again = await h.service.call(OWNER, h.gameId, board[0] as number);
  assert.ok(again.ok);
  assert.deepEqual(again.value.winners, ["Thalgrim"]);
});

test("a late joiner inherits every call already made", async () => {
  const h = await withGame();
  await h.service.joinGame(OWNER, h.gameId, "Felwarden");
  for (const i of [0, 1, 2]) await h.service.call(OWNER, h.gameId, i);

  const late = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.ok(late.ok);
  assert.equal(late.value.called.length, 3);
  assert.ok((late.value.roster.find((r) => r.you)?.bestLine ?? 0) >= 1);
});

test("the view never contains a pid", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok);
  const json = JSON.stringify(view.value);
  for (const pid of [OWNER, ALICE, BOB]) {
    assert.ok(!json.includes(pid), `${pid} leaked into the client view`);
  }
});

test("the roster carries each player's board, so others can see how close they are", async () => {
  const h = await withGame();
  const alice = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const bob = await h.service.joinGame(BOB, h.gameId, "Bonkgrog");
  assert.ok(alice.ok && bob.ok);

  const view = await h.service.view(BOB, h.gameId);
  assert.ok(view.ok);
  const byName = Object.fromEntries(view.value.roster.map((r) => [r.charName, r]));

  for (const name of ["Thalgrim", "Bonkgrog"]) {
    const board = byName[name]?.board;
    assert.ok(Array.isArray(board), `${name} has no board`);
    assert.ok(isValidBoard(board), `${name}'s board is not a real deal`);
  }
  // Same items, different order — that is the whole game.
  assert.notDeepEqual(byName["Thalgrim"]?.board, byName["Bonkgrog"]?.board);
  assert.deepEqual(byName["Thalgrim"]?.board, alice.value.board);

  // Boards are not sensitive, but pids remain absent.
  assert.ok(!JSON.stringify(view.value).includes(ALICE));
});

test("no two players in a game are dealt the same board", async () => {
  const h = await withGame();
  const names = ["Thalgrim", "Bonkgrog", "Mirelle", "Kaelen", "Sylva"];
  for (const [i, name] of names.entries()) {
    await h.repo.upsertPlayer(`p${i}`, T0);
    assert.ok((await h.service.joinGame(`p${i}`, h.gameId, name)).ok);
  }
  const view = await h.service.view("p0", h.gameId);
  assert.ok(view.ok);
  const keys = view.value.roster.map((r) => r.board.join());
  assert.equal(new Set(keys).size, keys.length, "two players share a board");
});

test("the roster puts winners first by time, then by marks", async () => {
  const h = await withGame();
  const a = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  await h.service.joinGame(BOB, h.gameId, "Bonkgrog");
  assert.ok(a.ok);
  const board = a.value.board as number[];
  for (const p of [0, 1, 2, 3, 4]) await h.service.call(OWNER, h.gameId, board[p] as number);

  const view = await h.service.view(BOB, h.gameId);
  assert.ok(view.ok);
  assert.equal(view.value.roster[0]?.charName, "Thalgrim");
  assert.notEqual(view.value.roster[0]?.bingoAt, null);
});

test("a game goes quiet for eight hours and closes itself", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  h.clock.advance(IDLE_CLOSE_MS + 1000);

  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok && view.value.closed);

  const call = await h.service.call(OWNER, h.gameId, 1);
  assert.equal(call.ok, false);
  assert.equal(call.ok ? "" : call.error.code, "closed");
});

test("a call keeps the game alive past the idle window", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  h.clock.advance(IDLE_CLOSE_MS - 1000);
  assert.ok((await h.service.call(OWNER, h.gameId, 1)).ok);
  h.clock.advance(IDLE_CLOSE_MS - 1000);
  const view = await h.service.view(ALICE, h.gameId);
  assert.ok(view.ok && !view.value.closed);
});

test("the lobby separates games you are still playing from finished ones", async () => {
  const h = await withGame();
  await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  const second = await h.service.createGame(OWNER, "Later night", items());
  assert.ok(second.ok);
  await h.service.joinGame(ALICE, second.value, "Bonkgrog");
  await h.service.closeGame(OWNER, second.value);

  const lobby = await h.service.lobby(ALICE);
  assert.deepEqual(lobby.active.map((g) => g.title), ["Tuesday BT run"]);
  assert.deepEqual(lobby.past.map((g) => g.title), ["Later night"]);
  assert.equal(lobby.active[0]?.isOwner, false);
  assert.equal(lobby.active[0]?.charName, "Thalgrim");
});

test("previous item sets are offered for reuse, newest first", async () => {
  const h = await withGame();
  h.clock.advance(1000);
  await h.service.createGame(OWNER, "Later night", items());
  const sets = await h.service.previousItemSets(OWNER);
  assert.deepEqual(sets.map((s) => s.title), ["Later night", "Tuesday BT run"]);
  assert.equal(sets[0]?.items.length, ITEM_COUNT);
  assert.equal((await h.service.previousItemSets(ALICE)).length, 0);
});

test("a closed game refuses new joins", async () => {
  const h = await withGame();
  await h.service.closeGame(OWNER, h.gameId);
  const join = await h.service.joinGame(ALICE, h.gameId, "Thalgrim");
  assert.equal(join.ok, false);
  assert.equal(join.ok ? "" : join.error.code, "closed");
});

test("a game that does not exist is not found, never a crash", async () => {
  const h = await withGame();
  for (const r of [
    await h.service.view(ALICE, "no-such-game"),
    await h.service.joinGame(ALICE, "no-such-game", "X"),
    await h.service.call(OWNER, "no-such-game", 0),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.error.code, "not_found");
  }
});
