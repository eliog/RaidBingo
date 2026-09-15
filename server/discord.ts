/**
 * The Discord seam. OAuth2 with the `identify` scope only — no bot, no admin
 * rights in any server, no guild binding.
 *
 * `fetch` is injected so tests can drive the whole flow without ever touching
 * the real API.
 */

import type { DiscordPort } from "./ports.ts";

const AUTHORIZE = "https://discord.com/oauth2/authorize";
const TOKEN = "https://discord.com/api/v10/oauth2/token";
const ME = "https://discord.com/api/v10/users/@me";

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export class DiscordError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "DiscordError";
    this.retryable = retryable;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createDiscordPort(cfg: DiscordConfig, fetchImpl: FetchLike = fetch): DiscordPort {
  return {
    authorizeUrl(state: string): string {
      const q = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri,
        response_type: "code",
        scope: "identify",
        state,
        prompt: "none",
      });
      return `${AUTHORIZE}?${q.toString()}`;
    },

    async exchangeCode(code: string): Promise<{ discordUserId: string }> {
      const tokenRes = await fetchImpl(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: cfg.redirectUri,
        }).toString(),
      });

      if (!tokenRes.ok) {
        // Never log or echo the body: it can carry the client secret back.
        throw new DiscordError(
          `token exchange failed with ${tokenRes.status}`,
          tokenRes.status >= 500,
        );
      }

      const token = (await tokenRes.json()) as { access_token?: unknown };
      if (typeof token.access_token !== "string" || token.access_token === "") {
        throw new DiscordError("token exchange returned no access token", false);
      }

      const meRes = await fetchImpl(ME, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!meRes.ok) {
        throw new DiscordError(`profile lookup failed with ${meRes.status}`, meRes.status >= 500);
      }

      const me = (await meRes.json()) as { id?: unknown };
      if (typeof me.id !== "string" || me.id === "") {
        throw new DiscordError("profile lookup returned no id", false);
      }

      // The response also carries username, global_name and avatar. They are
      // deliberately not read, returned, stored or logged — the display name
      // is typed by the player, and the id is immediately hashed into a pid.
      return { discordUserId: me.id };
    },
  };
}
