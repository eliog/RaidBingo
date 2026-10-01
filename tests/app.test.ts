import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.ts";
import { createRepository, openDatabase } from "../server/db.ts";
import { fixedClock, seededRng } from "../shared/seams.ts";
import { derivePid } from "../server/identity.ts";
import { testConfig, fakeDiscord, items, T0 } from "./helpers.ts";
import { SESSION_COOKIE, OAUTH_COOKIE } from "../server/auth.ts";
import { LOOKUP_MISSES, LOOKUP_WINDOW_MS } from "../server/routes.ts";
import { apiRequest } from "../shared/request.ts";
import { SIGNED_OUT } from "../server/ws.ts";
import { SESSION_MS } from "../server/identity.ts";
import { usePresetFile } from "../server/presets.ts";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const cb = await h.instance.inject({ method: "GET", url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieFrom(login.headers["set-cookie"]) } });
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
  const res = await h.instance.inject({ method: "GET", url: `/auth/callback?code=xyz&state=${encodeURIComponent(state)}`,
    headers: { cookie: cookieFrom(login.headers["set-cookie"]) } });

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

test("logging out works from the real form, which a browser sends as urlencoded", async () => {
  // The menu submits an empty <form method=POST>. Browsers label that
  // application/x-www-form-urlencoded, which inject() does not do by default.
  const h = app();
  const cookie = await signIn(h);
  const out = await h.instance.inject({
    method: "POST", url: "/auth/logout", payload: "",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(out.statusCode, 302);
  const after = await h.instance.inject({ method: "GET", url: "/api/games/a-b-c", headers: { cookie } });
  assert.equal(after.statusCode, 401);
});

test("the urlencoded allowance stops at logout; the api still demands json", async () => {
  const h = app();
  const cookie = await signIn(h);
  const res = await h.instance.inject({
    method: "POST", url: "/api/games", payload: "title=x",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.statusCode, 415);
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

test("security headers are set by the app, since no proxy in front adds them", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.match(String(res.headers["content-security-policy"]), /frame-ancestors 'none'/);
});

test("www redirects to the canonical origin, keeping the path", async () => {
  const h = app();
  const res = await h.instance.inject({
    method: "GET", url: "/g/a-b-c?x=1", headers: { host: "www.raidbingo.test" },
  });
  assert.equal(res.statusCode, 301);
  assert.equal(res.headers["location"], "https://raidbingo.test/g/a-b-c?x=1");
});

/* ----------------------------------------------------------------- chat */

async function chatGame(h: ReturnType<typeof app>) {
  const owner = await signIn(h, "owner-discord");
  const { id } = (await h.instance.inject({
    method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() },
  })).json() as { id: string };
  await h.instance.inject({
    method: "POST", url: `/api/games/${id}/join`, headers: { cookie: owner }, payload: { charName: "Felwarden" },
  });
  const stranger = await signIn(h, "stranger-discord");
  return { id, owner, stranger };
}

test("chat needs a session", async () => {
  const h = app();
  const { id } = await chatGame(h);
  const post = await h.instance.inject({ method: "POST", url: `/api/games/${id}/chat`, payload: { text: "hi" } });
  const get = await h.instance.inject({ method: "GET", url: `/api/games/${id}/chat` });
  assert.equal(post.statusCode, 401);
  assert.equal(get.statusCode, 401);
});

test("chat is roster-only, both ways", async () => {
  const h = app();
  const { id, stranger } = await chatGame(h);
  const post = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/chat`, headers: { cookie: stranger }, payload: { text: "hi" },
  });
  const get = await h.instance.inject({ method: "GET", url: `/api/games/${id}/chat`, headers: { cookie: stranger } });
  assert.equal(post.statusCode, 403);
  assert.equal(get.statusCode, 403);
});

test("a bad cursor, or both cursors, is a 400", async () => {
  const h = app();
  const { id, owner } = await chatGame(h);
  for (const qs of ["after=-1", "after=abc", "after=1.5", "before=9999999999999999", "after=1&before=5"]) {
    const res = await h.instance.inject({ method: "GET", url: `/api/games/${id}/chat?${qs}`, headers: { cookie: owner } });
    assert.equal(res.statusCode, 400, qs);
  }
  const fine = await h.instance.inject({ method: "GET", url: `/api/games/${id}/chat`, headers: { cookie: owner } });
  assert.deepEqual(fine.json(), { messages: [] });
});

test("an oversized chat body is refused before it is parsed", async () => {
  const h = app();
  const { id, owner } = await chatGame(h);
  const res = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/chat`, headers: { cookie: owner },
    payload: { text: "x".repeat(5000) },
  });
  assert.equal(res.statusCode, 413);
});

test("hostile text round-trips verbatim, and the sender is the session, not the body", async () => {
  const h = app();
  const { id, owner } = await chatGame(h);
  const hostile = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
  const res = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/chat`, headers: { cookie: owner },
    payload: { text: hostile, charName: "Someone Else", pid: "spoofed" },
  });
  assert.equal(res.statusCode, 200);
  const { message } = res.json() as { message: { seq: number; charName: string; text: string } };
  assert.equal(message.text, hostile);
  assert.equal(message.charName, "Felwarden");

  const page = await h.instance.inject({ method: "GET", url: `/api/games/${id}/chat?after=0`, headers: { cookie: owner } });
  assert.equal((page.json() as { messages: { text: string }[] }).messages[0]?.text, hostile);
});

test("a full chat is a 409 with its own code, not a 429", async () => {
  const h = app();
  const { id, owner } = await chatGame(h);
  const game = await h.repo.getGame(id);
  const ownerRow = (await h.repo.rosterFor(id))[0];
  assert.ok(game && ownerRow);
  for (let i = 0; i < 5000; i++) await h.repo.addMessage(id, ownerRow.pid, `m${i}`, T0, 5000);
  const res = await h.instance.inject({
    method: "POST", url: `/api/games/${id}/chat`, headers: { cookie: owner }, payload: { text: "hello?" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { error: { code: string } }).error.code, "full");
});

test("the theme choice is stored on the player and painted from the first frame", async () => {
  const h = app();
  const cookie = await signIn(h);
  const before = await h.instance.inject({ method: "GET", url: "/", headers: { cookie } });
  assert.match(before.body, /<html lang="en">/, "auto leaves the device in charge");
  assert.match(before.body, /theme-color" media="\(prefers-color-scheme: dark\)"/);

  const set = await h.instance.inject({
    method: "POST", url: "/api/me/theme", headers: { cookie }, payload: { theme: "light" },
  });
  assert.equal(set.statusCode, 200);

  // A new device is just a new session for the same pid.
  const elsewhere = await signIn(h);
  const after = await h.instance.inject({ method: "GET", url: "/", headers: { cookie: elsewhere } });
  assert.match(after.body, /<html lang="en" data-theme="light">/);
  assert.match(after.body, /<meta name="theme-color" content="#E8DFC8">/);
  assert.match(after.body, /"theme":"light"/);
});

test("a theme outside the three choices is refused, and so is an anonymous one", async () => {
  const h = app();
  const cookie = await signIn(h);
  for (const theme of ["purple", "", null, 1, '" onload="x']) {
    const res = await h.instance.inject({
      method: "POST", url: "/api/me/theme", headers: { cookie }, payload: { theme },
    });
    assert.equal(res.statusCode, 400, String(theme));
  }
  const anon = await h.instance.inject({ method: "POST", url: "/api/me/theme", payload: { theme: "dark" } });
  assert.equal(anon.statusCode, 401);
});

test("a stranger's game page and api carry no squares, names or boards (#8)", async () => {
  const h = app();
  const owner = await signIn(h, "1");
  const stranger = await signIn(h, "2");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  await h.instance.inject({ method: "POST", url: `/api/games/${id}/join`, headers: { cookie: owner },
    payload: { charName: "Felwarden" } });

  for (const url of [`/g/${id}`, `/api/games/${id}`]) {
    const res = await h.instance.inject({ method: "GET", url, headers: { cookie: stranger } });
    assert.equal(res.statusCode, 200, url);
    assert.ok(!res.body.includes("Felwarden"), `${url} leaked a name`);
    assert.ok(!res.body.includes(items()[0] as string), `${url} leaked a square`);
  }
});

test("guessing game ids is limited across every route, and the limit hides hits too (#9)", async () => {
  const h = app();
  const owner = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie: owner },
    payload: { title: "Tuesday BT run", items: items() } });
  const real = (made.json() as { id: string }).id;
  const guesser = { "fly-client-ip": "203.0.113.9" };

  // Misses spread over the signed-out routes all count against one budget.
  const routes = ["/g/wyrm-lantern-ward", "/og/wyrm-lantern-ward.png"];
  for (let i = 0; i < LOOKUP_MISSES; i++) {
    const res = await h.instance.inject({ method: "GET", url: routes[i % 2] as string, headers: guesser });
    assert.equal(res.statusCode, 404);
  }
  for (const url of [...routes, `/g/${real}`, `/og/${real}.png`]) {
    const res = await h.instance.inject({ method: "GET", url, headers: guesser });
    assert.equal(res.statusCode, 429, `${url} should be refused, real or not`);
    assert.ok(Number(res.headers["retry-after"]) > 0);
  }

  // Someone else is unaffected, and the window passes.
  const other = await h.instance.inject({ method: "GET", url: `/g/${real}`, headers: { "fly-client-ip": "198.51.100.4" } });
  assert.equal(other.statusCode, 200);
  h.clock.advance(LOOKUP_WINDOW_MS);
  const later = await h.instance.inject({ method: "GET", url: `/g/${real}`, headers: guesser });
  assert.equal(later.statusCode, 200);
});

test("a signed-in guesser is limited by account as well as by address (#9)", async () => {
  const h = app();
  const cookie = await signIn(h, "7");
  for (let i = 0; i < LOOKUP_MISSES; i++) {
    const ip = { cookie, "fly-client-ip": `203.0.113.${i}` };   // a new address every time
    assert.equal((await h.instance.inject({ method: "GET", url: "/api/games/wyrm-lantern-ward", headers: ip })).statusCode, 404);
  }
  const res = await h.instance.inject({ method: "GET", url: "/api/games/wyrm-lantern-ward",
    headers: { cookie, "fly-client-ip": "198.51.100.99" } });
  assert.equal(res.statusCode, 429);
});

test("hits never count, so a busy player is never limited (#9)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  for (let i = 0; i < LOOKUP_MISSES * 3; i++) {
    assert.equal((await h.instance.inject({ method: "GET", url: `/api/games/${id}`, headers: { cookie } })).statusCode, 200);
  }
});

test("a callback link only works in the browser that started the login (#10)", async () => {
  const h = app();
  // The attacker starts a login in their own browser and stops at the callback.
  const theirs = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2F" });
  const state = new URL(theirs.headers["location"] as string).searchParams.get("state") as string;
  const theirCookie = cookieFrom(theirs.headers["set-cookie"]);
  assert.match(theirs.headers["set-cookie"] as string, /Path=\/auth\/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  const callback = `/auth/callback?code=attacker&state=${encodeURIComponent(state)}`;

  // The victim opens that link: no nonce cookie, or one from their own login.
  const mine = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2F" });
  for (const cookie of [undefined, cookieFrom(mine.headers["set-cookie"]), `${OAUTH_COOKIE}=`]) {
    const res = await h.instance.inject({ method: "GET", url: callback, headers: cookie ? { cookie } : {} });
    assert.equal(res.statusCode, 400, String(cookie));
    assert.equal(res.headers["set-cookie"], undefined, "no session was issued");
  }

  // In the browser that started it, it works once, and clears the nonce.
  const ok = await h.instance.inject({ method: "GET", url: callback, headers: { cookie: theirCookie } });
  assert.equal(ok.statusCode, 302);
  const set = ok.headers["set-cookie"] as string[];
  assert.match(set[0] as string, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(set[1] as string, new RegExp(`^${OAUTH_COOKIE}=; Path=/auth/callback;.*Max-Age=0`));
});

test("renaming a closed game over the api is a 409 (#14)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  const rename = (title: string) => h.instance.inject({ method: "POST", url: `/api/games/${id}/title`,
    headers: { cookie }, payload: { title } });
  assert.equal((await rename("Wednesday BT run")).statusCode, 200);
  assert.equal((await h.instance.inject({ method: "POST", url: `/api/games/${id}/close`, headers: { cookie }, payload: {} })).statusCode, 200);
  const late = await rename("Rewritten");
  assert.equal(late.statusCode, 409);
  assert.equal((late.json() as { error: { code: string } }).error.code, "closed");
});

test("Close game works when sent exactly the way the browser sends it (#19)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;

  // The client's api() builds every request with apiRequest(); this is the close.
  const req = apiRequest();
  const res = await h.instance.inject({ method: req.method as "POST", url: `/api/games/${id}/close`,
    headers: { ...req.headers, cookie }, payload: req.body ?? "" });
  assert.equal(res.statusCode, 200);
  assert.notEqual((await h.repo.getGame(id))?.closedAt, null, "the game is actually closed");

  // The guard it tripped is still there for anything that isn't JSON.
  const bare = await h.instance.inject({ method: "POST", url: `/api/games/${id}/close`, headers: { cookie } });
  assert.equal(bare.statusCode, 415);
});

test("the client gets its request builder from /shared, and uses it (#19)", async () => {
  const h = app();
  const mod = await h.instance.inject({ method: "GET", url: "/shared/request.js" });
  assert.equal(mod.statusCode, 200);
  assert.ok(mod.body.includes("export function apiRequest"));
  const client = await h.instance.inject({ method: "GET", url: "/assets/app.js" });
  assert.match(client.body, /import \{ apiRequest \} from "\/shared\/request\.js"/);
  assert.match(client.body, /fetch\(path, apiRequest\(body, method\)\)/);
  assert.equal(client.body.match(/\bfetch\(/g)?.length, 1, "every request goes through api()");
});

test("call and undo accept only an integer square, and garbage calls nothing (#15)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  const send = (path: "call" | "undo", body: unknown) => h.instance.inject({
    method: "POST", url: `/api/games/${id}/${path}`, headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });

  // Each of these used to coerce to a square: null, "", false and [] to 0, "5" and [5] to 5.
  const garbage = [{ item: null }, { item: "" }, { item: false }, { item: [] }, { item: "5" }, { item: [5] },
    { item: true }, { item: {} }, {}, { item: 1.5 }, { item: -1 }, { item: 24 }, { item: 1e9 }];
  for (const path of ["call", "undo"] as const) {
    for (const body of garbage) {
      const res = await send(path, body);
      assert.equal(res.statusCode, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal((res.json() as { error: { code: string } }).error.code, "invalid");
    }
  }
  assert.equal((await h.repo.callsFor(id)).size, 0, "nothing was called");

  // The real thing still works, at both ends of the board.
  for (const item of [0, 23]) assert.equal((await send("call", { item })).statusCode, 200);
  assert.deepEqual([...(await h.repo.callsFor(id)).keys()].sort((a, b) => a - b), [0, 23]);
  assert.equal((await send("undo", { item: 0 })).statusCode, 200);
  assert.deepEqual([...(await h.repo.callsFor(id)).keys()], [23]);
});

test("a malformed cookie is skipped, not a 500 on every page (#16)", async () => {
  const h = app();
  const session = await signIn(h, "1");
  const junk = "tracker=%E0%A4%A; other=%";

  // Someone else's broken cookie alongside a good session: still signed in.
  for (const url of ["/", "/new"]) {
    const res = await h.instance.inject({ method: "GET", url, headers: { cookie: `${junk}; ${session}` } });
    assert.equal(res.statusCode, 200, url);
    assert.ok(!res.body.includes('"view":"login"'), `${url} should still be signed in`);
  }
  const api = await h.instance.inject({ method: "GET", url: "/api/games/wyrm-lantern-ward", headers: { cookie: `${session}; ${junk}` } });
  assert.equal(api.statusCode, 404, "reached the route, signed in");

  // A broken session cookie itself just means signed out.
  const bad = await h.instance.inject({ method: "GET", url: "/", headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` } });
  assert.equal(bad.statusCode, 200);
  assert.ok(bad.body.includes('"view":"login"'));
});

