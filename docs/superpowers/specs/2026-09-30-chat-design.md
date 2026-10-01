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

Schema version 3: one new table and one new column. Both are written to be safe
to run twice: the table with `CREATE TABLE IF NOT EXISTS`, the column only
after checking `PRAGMA table_info(games)`.

    messages(game_id, seq, pid, text, sent_at)   -- PK (game_id, seq)
    games.chat_seq INTEGER NOT NULL DEFAULT 0    -- last seq issued in this game

- `seq` is a **per-game** sequence, issued from a counter on the game row.
  `addMessage` runs, in one transaction:

      UPDATE games SET chat_seq = chat_seq + 1
        WHERE id = ? AND chat_seq < 5000 RETURNING chat_seq
      INSERT INTO messages (game_id, seq, pid, text, sent_at) VALUES (?, ?, ?, ?, ?)

  The update takes the game's row lock, so two posts to the same game queue
  and get consecutive numbers, while posts to other games do not wait. The
  SQL is identical on SQLite (`RETURNING` since 3.35, 2021, well before
  any `node:sqlite`) and Postgres, so a second repository implementation inherits it rather than
  reinventing it. A rollback undoes both statements, so `seq` stays
  gap-free.
- The `chat_seq < 5000` guard makes the ceiling atomic: no row back means the
  chat is full, and `addMessage` returns `null` for the service to report as
  `full`. A separate read-then-insert would let two posts at 4,999 both pass.
  `addMessage` therefore returns `Promise<MessageRow | null>`.
- `MAX(seq) + 1` was rejected: correct on SQLite only because SQLite
  serialises writers. On Postgres two concurrent posts read the same maximum
  and one fails on the primary key.
  A global autoincrement was rejected because any member could watch id gaps
  and infer how busy other games are.
- `pid` is stored for the join; it never reaches the client. The sender's
  `char_name` is resolved from `game_players` at read time.
- `game_id` references `games(id)`. No row is ever deleted.
- The migration test builds a version 2 database with games in it, opens it,
  and asserts the table exists, the version is 3, and every existing game has
  `chat_seq = 0`.

## Repository

Three methods on `Repository`, implemented in `db.ts`:

    addMessage(gameId, pid, text, at): Promise<MessageRow | null>   // null: full
    messagesAfter(gameId, afterSeq, limit): Promise<MessageRow[]>
    messagesBefore(gameId, beforeSeq, limit): Promise<MessageRow[]>

- `addMessage` returns the row with its `seq` and `charName`.
- `messagesAfter` returns the **last** `limit` rows with `seq > afterSeq`,
  ascending. One query serves first load (cursor 0) and reconnect alike. If a
  reconnect gap exceeds `limit`, the oldest missed messages are not shown; with
  a cap of 200 that needs a multi-minute outage during peak banter, which is
  acceptable for banter — scrolling up fills the hole (below).
- `messagesBefore` returns the last `limit` rows with `seq < beforeSeq`,
  ascending. It is how a reader reaches older history: every stored message is
  reachable, so "nothing deletes a message" also means nothing is unreadable,
  matching the rule that a finished night stays readable indefinitely.

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
5. Reject empty. Reject over `CHAT_MAX` UTF-16 code units — `.length`, the
   same unit `maxlength` counts, so the input and the server never disagree
   about an emoji.

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
| Game already holds 5,000 messages | `full`, "this game's chat is full" |
| More than 5 posts in 10 s by this player in this game | `rate_limited`, with seconds to wait |

- `ServiceError["code"]` gains `full`.
- The limiter is the existing `RateLimiter`, keyed `${gameId}:${pid}`. One
  Discord account is one `pid`, so sockpuppeting needs a second account.
- `full` is its own code, mapped to 409 in `STATUS`, because it carries no
  wait. Reusing `rate_limited` would have the client show a countdown to
  nothing.
