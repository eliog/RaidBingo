import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { buildApp, setHub } from "../server/app.ts";
import { GameHub } from "../server/ws.ts";
import { createRepository, openDatabase } from "../server/db.ts";
import { GameService } from "../server/game-service.ts";
import { newSessionToken, hashSessionToken, SESSION_MS } from "../server/identity.ts";
import { systemClock, seededRng } from "../shared/seams.ts";
import { SESSION_COOKIE } from "../server/auth.ts";
import { testConfig, fakeDiscord, items } from "./helpers.ts";

/** A real server on a real port, with real sockets. */
async function live() {
  const repo = createRepository(openDatabase(":memory:"));
  const deps = { config: testConfig(), repo, discord: fakeDiscord(), clock: systemClock, rng: seededRng(3) };
  const app = buildApp(deps);
  const hub = new GameHub(deps);
  setHub(hub);
  await app.listen({ port: 0, host: "127.0.0.1" });
  hub.attach(app.server);

  const address = app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const service = new GameService(repo, systemClock, seededRng(3));

  async function signIn(pid: string): Promise<string> {
    await repo.upsertPlayer(pid, Date.now());
    const token = newSessionToken();
    await repo.createSession({
      tokenHash: hashSessionToken(token), pid,
      createdAt: Date.now(), expiresAt: Date.now() + SESSION_MS,
    });
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }

  async function post(path: string, cookie: string, body: unknown) {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  }

  /**
   * Buffers from creation. The server pushes state the instant the socket is
   * accepted, so a listener attached after `open` misses the first frame.
   */
  function socket(gameId: string, cookie: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${gameId}`, { headers: { cookie } });
    const seen: Record<string, unknown>[] = [];
    const waiting: ((m: Record<string, unknown>) => void)[] = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiting.shift();
      if (waiter) waiter(msg); else seen.push(msg);
    });
    return {
      ws,
      opened: () => new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); }),
      next(timeoutMs = 4000): Promise<Record<string, unknown>> {
        return this.until(() => true, timeoutMs);
      },
      /**
       * Waits for a message that matches. Every connect re-pushes to the whole
       * room, so a second viewer joining sends the first one another frame —
       * "the next message" is not the same thing as "the one I am waiting for".
       */
      until(match: (m: Record<string, unknown>) => boolean, timeoutMs = 4000): Promise<Record<string, unknown>> {
        const hit = seen.findIndex(match);
        if (hit >= 0) return Promise.resolve(seen.splice(hit, 1)[0] as Record<string, unknown>);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error("no matching message arrived")), timeoutMs);
          const probe = (m: Record<string, unknown>) => {
            if (!match(m)) { waiting.push(probe); return; }
            clearTimeout(timer); res(m);
          };
          waiting.push(probe);
        });
      },
      close: () => ws.terminate(),
    };
  }

  return { repo, service, app, hub, port, signIn, post, socket,
    async stop() { hub.close(); setHub(null); await app.close(); } };
}


test("two viewers see a call land at the same time", async () => {
  const h = await live();
  try {
    const owner = await h.signIn("owner-pid");
    const player = await h.signIn("player-pid");
    const created = await h.service.createGame("owner-pid", "Tuesday BT run", items());
    assert.ok(created.ok);
    const gameId = created.value;
    await h.service.joinGame("owner-pid", gameId, "Felwarden");
    await h.service.joinGame("player-pid", gameId, "Thalgrim");

    const a = h.socket(gameId, owner);
    const b = h.socket(gameId, player);
    await Promise.all([a.opened(), b.opened()]);

    // Each socket gets the current state on connect.
    const [firstA, firstB] = await Promise.all([a.next(), b.next()]);
    assert.equal(firstA["type"], "state");
    assert.equal((firstA["called"] as unknown[]).length, 0);
    assert.equal((firstB["roster"] as unknown[]).length, 2);

    // The owner calls over HTTP; both sockets should hear about it.
    const calledSeven = (m: Record<string, unknown>) => ((m["called"] as unknown[]) ?? []).length === 1;
    const both = Promise.all([a.until(calledSeven), b.until(calledSeven)]);
    const res = await h.post(`/api/games/${gameId}/call`, owner, { item: 7 });
    assert.equal(res.status, 200);

    const [pushA, pushB] = await both;
    for (const push of [pushA, pushB]) {
      assert.equal(push["type"], "state");
      assert.deepEqual((push["called"] as [number, number][]).map(([i]) => i), [7]);
    }

    // And an undo reaches both the same way.
    const empty = (m: Record<string, unknown>) => ((m["called"] as unknown[]) ?? []).length === 0;
    const undone = Promise.all([a.until(empty), b.until(empty)]);
    await h.post(`/api/games/${gameId}/undo`, owner, { item: 7 });
    for (const push of await undone) {
      assert.equal((push["called"] as unknown[]).length, 0);
    }

    a.close(); b.close();
  } finally { await h.stop(); }
});

test("a new player joining shows up on everyone else's roster", async () => {
  const h = await live();
  try {
    const owner = await h.signIn("owner-pid");
    const player = await h.signIn("player-pid");
    const created = await h.service.createGame("owner-pid", "Tuesday BT run", items());
    assert.ok(created.ok);
    const gameId = created.value;
    await h.service.joinGame("owner-pid", gameId, "Felwarden");

    const a = h.socket(gameId, owner);
    await a.opened();
    await a.next();

    const pushed = a.until((m) => ((m["roster"] as unknown[]) ?? []).length === 2);
    await h.post(`/api/games/${gameId}/join`, player, { charName: "Thalgrim" });
    const roster = (await pushed)["roster"] as { charName: string }[];
    assert.deepEqual(roster.map((r) => r.charName).sort(), ["Felwarden", "Thalgrim"]);

    a.close();
  } finally { await h.stop(); }
});

test("a bingo, and its revocation, both reach every viewer", async () => {
  const h = await live();
  try {
    const owner = await h.signIn("owner-pid");
    const player = await h.signIn("player-pid");
    const created = await h.service.createGame("owner-pid", "Tuesday BT run", items());
    assert.ok(created.ok);
    const gameId = created.value;
    await h.service.joinGame("owner-pid", gameId, "Felwarden");
    const joined = await h.service.joinGame("player-pid", gameId, "Thalgrim");
    assert.ok(joined.ok);
    const board = joined.value.board as number[];

    const a = h.socket(gameId, owner);
    await a.opened();
    await a.next();

    for (const p of [0, 1, 2, 3, 4]) {
      const want = p + 1;
      const pushed = a.until((m) => ((m["called"] as unknown[]) ?? []).length === want);
      await h.post(`/api/games/${gameId}/call`, owner, { item: board[p] });
      await pushed;
    }
    const withBingo = await h.service.view("player-pid", gameId);
    assert.ok(withBingo.ok);
    assert.notEqual(withBingo.value.roster.find((r) => r.charName === "Thalgrim")?.bingoAt, null);

    // Undoing one of those calls takes the bingo back, live.
    const revoked = a.until((m) =>
      ((m["roster"] as { bingoAt: number | null }[]) ?? []).every((r) => r.bingoAt === null));
    await h.post(`/api/games/${gameId}/undo`, owner, { item: board[0] });
    const roster = (await revoked)["roster"] as { charName: string; bingoAt: number | null }[];
    assert.equal(roster.find((r) => r.charName === "Thalgrim")?.bingoAt, null);

    a.close();
  } finally { await h.stop(); }
});

test("someone who is not in the game cannot open a socket to it", async () => {
  const h = await live();
  try {
    const owner = await h.signIn("owner-pid");
    const stranger = await h.signIn("stranger-pid");
    const created = await h.service.createGame("owner-pid", "Tuesday BT run", items());
    assert.ok(created.ok);
    await h.service.joinGame("owner-pid", created.value, "Felwarden");

    for (const cookie of [stranger, "rb_session=nonsense", ""]) {
      const sock = h.socket(created.value, cookie);
      await assert.rejects(sock.opened(), "the socket should have been refused");
    }
    void owner;
  } finally { await h.stop(); }
});

test("a restart says goodbye before dropping the sockets", async () => {
  // Clients use that to tell a deploy from a network blip.
  const h = await live();
  const owner = await h.signIn("owner-pid");
  const created = await h.service.createGame("owner-pid", "Tuesday BT run", items());
  assert.ok(created.ok);
  await h.service.joinGame("owner-pid", created.value, "Felwarden");

  const sock = h.socket(created.value, owner);
  await sock.opened();
  await sock.next();

  const bye = sock.until((m) => m["type"] === "goodbye");
  h.hub.goodbye("restart");
  const msg = await bye;
  assert.equal(msg["type"], "goodbye");
  assert.equal(msg["reason"], "restart");

  sock.close();
  await h.stop();
});
