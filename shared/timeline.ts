/**
 * The chat stream: messages interleaved with the calls and bingos they react
 * to. Pure, and shared by the browser and the tests.
 *
 * Calls and bingos are derived from the state push rather than stored as chat
 * rows, so an undo erases its event, and takes a dependent bingo with it,
 * with no chat-specific code: the next state push simply no longer has them.
 */

export interface ChatMessage {
  seq: number;
  charName: string;
  text: string;
  at: number;
}

export type TimelineEvent =
  | { kind: "call"; at: number; item: number }
  | { kind: "bingo"; at: number; charName: string }
  | { kind: "message"; at: number; seq: number; charName: string; text: string };

/**
 * At the same instant a call comes before the bingo it caused — a bingo's time
 * is the time of the call that completed the line — and both come before
 * anyone's reaction to them.
 */
const KIND_ORDER = { call: 0, bingo: 1, message: 2 } as const;

/**
 * `complete` says the client holds the whole chat: it has `seq` 1, or the game
 * has no messages. Until then, calls and bingos older than the oldest loaded
 * message are held back, or a long night would open with a run of calls and no
 * chat beside them, reading as though nobody spoke. They appear as older
 * pages arrive.
 */
export function timeline(
  called: readonly (readonly [number, number])[],
  roster: readonly { charName: string; bingoAt: number | null }[],
  messages: readonly ChatMessage[],
  complete: boolean,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const [item, at] of called) events.push({ kind: "call", at, item });
  for (const r of roster) {
    if (r.bingoAt !== null) events.push({ kind: "bingo", at: r.bingoAt, charName: r.charName });
  }
  for (const m of messages) {
    events.push({ kind: "message", at: m.at, seq: m.seq, charName: m.charName, text: m.text });
  }

  const oldest = messages.reduce((min, m) => Math.min(min, m.at), Infinity);
  const shown = complete || messages.length === 0
    ? events
    : events.filter((e) => e.kind === "message" || e.at >= oldest);

  return shown.sort((a, b) =>
    a.at - b.at
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.kind === "message" && b.kind === "message" ? a.seq - b.seq : 0)
    || (a.kind === "call" && b.kind === "call" ? a.item - b.item : 0));
}
