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
/** A session ended: close the sockets it opened. */
export function endSessionSockets(tokenHash: string): void { hub?.endSession(tokenHash); }
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

  // A 4xx is about the request and says what was wrong. A 5xx is about us,
  // and its message can carry internals (a renderer's parse error, a path),
  // so the client gets a fixed one.
  app.setErrorHandler(async (error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return reply.send(error);
    return reply.code(500).send({ error: { code: "internal", message: "Something went wrong on our side." } });
  });

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
    // Pages and api answers are per player — a lobby, a board, chat — so
    // nothing may keep a copy: no shared cache, and no back button showing a
    // board after logout. The few public files set their own and keep it.
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    // No cross-origin window keeps a handle on ours (login is a full-page
    // redirect to Discord, not a popup), and no other site may embed our
    // responses — except the preview image, which sets its own.
    reply.header("cross-origin-opener-policy", "same-origin");
    if (!reply.hasHeader("cross-origin-resource-policy")) reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    reply.header("x-frame-options", "DENY");
    reply.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
    // The only third party is Google Fonts. Everything else is same-origin.
    // No inline script may run — the page state is a JSON data block, not a
    // script — so an injected <script> or on…= handler would be inert.
    // style-src keeps 'unsafe-inline' for style attributes; styles can't run code.
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; object-src 'none'; " +
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