test("an unexpected 500 never shows the internal error, and 4xx keep theirs (#17)", async () => {
  const h = app();
  h.instance.get("/boom", async () => { throw new Error("resvg: XML parse error at 1:57 /srv/secret/path"); });
  const res = await h.instance.inject({ method: "GET", url: "/boom" });
  assert.equal(res.statusCode, 500);
  assert.ok(!res.body.includes("resvg") && !res.body.includes("/srv"), res.body);
  assert.deepEqual(res.json(), { error: { code: "internal", message: "Something went wrong on our side." } });

  // A client mistake still says what was wrong.
  const cookie = await signIn(h, "1");
  const big = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie, "content-type": "application/json" },
    payload: "{not json" });
  assert.equal(big.statusCode, 400);
  assert.ok(big.body.length > 0 && !big.body.includes("Something went wrong on our side"));
});

test("presets go to anyone who logs in — deliberately, see README (#18)", async () => {
  // If this fails because presets became gated, that was a decision: update
  // the README and CLAUDE.md, which tell owners presets are effectively public.
  const file = path.join(tmpdir(), `rb-presets-app-${process.pid}.json`);
  await writeFile(file, JSON.stringify([{ name: "Raid night", items: items() }]), "utf8");
  usePresetFile(file);
  try {
    const h = app();
    const stranger = await signIn(h, "9999");          // has never played anything
    const res = await h.instance.inject({ method: "GET", url: "/new", headers: { cookie: stranger } });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('"name":"Raid night"'));
  } finally {
    usePresetFile(null);
    await rm(file, { force: true });
  }
});

