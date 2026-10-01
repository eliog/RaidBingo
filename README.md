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

It runs on [Fly.io](https://fly.io) as **one machine with one volume**. SQLite and the
in-memory WebSocket fanout both pin it to a single instance, so never scale it past one.
Fly terminates TLS and issues the certificate; the app sets HSTS and the other security
headers itself.

```sh
fly launch --no-deploy --copy-config      # pick your own app name; edit fly.toml to match
fly volumes create bingo_data --size 1     # same region as primary_region
fly secrets set DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... \
  PID_SECRET=... SESSION_SECRET=... BASE_URL=https://your.domain
fly deploy --ha=false
fly certs add your.domain                  # then point DNS where it tells you
```

Register `BASE_URL/auth/callback` as the redirect URI in your own Discord application.
Every fork needs its own.

`presets.json` goes on the volume, not into the image, so it never leaves your hands:

```sh
fly ssh sftp shell      # then: put presets.json /data/presets.json
fly machine restart
```

Cookies are `Secure`, so **the app does not work over plain HTTP** anywhere except
localhost. That is checked at startup rather than failing silently at login.

### Fonts for the link preview

When a game link is pasted into Discord, the unfurl image is generated server-side.
The Docker image fetches the fonts at build time. For local runs, fonts do not travel
inside an SVG, so drop `Cinzel-Bold.ttf`, `AlegreyaSans-Bold.ttf` and
a monospace face (JetBrains Mono or IBM Plex Mono, both OFL) into `fonts/`, with their
licence files. Without them the image still renders, in whatever the host happens to have.

## Preset squares

The create screen offers starting points under **Start from**: your own previous games,
plus any presets you configure. Presets live in `presets.json` at the project root (on Fly, on the volume — see above):

```json
[{ "name": "DEA Defaults", "items": ["Someone pulls before the count", "..."] }]
```

Each needs a name and exactly 24 squares. Copy `presets.example.json` to get going.

**`presets.json` is deliberately not committed.** A guild's squares name real people, and
this repo is public — your in-jokes should not become someone else's git history.

**Not committed is not the same as private.** Every preset is sent to anyone who logs in
and opens *New game*, and anyone with a Discord account can log in — there is no guild
check. Treat presets as visible to anyone who has your site's address, and keep anything
you would not want a stranger to read out of them. A
missing or malformed file is not fatal: the create screen simply offers fewer starting
points, and anything skipped is logged.

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

## License

MIT — see [LICENSE](LICENSE).

Note that anything you drop into `fonts/` keeps its own licence. The three
faces the link-preview image expects are all OFL, which requires their licence
text to travel with them, so check each `OFL.txt` in beside its font.

## Contributing

Please run `npm run hooks` once. It points git at `.githooks`, which runs **gitleaks**
over staged changes. A secret committed once stays in history even if a later commit
removes it, so rotation — not deletion — is the only real fix. Catching it beforehand is
much cheaper.
