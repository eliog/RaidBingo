# Per-game chat

Banter next to the board. Players in a game can post short messages that every
other player in that game sees live, with calls and bingos appearing inline so
the stream reads as reactions to what happened. It is not a Discord
replacement: no threads, no mentions, no read receipts, no moderation.

## Decisions

| Question | Decision |
|---|---|
| Purpose | Banter on the board, roster-only |
| Lifetime | Stored in SQLite with the game. Nothing deletes a message. |
| Events | Calls and bingos appear inline; the Call log panel folds into Chat |
| Moderation | None. Closing the game is the only lever. |
| Transport | HTTP POST to post; one small WebSocket frame per message to fan out; HTTP GET to catch up on every socket open. The state frame is untouched. |
| Idle clock | Posting does not reset it. A game still auto-closes on calls alone. |

The transport decision is the one that was argued over. Carrying the chat list
inside the existing full-state push was rejected because every message would
re-send the whole capped history to every client, around 20 KB per client for
a four-letter message, and every call would drag the chat along with it.

## Schema

New table, schema version 3. The step is an idempotent create.

    messages(game_id, seq, pid, text, sent_at)   -- PK (game_id, seq)

- `seq` is a **per-game** sequence, assigned inside the insert as
  `COALESCE(MAX(seq), 0) + 1` for that game. SQLite's single writer keeps it
  gap-free. A global autoincrement was rejected because any member could watch
  id gaps and infer how busy other games are.
- `pid` is stored for the join; it never reaches the client. The sender's
  `char_name` is resolved from `game_players` at read time.
- `game_id` references `games(id)`. No row is ever deleted.
- The migration test builds a version 2 database, opens it, and asserts the
  table exists and the version is 3.

## Repository

Two methods on `Repository`, implemented in `db.ts`:

    addMessage(gameId, pid, text, at): Promise<MessageRow>
    messagesAfter(gameId, afterSeq, limit): Promise<MessageRow[]>

- `addMessage` returns the row with its `seq` and `charName`.
- `messagesAfter` returns the **last** `limit` rows with `seq > afterSeq`,
  ascending. One query serves first load (cursor 0) and reconnect alike. If a
  reconnect gap exceeds `limit`, the oldest missed messages are not shown; with
  a cap of 200 that needs a multi-minute outage during peak banter, which is
  acceptable for banter.

    MessageRow { gameId, seq, pid, charName, text, sentAt }

## Validation

In `shared/validate.ts`, next to names and titles, so the input enforces the
cap and the server stays authoritative.

    CHAT_MAX = 300
    validateMessage(raw: unknown): Result<string>

1. Must be a string, else invalid.
2. Normalise to NFC.
3. Strip control characters (C0, C1, DEL), zero-width characters
   (U+200B to U+200F, U+FEFF) and bidi controls (U+202A to U+202E,
   U+2066 to U+2069).
4. Collapse all whitespace, including line and paragraph separators, to single
   spaces and trim. Chat is single-line.
5. Reject empty. Reject over `CHAT_MAX` characters.

There is **no blocklist** of code-looking text. Angle brackets and braces are
allowed: `<3` and `>inv` are banter. Rendering through `textContent` is the
injection defence, and it is already how every string reaches the DOM.

## Service

    postMessage(gameId, pid, raw): Promise<Result<MessageView>>
    messagesAfter(gameId, pid, afterSeq): Promise<Result<MessageView[]>>

    MessageView { seq, charName, text, at }        // never pid

`postMessage` refuses, in this order:

| Condition | Code |
|---|---|
| Game does not exist | `not_found` |
| Poster not on the roster | `forbidden` |
| Game closed (explicitly or idle) | `closed` |
| Text fails validation | `invalid` |
| More than 5 posts in 10 s by this player in this game | `rate_limited`, with seconds to wait |
| Game already holds 5,000 messages | `rate_limited`, "this game's chat is full" |

- The limiter is the existing `RateLimiter`, keyed `${gameId}:${pid}`. One
  Discord account is one `pid`, so sockpuppeting needs a second account.
- The 5,000 ceiling bounds disk: the rate limit alone allows ~14,000 messages
  per player over an eight-hour night.
- The game is read through `#liveGame`, which applies idle close, but posting
  does not count as activity.

`messagesAfter` refuses `not_found` and `forbidden` the same way, then returns
the last 200 after the cursor. A closed game is readable.

## Routes

Both under the game, both session-gated by the existing hook, both
membership-gated by the service.

    POST /api/games/:id/chat    { text }        -> { message: MessageView }
    GET  /api/games/:id/chat?after=<seq>        -> { messages: MessageView[] }

