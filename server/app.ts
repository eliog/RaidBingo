import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Repository, DiscordPort } from "./ports.ts";
import type { Clock, Rng } from "../shared/seams.ts";
import { registerAuthRoutes } from "./auth.ts";
import { sharedModule, clientAsset } from "./assets.ts";
import { registerRoutes } from "./routes.ts";
import type { GameHub } from "./ws.ts";

/** Set once at startup; routes notify it after a mutation. */
let hub: GameHub | null = null;
export function setHub(h: GameHub | null): void { hub = h; }
export function notifyGame(gameId: string): void { void hub?.push(gameId); }

export interface Deps {
  config: Config;
  repo: Repository;
  discord: DiscordPort;
  clock: Clock;
  rng: Rng;
}

export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });

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
