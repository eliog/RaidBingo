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
import { markCount } from "../shared/board.ts";

export interface LivePayload {
  type: "state";
  called: [number, number][];
  roster: { charName: string; marks: number; bingoAt: number | null }[];
  closed: boolean;
}

export class GameHub {
  readonly #rooms = new Map<string, Set<WebSocket>>();
  readonly #deps: Deps;
  #server: WebSocketServer | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  attach(httpServer: Server): void {
    const wss = new WebSocketServer({ noServer: true });
    this.#server = wss;

    httpServer.on("upgrade", (request, socket, head) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const match = /^\/ws\/([a-z-]+)$/.exec(url.pathname);
        if (match === null) return socket.destroy();

        const gameId = match[1] as string;
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
          this.#join(gameId, ws);
          void this.push(gameId);
        });
      })().catch(() => socket.destroy());
    });
  }

  #join(gameId: string, ws: WebSocket): void {
    let room = this.#rooms.get(gameId);
    if (room === undefined) {
      room = new Set();
      this.#rooms.set(gameId, room);
    }
    room.add(ws);
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

    const game = await this.#deps.repo.getGame(gameId);
    if (game === null) return;
    const calls = await this.#deps.repo.callsFor(gameId);
    const called = new Set(calls.keys());
    const roster = await this.#deps.repo.rosterFor(gameId);

    const payload: LivePayload = {
      type: "state",
      called: [...calls.entries()].sort((a, b) => a[1] - b[1]),
      roster: roster
        .map((r) => ({ charName: r.charName, marks: markCount(r.board, called), bingoAt: r.bingoAt }))
        .sort((a, b) => {
          if ((a.bingoAt === null) !== (b.bingoAt === null)) return a.bingoAt === null ? 1 : -1;
          if (a.bingoAt !== null && b.bingoAt !== null) return a.bingoAt - b.bingoAt;
          return b.marks - a.marks;
        }),
      closed: game.closedAt !== null,
    };

    const text = JSON.stringify(payload);
    for (const ws of room) {
      if (ws.readyState === ws.OPEN) ws.send(text);
    }
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