- The POST route sets `bodyLimit: 4096` so an oversized body is refused before
  parsing.
- `after` must be a non-negative integer, else 400 `invalid`. Missing means 0.
- The page size is fixed server-side; the client cannot ask for more.
- After a successful post the route calls `notifyChat(gameId, message)`.
- Error codes map to status through the existing `STATUS` table.

## Live push

`GameHub` gains:

    sendChat(gameId, message: MessageView): void

which serialises once and sends `{ type: "chat", message }` to every open
socket in the room. `app.ts` gains `notifyChat` beside `notifyGame`. The
`state` frame is unchanged, so a call costs exactly what it costs today and a
message costs about 100 bytes per client.

**Origin check.** The upgrade handler rejects a request whose `Origin` header
is present and does not match the origin of `config.baseUrl`. SameSite=Lax
already keeps cookies off a cross-site handshake; this is defence in depth,
and it is tested with a mismatched origin.

## Timeline

`shared/timeline.ts`, pure, imported by the client and by tests:

    timeline(called, roster, messages): Event[]

    Event =
      | { kind: "call",    at, item: number }
      | { kind: "bingo",   at, charName }
      | { kind: "message", at, seq, charName, text }

Sorted by `at`, then by kind in that order, then by `seq`. Calls come from
`called`, bingos from roster entries with a non-null `bingoAt`. Because both
are derived from the state push, an undo erases its event and takes a
dependent bingo with it, with no chat-specific code.

## Client

The Call log panel becomes **Chat**, in the rail under Standings, in the same
place on phones.

- **Body** is a scroll box, max height about 360px on desktop and 300px on
  phones, pinned to the bottom unless the reader has scrolled up by more than
  a few pixels. Events render dim and italic; messages render as the name in
  Cinzel followed by the text. Call events keep the undo arrow callers have in
  the Call log today.
- **Input** is a single-line text field with `maxlength` from `CHAT_MAX` and a
  Send button. Enter sends. Sending POSTs, clears the field on success, and
  toasts the error message otherwise, including the wait on `rate_limited`.
  The sender's own message arrives over the socket like everyone else's;
  there is no optimistic path.
- **State** is a `Map<seq, MessageView>`. On every socket `open`, the client
  GETs `?after=<highest seq held>` and merges by `seq`. The same path covers
  first load, a blip and a restart. A `chat` frame also merges by `seq`, so an
  overlap between catch-up and live is harmless.
- **Closed game**: the panel is read-only, no input.
- **No unread badge**, no notification sound, no auto-linking, no markdown.

## Security summary

| Threat | Control |
|---|---|
| Script or markup injection | `textContent` only, never `innerHTML`; a test posts `<script>` and an attribute payload and asserts they come back as plain text |
| Spoofed sender | Name is resolved server-side from the roster; the body carries only `text` |
| Oversized body | 300-character cap after normalisation; 4 KB route body limit; `text` must be a string |
| Hidden or direction-spoofing characters | NFC, control, zero-width and bidi characters stripped |
| Flooding | 5 per 10 s per player per game; 5,000 per game ceiling |
| Cross-game inference | Per-game sequence, not a global id |
| Cursor abuse | `after` validated as a non-negative integer; page size fixed server-side |
| Unauthorised read or write | Roster-only, both transports; closed game read-only |
| Cross-site socket | Origin check on upgrade, on top of SameSite=Lax |
| Leak through previews or logs | Chat stays off the Open Graph preview; message text is never logged |

**Follow-up, out of scope here:** a Content-Security-Policy header. The client
sets inline `style` attributes throughout and the bootstrap script is inline,
so a strict policy needs a nonce and either a style refactor or
`'unsafe-inline'` for styles only. Worth doing as its own change.

## Testing

| Layer | Tests |
|---|---|
| `validate` | string check, NFC, stripping, whitespace collapse, empty, cap, `<3` allowed |
| `timeline` | ordering, tie-break, undo removes a call and its bingo, bingo carries its time |
| `db` | insert returns seq and name; per-game seq starts at 1 in each game; cursor and limit; last-N semantics; migration from version 2 |
| `game-service` | each refusal in order; rate limit with the injected clock; ceiling; idle clock untouched by posting; closed game readable |
| `routes` (inject) | 401 without session; 403 non-member; 400 bad cursor; body limit; hostile text round-trips verbatim |
| `live` | a post reaches both sockets as exactly one `chat` frame and no new `state` frame; mismatched Origin is refused |

## Docs

CLAUDE.md: add `messages` to the data model, a Chat paragraph under Game, and
the schema version note. README: the two routes, if routes are listed.
