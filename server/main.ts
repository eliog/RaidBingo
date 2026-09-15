/**
 * Wires the real implementations together and listens.
 * Everything above this file takes its dependencies as arguments.
 */

import { loadConfig } from "./config.ts";
import { openDatabase, createRepository } from "./db.ts";
import { createDiscordPort } from "./discord.ts";
import { buildApp, setHub } from "./app.ts";
import { GameHub } from "./ws.ts";
import { systemClock, cryptoRng } from "../shared/seams.ts";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const config = (() => {
  try {
    return loadConfig(process.env);
  } catch (e) {
    console.error(`\nRefusing to start: ${(e as Error).message}\n`);
    process.exit(1);
  }
})();

if (config.dbPath !== ":memory:") {
  await mkdir(path.dirname(path.resolve(config.dbPath)), { recursive: true });
}

const repo = createRepository(openDatabase(config.dbPath));
const deps = {
  config,
  repo,
  discord: createDiscordPort({
    clientId: config.discordClientId,
    clientSecret: config.discordClientSecret,
    redirectUri: config.redirectUri,
  }),
  clock: systemClock,
  rng: cryptoRng,
};

const hub = new GameHub(deps);
const app = buildApp(deps);
setHub(hub);

await app.listen({ port: config.port, host: "0.0.0.0" });
hub.attach(app.server);
console.log(`raid bingo listening on ${config.baseUrl} (port ${config.port})`);

// A deploy drops every socket mid-raid. Saying goodbye first lets clients use
// calmer copy and a fast backoff instead of the cold-drop one.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    hub.goodbye("restart");
    // A beat for the goodbye to flush before the sockets are torn down.
    setTimeout(() => {
      hub.close();
      void app.close().then(() => process.exit(0));
    }, 150);
  });
}