- The ceiling is checked twice. First from `game.chatSeq` (`GameRow` gains
  it, so the row `#liveGame` already loaded answers it with no extra query),
  **before** the limiter, so a post refused as `full` does not spend one of
  the five. Then atomically, by the `chat_seq < 5000` guard in `addMessage`
  (see [Schema](#schema)), which catches two posts racing at 4,999. Nothing
  deletes a message, so `chat_seq` is the message count.
- The 5,000 ceiling bounds disk: the rate limit alone allows ~14,000 messages
  per player over an eight-hour night.
- The game is read through `#liveGame`, which applies idle close, but posting
  does not count as activity.

    messagesBefore(gameId, pid, beforeSeq): Promise<Result<MessageView[]>>

`messagesAfter` and `messagesBefore` refuse `not_found` and `forbidden` the same
way, then return up to 200 on their side of the cursor. A closed game is
readable, all the way back.

## Routes

Both under the game, both session-gated by the existing hook, both
membership-gated by the service.

    POST /api/games/:id/chat    { text }        -> { message: MessageView }
    GET  /api/games/:id/chat?after=<seq>        -> { messages: MessageView[] }
    GET  /api/games/:id/chat?before=<seq>       -> { messages: MessageView[] }

- The POST route sets `bodyLimit: 4096` so an oversized body is refused before
  parsing.
- `after` and `before` must be non-negative safe integers, else 400 `invalid`.
  Giving both is 400. Giving neither means `after=0`.
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

    timeline(called, roster, messages, complete): Event[]

    Event =
      | { kind: "call",    at, item: number }
      | { kind: "bingo",   at, charName }
      | { kind: "message", at, seq, charName, text }

Sorted by `at`, then by kind in that order, then by `seq`. The call-before-bingo
tie-break relies on `bingo_at` being exactly the `called_at` of the call that
completed the line; a test pins that, because the order depends on it
silently.

Calls and bingos cover the whole night, but messages cover only what the
client has loaded. Until the client has reached the first message, the
timeline holds back events older than the oldest loaded message, and they
appear as older pages arrive. Otherwise a long night would open with a run of
calls and no chat beside them, reading as though nobody spoke. Once the first
message is loaded, or the game has no messages, every event shows: that is
what `complete` says. Because `seq` is gap-free from 1, the client knows it is
complete when it holds `seq` 1, or when a catch-up from 0 returned nothing.

Calls come from `called`, bingos from roster entries with a non-null `bingoAt`. Because both
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
  Send button. Enter sends, except while `event.isComposing` — an IME user
  pressing Enter to confirm a candidate must not post half a word. Sending POSTs, clears the field on success, and
  toasts the error message otherwise, including the wait on `rate_limited`
  (and no wait on `full`).
  The sender's own message arrives over the socket like everyone else's;
  there is no optimistic path.
- **Older history**: scrolling to the top GETs `?before=<lowest seq held>` and
  prepends, keeping the reader's scroll position. Holding `seq` 1 means the
  start of the chat; stop asking.
- **State** is a `Map<seq, MessageView>`. On every socket `open`, the client
  GETs `?after=<highest seq held>` and merges by `seq`. The same path covers
  first load, a blip and a restart. A `chat` frame also merges by `seq`, so an
  overlap between catch-up and live is harmless.
- **Closed game**: the panel is read-only, no input.
- **No unread badge**, no notification sound, no auto-linking, no markdown.

## Security summary

| Threat | Control |
|---|---|
| Script or markup injection | User text reaches the DOM through `textContent` only, never `innerHTML` (the fixed SVG marks in `client/app.js` are the only `innerHTML`, and carry no user text); a test posts `<script>` and an attribute payload and asserts they come back as plain text |
| Spoofed sender | Name is resolved server-side from the roster; the body carries only `text` |
| Oversized body | 300-character cap after normalisation; 4 KB route body limit; `text` must be a string |
| Hidden or direction-spoofing characters | NFC, control, zero-width and bidi characters stripped |
| Flooding | 5 per 10 s per player per game; 5,000 per game ceiling |
| Cross-game inference | Per-game sequence, not a global id |
| Cursor abuse | `after` / `before` validated as non-negative integers; page size fixed server-side |
| Unauthorised read or write | Roster-only, both transports; closed game read-only |
| Cross-site socket | Origin check on upgrade, on top of SameSite=Lax |
| Leak through previews or logs | Chat stays off the Open Graph preview; message text is never logged |

A Content-Security-Policy header is already set in `server/app.ts`, so an
`innerHTML` slip in a future change would still be blocked from loading a
foreign script. Its `script-src` allows `'unsafe-inline'` for the embedded
state blob, which also permits inline event handlers in injected markup.
**Follow-up, out of scope here:** no nonce is needed. Emit the state as
`<script type="application/json" id="rb-state">` and have the client read it
with `JSON.parse(el.textContent)`. A data block is never executed, so
`script-src` does not apply to it and `'unsafe-inline'` can leave `script-src`
entirely. `jsonForScript` already makes the content safe to embed. `style-src`
keeps `'unsafe-inline'` for the inline `style` attributes. Worth doing as its
own change.

## Testing

| Layer | Tests |
|---|---|
| `validate` | string check, NFC, stripping, whitespace collapse, empty, cap counted in code units, `<3` allowed |
| `timeline` | ordering, call-before-bingo tie-break at equal `at`, undo removes a call and its bingo, bingo carries its time, events before the oldest loaded message are held back |
| `db` | insert returns seq and name; per-game seq starts at 1 in each game and advances `games.chat_seq`; cursor and limit both ways; last-N semantics; every message reachable by paging back; migration from version 2 |
| `game-service` | each refusal in order; rate limit with the injected clock; ceiling returns `full` and spends no limiter slot; idle clock untouched by posting; closed game readable to the first message |
| `routes` (inject) | 401 without session; 403 non-member; 400 bad cursor, 400 both cursors; body limit; hostile text round-trips verbatim |
| `live` | a post reaches both sockets as exactly one `chat` frame and no new `state` frame; mismatched Origin is refused |

## Docs

CLAUDE.md: add `messages` and `games.chat_seq` to the data model, a Chat paragraph under Game, and
the schema version note. README: the two routes, if routes are listed.
