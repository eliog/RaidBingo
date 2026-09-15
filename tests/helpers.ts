import { openDatabase, createRepository } from "../server/db.ts";
import { GameService } from "../server/game-service.ts";
import { fixedClock, seededRng } from "../shared/seams.ts";
import type { Repository, DiscordPort } from "../server/ports.ts";
import type { Config } from "../server/config.ts";

export const T0 = 1_700_000_000_000;

export const items = (n = 24): string[] =>
  Array.from({ length: n }, (_, i) => `thing number ${i + 1} happens`);

export interface Harness {
  repo: Repository;
  service: GameService;
  clock: ReturnType<typeof fixedClock>;
}

export function harness(seed = 1): Harness {
  const repo = createRepository(openDatabase(":memory:"));
  const clock = fixedClock(T0);
  return { repo, clock, service: new GameService(repo, clock, seededRng(seed)) };
}

export const testConfig = (): Config => ({
  discordClientId: "app-id",
  discordClientSecret: "s".repeat(40),
  pidSecret: "p".repeat(64),
  sessionSecret: "k".repeat(64),
  baseUrl: "https://raidbingo.test",
  redirectUri: "https://raidbingo.test/auth/callback",
  port: 3000,
  dbPath: ":memory:",
});

/** A recording fake. No test ever reaches the real Discord API. */
export function fakeDiscord(discordUserId = "1099"): DiscordPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    authorizeUrl(state) { calls.push(`authorize:${state}`); return `https://discord.test/oauth?state=${state}`; },
    async exchangeCode(code) { calls.push(`exchange:${code}`); return { discordUserId }; },
  };
}
