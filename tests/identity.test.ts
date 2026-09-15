import { test } from "node:test";
import assert from "node:assert/strict";
import {
  derivePid, newSessionToken, hashSessionToken,
  signState, verifyState, STATE_MAX_AGE_MS,
} from "../server/identity.ts";

const SECRET = "a".repeat(64);
const OTHER = "b".repeat(64);

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
  const state = signState("/g/wyrm-lantern-ward", SECRET, now);
  assert.equal(verifyState(state, SECRET, now + 1000), "/g/wyrm-lantern-ward");
});

test("state signed with another secret is rejected", () => {
  const now = Date.now();
  assert.equal(verifyState(signState("/", OTHER, now), SECRET, now), null);
});

test("a tampered state is rejected", () => {
  const now = Date.now();
  const state = signState("/g/a-b-c", SECRET, now);
  const [body, sig] = state.split(".") as [string, string];
  assert.equal(verifyState(`${body}x.${sig}`, SECRET, now), null);
  assert.equal(verifyState(`${body}.${sig}x`, SECRET, now), null);
  assert.equal(verifyState("garbage", SECRET, now), null);
});

test("an expired state is rejected, so a stale login link cannot be replayed", () => {
  const now = Date.now();
  const state = signState("/", SECRET, now);
  assert.equal(verifyState(state, SECRET, now + STATE_MAX_AGE_MS + 1), null);
});

test("an absolute url in returnTo is downgraded to the site root", () => {
  const now = Date.now();
  // An open redirect would let a game link carry someone off-site after login.
  assert.equal(verifyState(signState("https://evil.example/x", SECRET, now), SECRET, now), "/");
  assert.equal(verifyState(signState("//evil.example/x", SECRET, now), SECRET, now), "/");
});
