import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.ts";
import { createRepository, openDatabase } from "../server/db.ts";
import { fixedClock, seededRng } from "../shared/seams.ts";
import { derivePid } from "../server/identity.ts";
import { testConfig, fakeDiscord, items, T0 } from "./helpers.ts";
import { SESSION_COOKIE } from "../server/auth.ts";

function app(discordUserId = "1099") {
  const repo = createRepository(openDatabase(":memory:"));
  const clock = fixedClock(T0);
  const discord = fakeDiscord(discordUserId);
  const config = testConfig();
  const instance = buildApp({ config, repo, discord, clock, rng: seededRng(1) });
  return { instance, repo, clock, discord, config };
}

function cookieFrom(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? (setCookie[0] as string) : (setCookie as string);
  return raw.split(";")[0] as string;
}

/** Walks the real OAuth round trip and returns the session cookie. */
async function signIn(h: ReturnType<typeof app>, discordUserId = "1099"): Promise<string> {
  const login = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2F" });
  const state = new URL(login.headers["location"] as string).searchParams.get("state") as string;
  h.discord.exchangeCode = async () => ({ discordUserId });
  const cb = await h.instance.inject({ method: "GET", url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}` });
  assert.equal(cb.statusCode, 302);
  return cookieFrom(cb.headers["set-cookie"]);
}

test("the stylesheet makes the hidden attribute actually hide things", async () => {
  // Without this, `el.hidden = true` is ignored by every flex or grid element,
  // and it reads as a state bug rather than a css one.
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/assets/app.css" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
});

test("health check answers", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
});

test("shared modules are served to the browser as plain javascript", async () => {
  // Same source the server runs, types stripped at request time.
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/shared/board.js" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /javascript/);
  assert.ok(res.body.includes("export function dealBoard"));
  assert.ok(!res.body.includes(": Rng"), "types were not stripped");
  // board.ts imports Rng as a TYPE, so stripping removes that import outright.
});

test("a runtime import is rewritten from .ts to .js for the browser", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/shared/validate.js" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('"./board.js"'), "import specifier was not rewritten");
  assert.ok(!res.body.includes('"./board.ts"'));
});

test("a module outside the allowlist cannot be requested", async () => {
  const h = app();
  for (const url of ["/shared/config.js", "/shared/..%2Fserver%2Fconfig.js"]) {
    assert.equal((await h.instance.inject({ method: "GET", url })).statusCode, 404);
  }
});

test("login redirects to Discord carrying a signed state", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2Fg%2Fa-b-c" });
  assert.equal(res.statusCode, 302);
  const url = new URL(res.headers["location"] as string);
  assert.ok((url.searchParams.get("state") ?? "").includes("."));
});

test("the callback creates a session and returns you to where you started", async () => {
  const h = app();
  const login = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2Fnew" });
  const state = new URL(login.headers["location"] as string).searchParams.get("state") as string;
  const res = await h.instance.inject({ method: "GET", url: `/auth/callback?code=xyz&state=${encodeURIComponent(state)}` });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers["location"], "/new");
  const cookie = Array.isArray(res.headers["set-cookie"]) ? res.headers["set-cookie"][0] as string : res.headers["set-cookie"] as string;
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  const pid = derivePid("1099", h.config.pidSecret);
  assert.notEqual(await h.repo.getPlayer(pid), null);
});

test("cancelling at Discord is explained, not treated as an error", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/auth/callback?error=access_denied" });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Login cancelled/);
});

test("a forged or stale state is refused", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/auth/callback?code=x&state=forged.signature" });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /expired/);
});

test("logging out clears the cookie and the session row", async () => {
  const h = app();
  const cookie = await signIn(h);
  const out = await h.instance.inject({ method: "POST", url: "/auth/logout", headers: { cookie } });
  assert.equal(out.statusCode, 302);
  const after = await h.instance.inject({ method: "GET", url: "/api/games/a-b-c", headers: { cookie } });
  assert.equal(after.statusCode, 401);
});

test("a title with an ampersand is escaped exactly once", async () => {
  const h = app();
  const cookie = await signIn(h);
  const { id } = (await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Sun & Moon", items: items() },
  })).json() as { id: string };
  const res = await h.instance.inject({ method: "GET", url: `/g/${id}`, headers: { cookie } });
  assert.match(res.body, /<title>Sun &amp; Moon — Raid Bingo<\/title>/);
  assert.ok(!res.body.includes("&amp;amp;"));
});

test("the root shows the login view signed out and the lobby signed in", async () => {
  const h = app();
  const out = await h.instance.inject({ method: "GET", url: "/" });
  assert.match(out.body, /"view":"login"/);
  assert.match(out.body, /<title>Raid Bingo<\/title>/);

  const cookie = await signIn(h);
  const inn = await h.instance.inject({ method: "GET", url: "/", headers: { cookie } });
  assert.match(inn.body, /"view":"lobby"/);
});

test("the api refuses any POST that is not application/json", async () => {
  // text/plain is a CORS-simple content type, so a cross-origin request can
  // send it with no preflight. SameSite=Lax already blocks the cookie; this
  // means CSRF does not rest on that alone.
  const h = app();
  const cookie = await signIn(h);
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
    const res = await h.instance.inject({
      method: "POST", url: "/api/games",
      headers: { cookie, "content-type": contentType },
      payload: '{"title":"x"}',
    });
    assert.equal(res.statusCode, 415, `${contentType} should be refused`);
  }
});

test("the api refuses anonymous callers", async () => {
  const h = app();
  for (const url of ["/api/games/a-b-c", "/api/games"]) {
    const res = await h.instance.inject({ method: url === "/api/games" ? "POST" : "GET", url, payload: {} });
    assert.equal(res.statusCode, 401);
  }
});

test("a malformed game id is a 404 and never reaches the database", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/g/not-a-real-id-at-all" });
  assert.equal(res.statusCode, 404);
});

test("a game link opened signed-out names the game before sending you to Discord", async () => {
  // Otherwise the OAuth round trip is a leap of faith, and a dead link wastes it.
  const h = app();
  const cookie = await signIn(h);
  const created = await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() },
  });
  const { id } = created.json() as { id: string };

  const anon = await h.instance.inject({ method: "GET", url: `/g/${id}` });
  assert.equal(anon.statusCode, 200);
  assert.match(anon.body, /"view":"login"/);
  assert.match(anon.body, /Tuesday BT run/);
  assert.match(anon.body, /"players":0/);
});

test("create, join, call and undo over the api", async () => {
  const h = app();
  const owner = await signIn(h, "owner-discord");
  const created = await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() },
  });
  assert.equal(created.statusCode, 200);
  const { id } = created.json() as { id: string };

  const joined = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/join`, headers: { cookie: owner },
    payload: { charName: "Felwarden" },
  });
  assert.equal(joined.statusCode, 200);
  const board = (joined.json() as { board: number[] }).board;
  assert.equal(board.length, 25);

  const called = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/call`, headers: { cookie: owner }, payload: { item: 3 },
  });
  assert.equal(called.statusCode, 200);
  assert.equal((called.json() as { game: { called: [number, number][] } }).game.called.length, 1);

  const undone = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/undo`, headers: { cookie: owner }, payload: { item: 3 },
  });
  assert.equal((undone.json() as { game: { called: unknown[] } }).game.called.length, 0);
});

test("a player who is not the owner cannot call", async () => {
  const h = app();
  const owner = await signIn(h, "owner-discord");
  const { id } = (await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() },
  })).json() as { id: string };

  const player = await signIn(h, "player-discord");
  await h.instance.inject({
    method: "POST", url: `/api/games/${id}/join`, headers: { cookie: player },
    payload: { charName: "Thalgrim" },
  });
  const res = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/call`, headers: { cookie: player }, payload: { item: 1 },
  });
  assert.equal(res.statusCode, 403);
});

test("a name already taken comes back with usable alternatives", async () => {
  const h = app();
  const owner = await signIn(h, "owner-discord");
  const { id } = (await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() },
  })).json() as { id: string };
  await h.instance.inject({
    method: "POST", url: `/api/games/${id}/join`, headers: { cookie: owner },
    payload: { charName: "Thalgrim" },
  });

  const player = await signIn(h, "player-discord");
  const res = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/join`, headers: { cookie: player },
    payload: { charName: "thalgrim" },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json() as { error: { code: string; suggestions?: string[] } };
  assert.equal(body.error.code, "name_taken");
  assert.ok((body.error.suggestions ?? []).length > 0);
});
