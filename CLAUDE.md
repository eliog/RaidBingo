# Raid Bingo

A web bingo game a WoW guild plays during raids. Someone posts a link in Discord, players
log in, get a board, and the game owner calls squares as the raid unfolds.

**Status:** built and tested end to end. `npm test` runs the suite; `node --env-file=.env server/main.ts` runs it. See README.md for setup and deployment.

**This repo is public.** Read [Security](#security) before writing any config code.

Deployment state, open tasks and hard-won gotchas live in `MEMORY.md`, which is not
committed. Read it first when picking this up again.

**Not tied to any WoW version or expansion.** No expansion-specific logic, no patch
numbers, no content tables. The app never talks to the game client.

## Game

- 5x5 board: 24 items plus a free centre square, the **Hearthstone** — always marked,
  drawn as an original chamfered stone with an ember. The name is a Blizzard trademark, so
  the glyph is deliberately our own geometry in the existing fel/chamfer vocabulary, never
  traced from or evocative of their item art. That rule holds for every mark in this
  project.
- Every player gets the **same 24 items in a different order**.
- **Callers call squares.** A call ticks on every board at once, and can be undone with
  one click on the same square, not buried in a menu.
- **The owner is always a caller, and can hand calling to other players** so they are not
  tied to their phone for the whole raid. Granting does not pass on the power to grant —
  only the owner does that. Everything else (title, items, closing) stays owner-only.
- **An undo leaves no trace.** Any bingo that rested on the undone call is taken back with
  it, and disappears from the standings as if it never happened. A player who still holds
  a line some other way keeps theirs, with their original time. Re-calling restores it.
- No player voting, no pending state: a square is called or it is not.
- Win is five in a row: row, column or diagonal.
- **Mark counts are identical for every player, always.** Every board holds all 24 items
  and calls are global, so everyone has exactly `called + 1` marks. Arrangement is the
  only variable, so rank and display on `bestLineOf` — how close someone is to a line —
  never on a mark count. A marks column would show one number for the whole raid.
- The night continues past the first bingo; winners are ranked by time.

## Games

Concurrent games are supported. Each has its own title, items, owner, roster and calls.

- **Anyone logged in can create a game; the creator owns it.** No admin role, no
  designated-host list.
- Every game has a **title** set at creation (e.g. "Tuesday BT run") — the human label,
  distinct from the ID. Shown in the lobby, history, board header and OG preview.
- Games auto-close after ~8h idle.
- Rate-limit game creation per `pid` (a few a day).

Owner-only functions:

- Call squares and undo calls, and grant or revoke that for any other player. The player
  is named by `char_name`, which resolves because names are unique within a game and is
  the only identity the client ever sees.
- Set the 24 items, editable **until the first non-owner joins**, then `items_json`
  freezes. (Non-owner: the owner takes a board through the same name gate as everyone
  else, so counting their own join would end editing before it started.)
- Items are capped at **60 characters**, with a soft warning at 48 — under 48 every item
  fits at 10.5px in a 74px phone cell. Duplicates are flagged against the slot they clash
  with.
- Edit the title.
- Close the game early.

When creating a game, show the owner the item sets from their own previous games so they
can prefill and edit. No schema needed — `games.items_json` keyed by `owner_pid` is the
library.

Alongside those, `presets.json` at the project root supplies fixed starting sets. It is
**not committed**: a guild's squares name real people and this repo is public. A missing
or malformed file is never fatal — bad entries are skipped with a warning and the screen
offers fewer starting points.

### Game IDs

Three distinct words from a curated pool of ~512 WoW words, e.g.
`shattered-felguard-netherstorm`. 512 × 511 × 510 = 133.4M combinations.

- Distinct words only, order significant.
- Check generated IDs against a blocklist; regenerate on a hit.
- **No prefix matching.** Join-by-ID requires the full three-word ID. Prefix resolution
  would have to search every open game (the lobby only lists games you are in), which
  makes the join box an enumeration oracle against the keyspace and leaks the existence of
  games the user cannot see. Paste is the primary path; typing is the rare fallback.
- Rate-limit the join endpoint to ~10 attempts/minute.

## Identity

**Discord is identity only. It never supplies a display name.**

    pid = HMAC-SHA256(discord_user_id, PID_SECRET)   // raw ID never stored

- Discord OAuth2, **`identify` scope only**. No bot, no admin rights in any server, no
  `GUILD_ID`, no guild binding.
- `pid` is the identity key, global across games. It stops one person holding two cards in
  the same game.
- `pid` is **derived, not assigned**: the same Discord account always yields the same
  `pid`, on any device, forever. Logging in fresh from a new browser or phone restores
  ownership, boards, character name and history. **Never assign a random per-user id
  instead** — it would look correct until someone used a second device.
- **Players type their own character name.** Per game (people bring alts), defaulting to
  their last used name.
- **Character names must be unique within a game** — checked on blur, case-insensitively
  with whitespace collapsed (`Thalgrim` = `thalgrim` = `Thal grim`). Since `pid` never
  reaches the client, `char_name` is the only identity anyone sees: two players called
  Thalgrim would make the roster, the bingo call-out and the winner ranking ambiguous for
  the whole night. Blocking, with suggested alternatives checked against the roster first.

### Sessions

- 90-day cookie: HttpOnly, Secure, SameSite=Lax.
- Backed by a `sessions` table. Store only a **hash** of the token, never the token.
- Site root: your active games (a picker, not an auto-redirect), history, and join-by-ID.
- The lobby lists **only games you are in** — not a public directory.

## Discord integration

**There is no bot.** Any member pastes a game URL into any channel.

- Serve per-game **Open Graph tags** so Discord unfurls the link into a rich preview:
  title, player count, generated board image.
- The preview is a **snapshot, not live** — Discord caches unfurls. The live board is on
  the website.
- Keep Discord behind the narrow interface (see test seams) so a webhook or bot can be
  added later without touching game logic.

## Stack

Small DigitalOcean droplet.

- **TypeScript on Node 24 LTS** — Fastify, `ws`. Run directly, no build step: Node strips
  types at load. That means **only erasable syntax** — no parameter properties
  (`constructor(readonly x: T)`), no enums, no namespaces, no decorators, since those
  emit code rather than just disappearing. `erasableSyntaxOnly` is on so `npm run
  typecheck` catches it instead of the runtime.
- **SQLite** via the built-in `node:sqlite` (WAL) — no native dependencies, so the Docker
  image is a plain `node:24-slim` with no build toolchain
- Discord OAuth2 handled directly; no Discord library needed
- **Caddy** reverse proxy for automatic Let's Encrypt TLS
- **systemd**

### Deployment and TLS

Served over HTTPS only. Caddy provisions and renews Let's Encrypt certificates
automatically and redirects HTTP to HTTPS; HSTS is **not** on by default, so set it.

    raidbingo.com {
        reverse_proxy localhost:3000
        header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    }

Leave `preload` off — easy to join the preload list, painful to leave it.

Prerequisites: an A record at the droplet, and ports **80 and 443** open. Port 80 is
required for the ACME challenge and the redirect.

**Never hardcode the domain.** `BASE_URL` is config (this deployment uses
`https://raidbingo.com`; forks use their own). It is used for:

- The **Discord OAuth redirect URI**, which is exact-match and must be pre-registered in
  the Discord developer portal. A mismatch fails login with `invalid_redirect_uri`. Every
  fork needs its own Discord application — say so in the README.
- Absolute URLs in Open Graph tags, or Discord will not unfurl the preview.
- Shareable game links.

Cookies are `Secure`, so login does not work over plain HTTP in production.
`SameSite=Lax` is correct: the OAuth callback is a top-level GET navigation, which Lax
permits. Local dev works because browsers treat `http://localhost` as a secure context.

### Single instance

Two things pin this to one instance:

1. SQLite pins deployment to one pod (`ReadWriteOnce` volume).
2. WebSocket fanout lives in process memory.

Keep data access behind a **repository interface** with plain SQL, so SQLite can be
swapped for Postgres as one new implementation. This is the only hard-to-reverse decision
in the stack.

## Testing

Everything must be testable in code. Use the built-in `node:test` runner — no Jest or
Vitest dependency.

| Layer | Approach |
|---|---|
| Board dealing, line detection, ID generation, call state | Pure functions, unit tests |
| Name-collision and item validation | Pure functions, unit tests |
| OG tag rendering | Pure `game state -> tags`; snapshot it |
| Database queries | Real in-memory SQLite (`new DatabaseSync(':memory:')`) per test |
| HTTP routes, OAuth callback | `fastify.inject()` |
| WebSocket | Real client on an ephemeral port |
| A call and an undo reaching every board | Playwright driving two browser contexts |
| Bingo revoked and restored around an undo | Pure functions + service tests |

### Four seams required from the first commit

1. **Inject the clock.** Idle auto-close and session expiry are time-dependent; tests
   advance time instead of sleeping.
2. **Inject randomness.** Production deals boards with `crypto.randomInt`; tests inject a
   seeded RNG.
3. **Discord behind a narrow interface** — token exchange, profile fetch. Never touch the
   real Discord API in a test; use a recording fake.
4. **Data behind a repository interface.**

## Layout

    shared/     board.ts   line detection      <- imported by server AND client
                ids.ts     word pool, ID generation
    server/     config.ts  fail-fast env loading
                db.ts      schema + queries
                ws.ts      live board updates
                auth.ts    Discord OAuth + sessions
    client/     board UI

## Data model

    players(pid, last_name_used, created_at, last_seen)
    sessions(token_hash, pid, created_at, expires_at)
    games(id, title, owner_pid, items_json, created_at, closed_at)
    game_players(game_id, pid, char_name, board_json, joined_at, bingo_at, can_call)
    calls(game_id, item_idx, called_at)        -- PK (game_id, item_idx)

- `calls` holds one row per called item: a square is called iff the row exists, and undo is
  a plain delete.
- `char_name` lives on `game_players`, not `players`, because people bring alts.
- `can_call` is per game, not per player: being a caller on Tuesday says nothing about
  Wednesday. The owner is a caller implicitly and carries no flag.
- **Boards are stored, not derived.** Deal once, server-side, at join time, with
  `crypto.randomInt`, writing 24 item indices to `game_players.board_json`.
- **Freeze `games.items_json` once the first non-owner joins.** Boards are indices into it.
- **Never send another player's `pid` to the client.** The roster needs `char_name` only.

## Migrations

The live database holds real games, so `CREATE TABLE IF NOT EXISTS` is not enough on its
own — a schema change has to reach rows that already exist. `db.ts` keeps a
`SCHEMA_VERSION` and steps `PRAGMA user_version` forward, and every step is written to be
safe to run twice. A test builds a database at the old shape, opens it, and asserts both
that the column arrives and that existing rows do **not** silently gain the new
permission.

## Security

**This repo is public. Treat every config path as a leak risk.**

| Value | Secret | Notes |
|---|---|---|
| `DISCORD_CLIENT_SECRET` | Critical | Rotate in the dev portal if exposed |
| `PID_SECRET` | Critical | See below |
| `SESSION_SECRET` | Critical | Keep separate from `PID_SECRET` |
| `DISCORD_CLIENT_ID` | No | Env-load anyway so forks work |
| `BASE_URL` | No | e.g. `https://raidbingo.com`. Never hardcode the domain |
| `bingo.db` | Yes | Contains character names. Never commit |

- `.gitignore` in the first commit: `.env*`, `!.env.example`, `*.db`, `data/`
- A committed `.env.example` with placeholders only
- Secrets in `/etc/bingo/env` (mode 0600) via systemd `EnvironmentFile=`
- gitleaks as a pre-commit hook **and** a GitHub Action; enable GitHub push protection

**Never write a fallback secret:**

    const PID_SECRET = process.env.PID_SECRET || 'dev-secret-change-me';   // WRONG

`config.ts` must throw at startup when a required secret is unset or still holds its
placeholder value.

**Git history is permanent.** A secret committed once and removed later is still public.
Rotation is the remediation, not deletion.

**`PID_SECRET` cannot be rotated casually** — it changes every player ID, reshuffling
cards and detaching history. Generate once with `openssl rand -hex 32` and back it up off
the droplet.

## Prototype

`raid-bingo.html` is a single-file prototype with the card dealer, line detection and full
board UI. It does **not** match this spec: players hold different items drawn from a
44-item pool, any player can call a square, and there is no real identity. Its item list
is sample content. Use it as a reference for game logic and visual design only.

Visual design: dark is a deep purple-black stone (`#14101A`) with bone text and fel green
(`#8FD94A`) for called squares. Light is aged vellum (`#E8DFC8`) with a darker fel
(`#46731A`). Cinzel for headings, Alegreya Sans for square text. At 400px a cell is
74px wide, so one fitted size is binary-searched across the whole grid within a
9.5–12.5px range (a per-cell size reads as a ransom note); rows grow rather than staying
square, and tapping a square opens a sheet with the full phrase at 17px. Clipped text is a
bug, so a runtime guard grows the row and flags the cell if it still overflows.

## Known gaps

- The word pool is 243 words (14.2M ordered triples) against the ~512 target above.
  Growing it is just appending to `WORDS` in `shared/ids.ts`.
- `fonts/` is empty. The link-preview image renders in fallback faces until the three
  OFL fonts are dropped in — see `fonts/README.md`.
- No Playwright end-to-end test yet; the call/undo path is covered at the service and
  HTTP layers only.

## Not in scope

- Prize logic, spectator view, ownership transfer, guild-wide history archive, player
  call suggestions.
- Late joiners inherit calls already made.
