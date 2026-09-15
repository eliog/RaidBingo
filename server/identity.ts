/**
 * Player identity and session tokens.
 *
 * The raw Discord id never leaves this module: everything downstream works
 * from `pid`, which is derived rather than assigned. The same Discord account
 * always yields the same pid, on any device, forever — which is what makes
 * logging in from a new phone restore your games rather than hand you a
 * second, different card.
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 132 bits of a keyed hash. Opaque, stable, and not reversible to a Discord id. */
export function derivePid(discordUserId: string, pidSecret: string): string {
  if (discordUserId === "") throw new Error("discordUserId is empty");
  return createHmac("sha256", pidSecret).update(discordUserId, "utf8").digest("base64url").slice(0, 22);
}

export const SESSION_DAYS = 90;
export const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

/** The value that goes in the cookie. Never stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database holds, so a leaked table cannot be replayed as a login. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface StatePayload {
  /** Where to send the browser after login — a path, never an absolute url. */
  returnTo: string;
  issuedAt: number;
  nonce: string;
}

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/**
 * The OAuth `state` parameter, signed so the callback can trust it, and
 * carrying the deep link the player originally clicked.
 */
export function signState(returnTo: string, secret: string, now: number): string {
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  const body = b64u(JSON.stringify({ returnTo: safe, issuedAt: now, nonce: randomBytes(9).toString("base64url") } satisfies StatePayload));
  const sig = createHmac("sha256", secret).update(body, "utf8").digest("base64url");
  return `${body}.${sig}`;
}

export const STATE_MAX_AGE_MS = 10 * 60 * 1000;

/** Returns the return path, or null if the state was forged, mangled or stale. */
export function verifyState(state: string, secret: string, now: number): string | null {
  const dot = state.indexOf(".");
  if (dot < 1) return null;
  const body = state.slice(0, dot);
  const given = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("base64url");

  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(unb64u(body)) as StatePayload;
  } catch {
    return null;
  }
  if (typeof payload.issuedAt !== "number") return null;
  if (now - payload.issuedAt > STATE_MAX_AGE_MS) return null;
  if (now + 60_000 < payload.issuedAt) return null; // issued in the future
  const back = payload.returnTo;
  if (typeof back !== "string" || !back.startsWith("/") || back.startsWith("//")) return "/";
  return back;
}
