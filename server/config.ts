/**
 * Fail-fast configuration.
 *
 * There are NO fallback defaults for secrets, deliberately. A line like
 *
 *     const PID_SECRET = process.env.PID_SECRET || "dev-secret-change-me";
 *
 * would mean every deployment of this public repo computed identical player
 * ids from the same Discord accounts, and nothing would error. Missing or
 * placeholder values stop the process at startup instead.
 *
 * `loadConfig` takes the environment as an argument rather than reading
 * process.env, so tests can exercise every failure without mutating globals.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  discordClientId: string;
  discordClientSecret: string;
  pidSecret: string;
  sessionSecret: string;
  baseUrl: string;
  /** Derived from baseUrl. Must match the Discord portal registration exactly. */
  redirectUri: string;
  port: number;
  dbPath: string;
}

const PLACEHOLDERS = new Set([
  "replace_me", "replaceme", "changeme", "change_me", "todo",
  "your-secret-here", "dev-secret-change-me", "xxx", "secret",
]);

const MIN_SECRET_LENGTH = 32;

function required(env: Record<string, string | undefined>, name: string): string {
  const raw = env[name];
  if (raw === undefined) {
    throw new ConfigError(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
  const value = raw.trim();
  if (value === "") {
    throw new ConfigError(`${name} is empty.`);
  }
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new ConfigError(
      `${name} still holds the placeholder "${value}". Generate one with: openssl rand -hex 32`,
    );
  }
  return value;
}

function requiredSecret(env: Record<string, string | undefined>, name: string): string {
  const value = required(env, name);
  if (value.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `${name} is ${value.length} characters; at least ${MIN_SECRET_LENGTH} are required. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const discordClientId = required(env, "DISCORD_CLIENT_ID");
  const discordClientSecret = requiredSecret(env, "DISCORD_CLIENT_SECRET");
  const pidSecret = requiredSecret(env, "PID_SECRET");
  const sessionSecret = requiredSecret(env, "SESSION_SECRET");

  if (pidSecret === sessionSecret) {
    throw new ConfigError(
      "PID_SECRET and SESSION_SECRET must differ. PID_SECRET can never be rotated without " +
        "detaching every player from their history; SESSION_SECRET should be rotatable.",
    );
  }

  const rawBase = required(env, "BASE_URL");
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new ConfigError(`BASE_URL is not a valid url: ${rawBase}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`BASE_URL must be http or https, got ${url.protocol}`);
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && !isLocal) {
    throw new ConfigError(
      `BASE_URL uses http on ${url.hostname}. Session cookies are Secure, so login would ` +
        `silently never work. Use https (Caddy issues the certificate automatically).`,
    );
  }
  const baseUrl = url.origin;

  const rawPort = env["PORT"]?.trim();
  const port = rawPort === undefined || rawPort === "" ? 3000 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got ${rawPort}`);
  }

  const dbPath = env["DB_PATH"]?.trim() || "./data/bingo.db";

  return {
    discordClientId,
    discordClientSecret,
    pidSecret,
    sessionSecret,
    baseUrl,
    redirectUri: `${baseUrl}/auth/callback`,
    port,
    dbPath,
  };
}
