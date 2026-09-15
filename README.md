# Raid Bingo

Bingo for raid night. Someone makes a card, the raid leader calls the squares, and
everyone watches their board tick over in real time.

- Every player gets the **same 24 squares in a different order**, plus a free centre.
- **The owner calls squares**, and can undo any call. There is no voting and no pending
  state: a square is called or it is not.
- Five in a row wins. The night continues past the first bingo; winners are ranked by time.
- Anyone signed in can start a game. Games get a three-word id like
  `shattered-felguard-netherstorm`, which is what you paste into Discord.

Discord is used for **identity only**. The app requests the `identify` scope, hashes the
account id, and never stores it — see [Privacy](#privacy).

## Requirements

- Node 24 or newer (uses the built-in `node:sqlite`, and runs TypeScript with no build step)
- A Discord application — no bot, and no admin rights in any server

## Running it locally

```bash
npm install
cp .env.example .env     # then fill it in, see below
npm test
node --env-file=.env server/main.ts
```

Generate each secret with `openssl rand -hex 32`. The app **refuses to start** if any
required value is missing or still reads `REPLACE_ME`; there are deliberately no fallback
defaults.

For the Discord application: create one at <https://discord.com/developers/applications>,
take the client id and secret, and register `BASE_URL + /auth/callback` as a redirect URI.
It must match exactly. Local development uses `http://localhost:3000/auth/callback`.

## Deploying

Any small Linux box will do. `deploy/` has a Caddyfile and a systemd unit.

1. Point an A record at the machine and open ports **80 and 443**. Port 80 is not
   optional — it serves the ACME challenge and the HTTP→HTTPS redirect.
2. Put the secrets in `/etc/raidbingo/env`, owned by root, mode `0600`. The unit reads
   them with `EnvironmentFile=`, which is why the unit itself is safe to commit.
3. Install the Caddyfile. Caddy obtains and renews the certificate itself; there is no
   certbot and no cron job.
4. `systemctl enable --now raidbingo`

Cookies are `Secure`, so **the app does not work over plain HTTP** anywhere except
localhost. That is checked at startup rather than failing silently at login.

### Fonts for the link preview

When a game link is pasted into Discord, the unfurl image is generated server-side.
Fonts do not travel inside an SVG, so drop `Cinzel-Bold.ttf`, `AlegreyaSans-Bold.ttf` and
a monospace face (JetBrains Mono or IBM Plex Mono, both OFL) into `fonts/`, with their
licence files. Without them the image still renders, in whatever the host happens to have.

## Privacy

The only thing kept about a Discord account is a one-way fingerprint:

```
pid = HMAC-SHA256(discord_user_id, PID_SECRET)
```

The raw account id is never written, and the `identify` scope means the app never sees
your servers, your friends, your email or your messages. Usernames and avatars come back
in the OAuth response and are deliberately not read.

The display name on a board is a **character name you type yourself**, per game — because
in a raid people know each other by character, and no Discord scope returns one.

`PID_SECRET` cannot be rotated casually: changing it changes every player id, reshuffling
cards and detaching history. Generate it once and back it up somewhere other than the
server.

## Layout

```
shared/   board and validation logic — imported by the server AND the browser
server/   config, sqlite, auth, game rules, routes, websocket, og image
client/   the browser app
tests/    node:test, no other runner
design/   the design canvas source (.dc.html artboards)
```

The browser is served the `shared/` modules with types stripped at request time, so it
runs the same board code the server does rather than a copy of it.

## Testing

```bash
npm test          # node:test
npm run typecheck # tsc --noEmit
```

Tests never touch the real Discord API and never need a database file: Discord is behind
an interface with a recording fake, and every database test gets its own in-memory SQLite.

## Contributing

Please run `npm run hooks` once. It points git at `.githooks`, which runs **gitleaks**
over staged changes. A secret committed once stays in history even if a later commit
removes it, so rotation — not deletion — is the only real fix. Catching it beforehand is
much cheaper.
