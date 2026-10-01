import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Repository, DiscordPort } from "./ports.ts";
import type { Clock, Rng } from "../shared/seams.ts";
import { registerAuthRoutes } from "./auth.ts";
import { sharedModule, clientAsset } from "./assets.ts";
import { registerRoutes } from "./routes.ts";
import type { GameHub } from "./ws.ts";
import type { MessageView } from "./game-service.ts";

/** Set once at startup; routes notify it after a mutation. */
let hub: GameHub | null = null;
export function setHub(h: GameHub | null): void { hub = h; }
export function notifyGame(gameId: string): void { void hub?.push(gameId); }
/** One small frame per message, so chat never drags the full state along. */
export function notifyChat(gameId: string, message: MessageView): void { hub?.sendChat(gameId, message); }

export interface Deps {
  config: Config;
  repo: Repository;
  discord: DiscordPort;
  clock: Clock;
  rng: Rng;
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  const base = new URL(deps.config.baseUrl);

  // www is served a certificate too, but the canonical origin is BASE_URL:
  // the session cookie and the OAuth redirect are both pinned to it.
  app.addHook("onRequest", async (request, reply) => {
    if (request.hostname === `www.${base.hostname}`) {
      return reply.redirect(base.origin + request.url, 301);
    }
  });

  // Nothing sits in front of the app to add these (Fly's proxy only
  // terminates TLS), so they are set here. HSTS deliberately omits `preload`:
  // joining the preload list is easy and leaving it is painful.
  app.addHook("onSend", async (_request, reply) => {
    if (base.protocol === "https:") {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
    // The only third party is Google Fonts. Everything else is same-origin,
    // and there is no inline script beyond the state blob the page embeds.
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; " +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  app.get("/healthz", async () => ({ ok: true }));

  // The browser gets the same shared source the server runs, types stripped
  // at request time. One implementation of the board, not two.
  app.get<{ Params: { name: string } }>("/shared/:name", async (request, reply) => {
    const name = request.params.name.replace(/\.js$/, "");
    const js = await sharedModule(name);
    if (js === null) return reply.code(404).send("not found");
    return reply
      .type("text/javascript; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(js);
  });

  app.get<{ Params: { name: string } }>("/assets/:name", async (request, reply) => {
    const asset = await clientAsset(request.params.name);
    if (asset === null) return reply.code(404).send("not found");
    return reply
      .type(asset.type)
      .header("cache-control", "public, max-age=60")
      .send(asset.body);
  });

  registerAuthRoutes(app, deps);
  registerRoutes(app, deps);

  return app;
}
