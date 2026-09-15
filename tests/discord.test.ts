import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiscordPort, DiscordError } from "../server/discord.ts";

const cfg = {
  clientId: "app-id",
  clientSecret: "app-secret",
  redirectUri: "https://raidbingo.com/auth/callback",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("the authorize url asks for identify and nothing else", () => {
  const url = new URL(createDiscordPort(cfg).authorizeUrl("st4te"));
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("scope"), "identify");
  assert.equal(url.searchParams.get("client_id"), "app-id");
  assert.equal(url.searchParams.get("redirect_uri"), cfg.redirectUri);
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("response_type"), "code");
});

test("a successful exchange returns the id and nothing else", async () => {
  const seen: string[] = [];
  const port = createDiscordPort(cfg, async (input, init) => {
    seen.push(input);
    if (input.includes("/oauth2/token")) {
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /grant_type=authorization_code/);
      return json({ access_token: "tok", token_type: "Bearer" });
    }
    assert.match(String((init?.headers as Record<string, string>)["authorization"]), /^Bearer tok$/);
    // The real endpoint also returns username, global_name and avatar.
    return json({ id: "1099", username: "aircan", global_name: "Air Can", avatar: "abc" });
  });

  const result = await port.exchangeCode("the-code");
  assert.deepEqual(result, { discordUserId: "1099" });
  assert.deepEqual(Object.keys(result), ["discordUserId"]);
  assert.equal(seen.length, 2);
});

test("a rejected code fails without being retryable", async () => {
  const port = createDiscordPort(cfg, async () => json({ error: "invalid_grant" }, 400));
  await assert.rejects(
    port.exchangeCode("stale"),
    (e: unknown) => e instanceof DiscordError && e.retryable === false,
  );
});

test("a Discord outage is marked retryable", async () => {
  const port = createDiscordPort(cfg, async () => json({}, 503));
  await assert.rejects(
    port.exchangeCode("code"),
    (e: unknown) => e instanceof DiscordError && e.retryable === true,
  );
});

test("a malformed profile response is rejected rather than trusted", async () => {
  const port = createDiscordPort(cfg, async (input) =>
    input.includes("/oauth2/token") ? json({ access_token: "tok" }) : json({ username: "aircan" }));
  await assert.rejects(port.exchangeCode("code"), DiscordError);
});

test("the failure message never echoes the response body", async () => {
  const port = createDiscordPort(cfg, async () => json({ client_secret: "app-secret" }, 400));
  await assert.rejects(port.exchangeCode("code"), (e: unknown) => {
    assert.ok(e instanceof DiscordError);
    assert.ok(!e.message.includes("app-secret"));
    return true;
  });
});
