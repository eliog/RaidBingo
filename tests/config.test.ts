import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, ConfigError } from "../server/config.ts";

const S1 = "a".repeat(64);
const S2 = "b".repeat(64);

const valid = (): Record<string, string | undefined> => ({
  DISCORD_CLIENT_ID: "1234567890",
  DISCORD_CLIENT_SECRET: "c".repeat(40),
  PID_SECRET: S1,
  SESSION_SECRET: S2,
  BASE_URL: "https://raidbingo.com",
});

test("accepts a complete environment and derives the redirect uri", () => {
  const c = loadConfig(valid());
  assert.equal(c.baseUrl, "https://raidbingo.com");
  assert.equal(c.redirectUri, "https://raidbingo.com/auth/callback");
  assert.equal(c.port, 3000);
  assert.equal(c.dbPath, "./data/bingo.db");
});

test("a trailing slash on BASE_URL does not double up in the redirect uri", () => {
  const c = loadConfig({ ...valid(), BASE_URL: "https://raidbingo.com/" });
  assert.equal(c.redirectUri, "https://raidbingo.com/auth/callback");
});

test("throws when a required value is missing", () => {
  const env = valid();
  delete env["PID_SECRET"];
  assert.throws(() => loadConfig(env), ConfigError);
});

test("throws when a value still holds its placeholder", () => {
  // The whole point of the loader: a shipped default would be silent.
  for (const placeholder of ["REPLACE_ME", "changeme", "dev-secret-change-me"]) {
    assert.throws(
      () => loadConfig({ ...valid(), PID_SECRET: placeholder }),
      (e: unknown) => e instanceof ConfigError && /placeholder/.test(e.message),
      `expected ${placeholder} to be rejected`,
    );
  }
});

test("throws on a secret that is too short to be real", () => {
  assert.throws(
    () => loadConfig({ ...valid(), SESSION_SECRET: "short" }),
    (e: unknown) => e instanceof ConfigError && /at least 32/.test(e.message),
  );
});

test("refuses to let PID_SECRET and SESSION_SECRET be the same value", () => {
  assert.throws(
    () => loadConfig({ ...valid(), SESSION_SECRET: S1 }),
    (e: unknown) => e instanceof ConfigError && /must differ/.test(e.message),
  );
});

test("refuses http on a real host, because Secure cookies would silently fail", () => {
  assert.throws(
    () => loadConfig({ ...valid(), BASE_URL: "http://raidbingo.com" }),
    (e: unknown) => e instanceof ConfigError && /Secure/.test(e.message),
  );
});

test("allows http on localhost, which browsers treat as a secure context", () => {
  const c = loadConfig({ ...valid(), BASE_URL: "http://localhost:3000" });
  assert.equal(c.baseUrl, "http://localhost:3000");
});

test("rejects a nonsense port", () => {
  assert.throws(() => loadConfig({ ...valid(), PORT: "70000" }), ConfigError);
  assert.throws(() => loadConfig({ ...valid(), PORT: "http" }), ConfigError);
});
