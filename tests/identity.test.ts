import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePid, newSessionToken, hashSessionToken,
  signState, verifyState, safeReturnTo, STATE_MAX_AGE_MS,
} from "../server/identity.ts";
import { parseCookies } from "../server/auth.ts";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);
const NONCE = "n0nce-from-the-login-cookie";

test("the same Discord account always derives the same pid", () => {
  // This is the property that makes logging in from a new device restore your
  // games rather than deal you a second, different card.
  assert.equal(derivePid("123456789", SECRET), derivePid("123456789", SECRET));
});

test("different accounts and different secrets derive different pids", () => {
  assert.notEqual(derivePid("1", SECRET), derivePid("2", SECRET));
  assert.notEqual(derivePid("1", SECRET), derivePid("1", OTHER));
});

test("a pid does not contain the Discord id it came from", () => {
  const pid = derivePid("987654321098765432", SECRET);
  assert.ok(!pid.includes("987654"));
  assert.match(pid, /^[A-Za-z0-9_-]{22}$/);
});

test("session tokens are unique and stored only as a hash", () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  const h = hashSessionToken(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes(a));
  assert.equal(h, hashSessionToken(a));
});

test("state round-trips the path the player originally clicked", () => {
  const now = 1_700_000_000_000;
  const state = signState("/g/wyrm-lantern-ward", SECRET, now, NONCE);
  assert.equal(verifyState(state, SECRET, now + 1000, NONCE), "/g/wyrm-lantern-ward");
});

test("state signed with another secret is rejected", () => {
  const now = Date.now();
  assert.equal(verifyState(signState("/", OTHER, now, NONCE), SECRET, now, NONCE), null);
});

test("a tampered state is rejected", () => {
  const now = Date.now();
  const state = signState("/g/a-b-c", SECRET, now, NONCE);
  const [body, sig] = state.split(".") as [string, string];
  assert.equal(verifyState(`${body}x.${sig}`, SECRET, now, NONCE), null);
  assert.equal(verifyState(`${body}.${sig}x`, SECRET, now, NONCE), null);
  assert.equal(verifyState("garbage", SECRET, now, NONCE), null);
});

test("an expired state is rejected, so a stale login link cannot be replayed", () => {
  const now = Date.now();
  const state = signState("/", SECRET, now, NONCE);
  assert.equal(verifyState(state, SECRET, now + STATE_MAX_AGE_MS + 1, NONCE), null);
});

test("an absolute url in returnTo is downgraded to the site root", () => {
  const now = Date.now();
  // An open redirect would let a game link carry someone off-site after login.
  assert.equal(verifyState(signState("https://evil.example/x", SECRET, now, NONCE), SECRET, now, NONCE), "/");
  assert.equal(verifyState(signState("//evil.example/x", SECRET, now, NONCE), SECRET, now, NONCE), "/");
});

test("returnTo values a browser would resolve off-site are downgraded to the root (#6)", () => {
  const now = Date.now();
  const base = "https://raidbingo.test";
  const hostile = ["/\\evil.example", "/\\/evil.example", "/\t/evil.example", "/\n/evil.example",
    "\\\\evil.example", "/ /evil.example", "/x\\y", "/x\r\ny", "javascript:alert(1)", ""];
  for (const rt of hostile) {
    const back = verifyState(signState(rt, SECRET, now, NONCE), SECRET, now, NONCE);
    assert.equal(back, "/", JSON.stringify(rt));
  }
  // The guard is about where a browser lands, so check that directly too.
  for (const rt of hostile) assert.equal(new URL(safeReturnTo(rt), base).origin, base, JSON.stringify(rt));

  for (const rt of ["/", "/new", "/g/wyrm-lantern-ward", "/%2F/stays-here", "/g/a-b-c?x=1"]) {
    assert.equal(verifyState(signState(rt, SECRET, now, NONCE), SECRET, now, NONCE), rt);
  }
});

test("a state only verifies with the nonce it was issued with (#10)", () => {
  const now = Date.now();
  const state = signState("/new", SECRET, now, NONCE);
  assert.equal(verifyState(state, SECRET, now, NONCE), "/new");
  for (const other of ["", "someone-elses-nonce", NONCE + "x", NONCE.slice(1)]) {
    assert.equal(verifyState(state, SECRET, now, other), null, JSON.stringify(other));
  }
});

test("parseCookies never throws, and keeps the good cookies around a bad one (#16)", () => {
  assert.deepEqual(parseCookies("a=1; b=%E0%A4%A; c=hello%20there; d=%"), { a: "1", c: "hello there" });
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies("=x; ;novalue; e=2"), { e: "2" });
});
