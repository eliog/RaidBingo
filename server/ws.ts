/**
 * Live fanout.
 *
 * Push-only: every mutation goes over HTTP, and the socket exists to tell the
 * other boards about it. That keeps authorisation in one place instead of
 * duplicating it across two transports.
 *
 * The payload is shared rather than per-viewer. A board never changes once
 * dealt, so the client already has its own; what it needs is the called set
 * and the roster. Names are unique within a game, so each client can mark its
 * own row by name — which is also why no pid has to cross the wire.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "node:http";
import type { Deps } from "./app.ts";
import { parseCookies, SESSION_COOKIE } from "./auth.ts";
import { hashSessionToken } from "./identity.ts";
import { bestLineOf } from "../shared/board.ts";
import type { MessageView } from "./game-service.ts";

/** Bytes. Anything larger is refused before it is buffered. */
export const MAX_CLIENT_FRAME = 1024;

/** Open sockets one player may hold to one game; another closes the oldest. */
export const MAX_SOCKETS_PER_PLAYER = 4;

export interface LivePayload {
  type: "state";
  called: [number, number][];
  roster: {
    charName: string; bestLine: number; bingoAt: number | null;
    canCall: boolean; isOwner: boolean; board: number[];
  }[];
  closed: boolean;
}

export class GameHub {
  readonly #rooms = new Map<string, Set<WebSocket>>();
  /** Whose each socket is. Weak, so a closed socket takes its entry with it. */
  readonly #owners = new WeakMap<WebSocket, string>();
  readonly #deps: Deps;
  /** The only Origin a browser handshake may carry. */
  readonly #origin: string;
  #server: WebSocketServer | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#origin = new URL(deps.config.baseUrl).origin;
  }

  attach(httpServer: Server): void {
    // The socket is push-only: a client has nothing to say. Without a cap, ws
    // buffers a whole incoming frame (100 MiB by default) before it could be
    // ignored, which is enough to run the one machine out of memory.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_FRAME });
    this.#server = wss;

    httpServer.on("upgrade", (request, socket, head) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const match = /^\/ws\/([a-z-]+)$/.exec(url.pathname);
        if (match === null) return socket.destroy();

        const gameId = match[1] as string;

        // Defence in depth on top of SameSite=Lax: a browser always sends
        // Origin on a socket handshake, so a cross-site page is refused here
        // even if a cookie somehow rode along. Non-browser clients send none.
        const origin = request.headers.origin;
        if (origin !== undefined && origin !== this.#origin) {
          return socket.destroy();
        }

        const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
        if (token === undefined) return socket.destroy();

        const session = await this.#deps.repo.findSession(
          hashSessionToken(token), this.#deps.clock.now(),
        );
        if (session === null) return socket.destroy();

        // Only players actually in the game get the feed.
        const member = await this.#deps.repo.getGamePlayer(gameId, session.pid);
        if (member === null) return socket.destroy();

        wss.handleUpgrade(request, socket, head, (ws) => {
          this.#join(gameId, session.pid, ws);
          // Only the newcomer needs the current state. Pushing to the room
          // let one player redraw everyone's board by reconnecting in a loop.
          void this.#state(gameId).then((text) => {
            if (text !== null && ws.readyState === ws.OPEN) ws.send(text);
          });
        });
      })().catch(() => socket.destroy());
    });
  }

  #join(gameId: string, pid: string, ws: WebSocket): void {
    let room = this.#rooms.get(gameId);
    if (room === undefined) {
      room = new Set();
      this.#rooms.set(gameId, room);
    }
    // A phone and a laptop and a stale tab is normal; dozens is not. Sets
    // iterate in insertion order, so the first match is the oldest.
    const theirs = [...room].filter((other) => this.#owners.get(other) === pid);
    for (const stale of theirs.slice(0, Math.max(0, theirs.length - MAX_SOCKETS_PER_PLAYER + 1))) {
      room.delete(stale);
      stale.close(1008, "too many tabs");
    }
    this.#owners.set(ws, pid);
    room.add(ws);
    // Talking is not part of the protocol, so any frame at all ends the socket.
    ws.on("message", () => ws.close(1008, "push only"));
    ws.on("close", () => {
      room.delete(ws);
      if (room.size === 0) this.#rooms.delete(gameId);
    });
    ws.on("error", () => ws.close());
  }

  /** Recompute and send the shared state for one game. */
  async push(gameId: string): Promise<void> {
    const room = this.#rooms.get(gameId);
    if (room === undefined || room.size === 0) return;
    const text = await this.#state(gameId);
    if (text !== null) this.#broadcast(gameId, text);
  }

  /** The state frame, serialised once for however many sockets get it. */
  async #state(gameId: string): Promise<string | null> {
    const game = await this.#deps.repo.getGame(gameId);
    if (game === null) return null;
    const calls = await this.#deps.repo.callsFor(gameId);
    const called = new Set(calls.keys());
    const roster = await this.#deps.repo.rosterFor(gameId);

    const payload: LivePayload = {
      type: "state",
      called: [...calls.entries()].sort((a, b) => a[1] - b[1]),
      roster: roster
        .map((r) => ({
          charName: r.charName,
          bestLine: bestLineOf(r.board, called),
          bingoAt: r.bingoAt,
          canCall: r.pid === game.ownerPid || r.canCall,
          isOwner: r.pid === game.ownerPid,
          board: r.board,
        }))
        .sort((a, b) => {
          if ((a.bingoAt === null) !== (b.bingoAt === null)) return a.bingoAt === null ? 1 : -1;
          if (a.bingoAt !== null && b.bingoAt !== null) return a.bingoAt - b.bingoAt;
          return b.bestLine - a.bestLine;
        }),
      closed: game.closedAt !== null,
    };
    return JSON.stringify(payload);
  }

  /** Serialised once by the caller, sent to every open socket in the room. */
  #broadcast(gameId: string, text: string): void {
    const room = this.#rooms.get(gameId);
    if (room === undefined) return;
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
  }

  /**
   * A chat message to everyone in the room, serialised once. The state frame
   * is untouched, so a call costs what it always did and a message costs about
   * 100 bytes per client.
   */
  sendChat(gameId: string, message: MessageView): void {
    this.#broadcast(gameId, JSON.stringify({ type: "chat", message }));
  }

  /**
   * Told before the process drains, so clients can distinguish a deploy from
   * a network blip and back off quickly rather than slowly.
   */
  goodbye(reason: "restart"): void {
    const text = JSON.stringify({ type: "goodbye", reason });
    for (const room of this.#rooms.values()) {
      for (const ws of room) {
        if (ws.readyState === ws.OPEN) ws.send(text);
      }
    }
  }

  /**
   * Drop everything. A socket left open keeps the event loop alive, so this
   * has to terminate rather than politely close.
   */
  close(): void {
    for (const room of this.#rooms.values()) {
      for (const ws of room) ws.terminate();
      room.clear();
    }
    this.#rooms.clear();
    this.#server?.close();
    this.#server = null;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }
}
