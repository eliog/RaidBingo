/**
 * Sessions and the Discord OAuth round trip.
 *
 * OAuth is a standalone login, so there is no separate recovery path to
 * build: a player on a new device simply logs in again and, because `pid` is
 * derived rather than assigned, lands back on their own games.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { endSessionSockets, type Deps } from "./app.ts";
import {
  derivePid, newSessionToken, hashSessionToken, signState, verifyState, newStateNonce,
  SESSION_MS, STATE_MAX_AGE_MS,
} from "./identity.ts";
import { DiscordError } from "./discord.ts";
import { errorPage } from "./html.ts";

export const SESSION_COOKIE = "rb_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "") continue;
    // Any cookie on the domain arrives here, not just ours, and one bad %
    // escape used to throw — a 500 on every page until the cookie was cleared.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // Skip just that one.
    }
  }
  return out;
}

function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax", // the OAuth callback is a top-level GET, which Lax permits
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) bits.push("Secure");
  reply.header("set-cookie", bits.join("; "));
}

/** Holds the login nonce between /auth/login and the callback, and nowhere else. */
export const OAUTH_COOKIE = "rb_oauth";

function setOauthCookie(reply: FastifyReply, value: string, maxAgeS: number, secure: boolean): void {
  // Lax still sends it on the top-level redirect back from discord.com.
  const bits = [`${OAUTH_COOKIE}=${value}`, "Path=/auth/callback", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (secure) bits.push("Secure");
  reply.header("set-cookie", bits.join("; "));
}

function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const bits = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) bits.push("Secure");
  reply.header("set-cookie", bits.join("; "));
}

/** The signed-in player, or null. Never throws — callers decide what to do. */
export async function currentPid(
  deps: Deps,
  request: FastifyRequest,
): Promise<string | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token === undefined || token === "") return null;
  const row = await deps.repo.findSession(hashSessionToken(token), deps.clock.now());
  return row?.pid ?? null;
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  const secure = deps.config.baseUrl.startsWith("https:");

  app.get("/auth/login", async (request, reply) => {
    const returnTo = String((request.query as Record<string, unknown>)["returnTo"] ?? "/");
    const nonce = newStateNonce();
    setOauthCookie(reply, nonce, Math.floor(STATE_MAX_AGE_MS / 1000), secure);
    const state = signState(returnTo, deps.config.sessionSecret, deps.clock.now(), nonce);
    return reply.redirect(deps.discord.authorizeUrl(state), 302);
  });

  app.get("/auth/callback", async (request, reply) => {
    const q = request.query as Record<string, unknown>;

    if (typeof q["error"] === "string") {
      // The player pressed Cancel at Discord. Not an error on their part.
      return reply.type("text/html").code(200).send(
        errorPage("Login cancelled", "You didn't finish signing in with Discord.", "/"),
      );
    }

    const code = q["code"];
    const state = q["state"];
    if (typeof code !== "string" || typeof state !== "string") {
      return reply.type("text/html").code(400).send(
        errorPage("Something went missing", "That sign-in link was incomplete. Try again.", "/"),
      );
    }

    // Without the nonce cookie this browser never started this login: someone
    // else's callback link would otherwise sign the player in as them.
    const nonce = parseCookies(request.headers.cookie)[OAUTH_COOKIE] ?? "";
    const returnTo = verifyState(state, deps.config.sessionSecret, deps.clock.now(), nonce);
    if (returnTo === null) {
      return reply.type("text/html").code(400).send(
        errorPage("That sign-in expired",
          "Sign-in links are good for ten minutes, in the browser that started them. Try again.", "/"),
      );
    }

    let discordUserId: string;
    try {
      ({ discordUserId } = await deps.discord.exchangeCode(code));
    } catch (e) {
      const retryable = e instanceof DiscordError && e.retryable;
      return reply.type("text/html").code(retryable ? 503 : 400).send(
        errorPage(
          retryable ? "Discord isn't answering" : "Sign-in failed",
          retryable
            ? "Discord is having a moment. Give it a few seconds and try again."
            : "That sign-in couldn't be completed. Try again.",
          "/",
        ),
      );
    }

    const now = deps.clock.now();
    const pid = derivePid(discordUserId, deps.config.pidSecret);
    await deps.repo.upsertPlayer(pid, now);

    const token = newSessionToken();
    await deps.repo.createSession({
      tokenHash: hashSessionToken(token),
      pid,
      createdAt: now,
      expiresAt: now + SESSION_MS,
    });

    setSessionCookie(reply, token, secure);
    setOauthCookie(reply, "", 0, secure);       // single use
    return reply.redirect(returnTo, 302);
  });

  // Logout is a plain <form method=POST>, which browsers send as urlencoded.
  // Fastify refuses a type it has no parser for, so this scope accepts it and
  // ignores the (empty) body. Encapsulated: the api still demands json.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 1024 },
      (_request, _body, done) => done(null, {}),
    );

    scope.post("/auth/logout", async (request, reply) => {
      const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (token !== undefined && token !== "") {
        const hash = hashSessionToken(token);
        await deps.repo.deleteSession(hash);
        endSessionSockets(hash);
      }
      clearSessionCookie(reply, secure);
      return reply.redirect("/", 302);
    });
  });
}