test("the client treats close code 4401 as signed out, not as a blip to retry (#21)", async () => {
  const h = app();
  const client = await h.instance.inject({ method: "GET", url: "/assets/app.js" });
  assert.match(client.body, /if \(ev\.code === 4401\) \{ location\.reload\(\); return; \}/);
  assert.equal(SIGNED_OUT, 4401, "server and client agree on the code");
});

/** Logs in again from a browser that already holds `existing` (any cookie string). */
async function relogin(h: ReturnType<typeof app>, existing: string, discordUserId = "1099"): Promise<string> {
  const login = await h.instance.inject({ method: "GET", url: "/auth/login?returnTo=%2F", headers: { cookie: existing } });
  const state = new URL(login.headers["location"] as string).searchParams.get("state") as string;
  h.discord.exchangeCode = async () => ({ discordUserId });
  const cb = await h.instance.inject({ method: "GET", url: `/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie: `${existing}; ${cookieFrom(login.headers["set-cookie"])}` } });
  assert.equal(cb.statusCode, 302);
  return cookieFrom(cb.headers["set-cookie"]);
}

const signedIn = async (h: ReturnType<typeof app>, cookie: string) =>
  (await h.instance.inject({ method: "GET", url: "/api/games/wyrm-lantern-ward", headers: { cookie } })).statusCode !== 401;

test("logging in again revokes the session this browser had, and only that one (#20)", async () => {
  const h = app();
  const first = await signIn(h, "1");
  const otherDevice = await signIn(h, "1");
  const someoneElse = await signIn(h, "2");
  for (const c of [first, otherDevice, someoneElse]) assert.ok(await signedIn(h, c));

  const second = await relogin(h, first, "1");
  assert.notEqual(second, first);
  assert.equal(await signedIn(h, first), false, "the replaced token no longer works");
  assert.ok(await signedIn(h, second));
  assert.ok(await signedIn(h, otherDevice), "the player's other device stays signed in");
  assert.ok(await signedIn(h, someoneElse));
});

test("logging in as someone else from the same browser also ends the old session (#20)", async () => {
  const h = app();
  const asAlice = await signIn(h, "1");
  const asBob = await relogin(h, asAlice, "2");
  assert.equal(await signedIn(h, asAlice), false);
  assert.ok(await signedIn(h, asBob));
});

test("a re-login with a stale, unknown or malformed session cookie still works (#20)", async () => {
  const h = app();
  const stale = await signIn(h, "1");
  h.clock.advance(SESSION_MS + 1);
  for (const existing of [stale, `${SESSION_COOKIE}=never-issued`, `${SESSION_COOKIE}=%E0%A4%A`, `${SESSION_COOKIE}=`]) {
    const fresh = await relogin(h, existing, "1");
    assert.ok(await signedIn(h, fresh), existing);
  }
});

const form = { "content-type": "application/x-www-form-urlencoded" };
const logout = (h: ReturnType<typeof app>, headers: Record<string, string>) =>
  h.instance.inject({ method: "POST", url: "/auth/logout", headers: { ...form, ...headers }, payload: "" });

test("another site cannot log a player out (#23)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const attempts: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { origin: "null" },                                                 // sandboxed frame, data: url
    { origin: "https://raidbingo.test.evil.example" },
    { origin: "http://raidbingo.test" },                                // wrong scheme
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },                                  // a sibling subdomain
    { origin: "https://raidbingo.test", "sec-fetch-site": "cross-site" },
  ];
  for (const extra of attempts) {
    const res = await logout(h, { cookie, ...extra });
    assert.equal(res.statusCode, 403, JSON.stringify(extra));
    assert.equal(res.headers["set-cookie"], undefined, "nothing cleared");
    assert.ok(await signedIn(h, cookie), `still signed in after ${JSON.stringify(extra)}`);
  }
});

test("logging out from the site itself still works, from a form or a script (#23)", async () => {
  const h = app();
  for (const extra of [
    { origin: "https://raidbingo.test", "sec-fetch-site": "same-origin" },   // the real logout form
    { "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "none" },                                            // typed or bookmarked
    {},                                                                       // no browser headers at all
  ] as Record<string, string>[]) {
    const cookie = await signIn(h, "1");
    const res = await logout(h, { cookie, ...extra });
    assert.equal(res.statusCode, 302, JSON.stringify(extra));
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/);
    assert.equal(await signedIn(h, cookie), false);
  }
});

test("every page and api response says no-store; static files and the preview keep their caching (#24)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  const get = (url: string, signedIn = true) =>
    h.instance.inject({ method: "GET", url, headers: signedIn ? { cookie } : {} });

  const personal = [
    ["created game (api)", made],
    ["lobby", await get("/")],
    ["new game", await get("/new")],
    ["board / join", await get(`/g/${id}`)],
    ["signed-out root", await get("/", false)],
    ["signed-out invite", await get(`/g/${id}`, false)],
    ["no such game page", await get("/g/wyrm-lantern-ward")],
    ["malformed id page", await get("/g/NOT_AN_ID")],
    ["game api", await get(`/api/games/${id}`)],
    ["chat api", await get(`/api/games/${id}/chat`)],
    ["api 404", await get("/api/games/wyrm-lantern-ward")],
    ["api 401", await get(`/api/games/${id}`, false)],
    ["api 400", await h.instance.inject({ method: "POST", url: `/api/games/${id}/call`, headers: { cookie }, payload: { item: "x" } })],
    ["api 415", await h.instance.inject({ method: "POST", url: `/api/games/${id}/call`, headers: { cookie } })],
    ["theme api", await h.instance.inject({ method: "POST", url: "/api/me/theme", headers: { cookie }, payload: { theme: "dark" } })],
    ["login redirect", await get("/auth/login?returnTo=%2F", false)],
    ["logout", await h.instance.inject({ method: "POST", url: "/auth/logout", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "" })],
  ] as const;
  for (const [what, res] of personal) {
    assert.equal(res.headers["cache-control"], "no-store", `${what} (${res.statusCode})`);
  }

  // Public, cacheable on purpose — must not be downgraded.
  assert.equal((await get("/assets/app.css", false)).headers["cache-control"], "public, max-age=60");
  assert.equal((await get("/shared/board.js", false)).headers["cache-control"], "no-cache");
  const png = await get(`/og/${id}.png`, false);
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["cache-control"], "public, max-age=300");
});

/** The page's state block, parsed the way the client parses it. */
function stateOf(html: string): Record<string, unknown> {
  const m = /<script type="application\/json" id="rb-state">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "no rb-state block");
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

/** Every <script> tag in the page: only external files and the data block are allowed. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attrs, body]) => !/\bsrc=/.test(attrs as string) && !/type="application\/json"/.test(attrs as string) && (body as string).trim() !== "")
    .map(([tag]) => tag as string);
}

test("pages carry their state as a JSON data block, with no executable inline script (#26)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  const pages: [string, string, boolean, string][] = [
    ["signed-out root", "/", false, "login"],
    ["signed-out invite", `/g/${id}`, false, "login"],
    ["lobby", "/", true, "lobby"],
    ["new game", "/new", true, "create"],
    ["join", `/g/${id}`, true, "join"],
  ];
  for (const [what, url, signed, view] of pages) {
    const res = await h.instance.inject({ method: "GET", url, headers: signed ? { cookie } : {} });
    assert.equal(res.statusCode, 200, what);
    assert.equal(stateOf(res.body)["view"], view, what);
    assert.deepEqual(inlineScripts(res.body), [], `${what} has an executable inline script`);
    assert.ok(!res.body.includes("window.__RB__"), what);
  }
  // After joining, the board page too.
  await h.instance.inject({ method: "POST", url: `/api/games/${id}/join`, headers: { cookie }, payload: { charName: "Felwarden" } });
  const board = await h.instance.inject({ method: "GET", url: `/g/${id}`, headers: { cookie } });
  assert.equal(stateOf(board.body)["view"], "board");
  assert.deepEqual(inlineScripts(board.body), []);
});

test("hostile text cannot break out of the state block (#26)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const nasty = "</script><script>alert(1)</script><!--";
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "a</script>b<!--c", items: items().map((s, i) => (i === 0 ? nasty.slice(0, 40) : s)) } });
  assert.equal(made.statusCode, 200);
  const id = (made.json() as { id: string }).id;
  await h.instance.inject({ method: "POST", url: `/api/games/${id}/join`, headers: { cookie }, payload: { charName: "</script>x" } });

  const res = await h.instance.inject({ method: "GET", url: `/g/${id}`, headers: { cookie } });
  const state = stateOf(res.body) as { game: { title: string; items: string[]; charName: string } };
  assert.equal(state.game.title, "a</script>b<!--c", "round-trips exactly");
  assert.equal(state.game.items[0], nasty.slice(0, 40));
  assert.equal(state.game.charName, "</script>x");
  assert.deepEqual(inlineScripts(res.body), [], "nothing escaped into a runnable script");
  assert.equal((res.body.match(/<script\b/g) ?? []).length, 2, "just the data block and the module");
});

test("the policy no longer lets inline scripts run (#26)", async () => {
  const h = app();
  const res = await h.instance.inject({ method: "GET", url: "/" });
  const csp = String(res.headers["content-security-policy"]);
  const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
  assert.equal(scriptSrc.trim(), "'self'");
  assert.ok(!/'unsafe-eval'/.test(csp));
  assert.match(csp, /object-src 'none'/);
});

test("the client reads the state block, not a global (#26)", async () => {
  const h = app();
  const client = await h.instance.inject({ method: "GET", url: "/assets/app.js" });
  assert.match(client.body, /document\.getElementById\("rb-state"\)/);
  assert.ok(!client.body.includes("__RB__"));
  // And no inline handlers baked into markup the client builds.
  assert.ok(!/\bon[a-z]+="/i.test(client.body), "an inline on…= attribute would be blocked by the policy");
});

test("every response isolates its window and resources; only the preview image is shareable (#28)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  const made = await h.instance.inject({ method: "POST", url: "/api/games", headers: { cookie },
    payload: { title: "Tuesday BT run", items: items() } });
  const id = (made.json() as { id: string }).id;
  const get = (url: string, signedIn = true) =>
    h.instance.inject({ method: "GET", url, headers: signedIn ? { cookie } : {} });

  const responses = [
    ["create (api)", made], ["lobby", await get("/")], ["signed-out root", await get("/", false)],
    ["board", await get(`/g/${id}`)], ["api", await get(`/api/games/${id}`)],
    ["api 401", await get(`/api/games/${id}`, false)], ["no such game", await get("/g/wyrm-lantern-ward")],
    ["stylesheet", await get("/assets/app.css", false)], ["client", await get("/assets/app.js", false)],
    ["shared module", await get("/shared/board.js", false)], ["login redirect", await get("/auth/login", false)],
    ["missing preview", await get("/og/wyrm-lantern-ward.png", false)],
  ] as const;
  for (const [what, res] of responses) {
    assert.equal(res.headers["cross-origin-opener-policy"], "same-origin", what);
    assert.equal(res.headers["cross-origin-resource-policy"], "same-origin", what);
  }

  // Discord, and whatever shows the unfurl, has to be able to load this one.
  const png = await get(`/og/${id}.png`, false);
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(png.headers["cache-control"], "public, max-age=300", "unchanged");

  // The headers that were already there are still there.
  const page = await get("/");
  for (const h of ["content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "strict-transport-security"]) {
    assert.ok(page.headers[h], h);
  }
});

test("every page carries the running version, and the client renders the footer (#32)", async () => {
  const h = app();
  const cookie = await signIn(h, "1");
  for (const [url, signed] of [["/", false], ["/", true], ["/new", true]] as const) {
    const res = await h.instance.inject({ method: "GET", url, headers: signed ? { cookie } : {} });
    assert.match(String(stateOf(res.body)["version"]), /^([0-9a-f]{7}|dev)$/, url);
  }
  const client = (await h.instance.inject({ method: "GET", url: "/assets/app.js" })).body;
  assert.match(client, /import \{ QUIPS, nextQuip, QUIP_EVERY_MS \} from "\/shared\/quips\.js"/);
  assert.match(client, /setInterval\(\(\) => \{[\s\S]*?\}, QUIP_EVERY_MS\);/);
  assert.match(client, /all rights not reserved/);
  assert.match(client, /root\.append\(siteFooter\(\)\)/);
  const quips = await h.instance.inject({ method: "GET", url: "/shared/quips.js" });
  assert.equal(quips.statusCode, 200);
});
