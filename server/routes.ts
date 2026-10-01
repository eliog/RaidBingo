import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notifyGame, notifyChat, type Deps } from "./app.ts";
import { GameService, type ServiceError } from "./game-service.ts";
import { currentPid } from "./auth.ts";
import { RateLimiter } from "./rate-limit.ts";
import { layout, errorPage } from "./html.ts";
import { isWellFormedId } from "../shared/ids.ts";
import { ITEM_COUNT, FREE_CELL } from "../shared/board.ts";
import { ogCache, ogTags, type OgState } from "./og.ts";
import { loadPresets } from "./presets.ts";
import { isTheme, type Theme } from "../shared/validate.ts";

/** Unknown game ids one client may ask about per window, across every route. */
export const LOOKUP_MISSES = 20;
export const LOOKUP_WINDOW_MS = 10 * 60_000;

const STATUS: Record<ServiceError["code"], number> = {
  not_found: 404,
  forbidden: 403,
  closed: 409,
  frozen: 409,
  name_taken: 409,
  invalid: 400,
  rate_limited: 429,
  already_joined: 409,
  full: 409,
};

/** A chat cursor: absent, or a non-negative safe integer. */
function cursor(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A JSON integer, and nothing that merely converts to one: Number() turns
 * null, "", false and [] into 0, which would call the first square. Range
 * is the service's to check.
 */
function squareFrom(body: unknown): number | null {
  const item = (body as { item?: unknown } | null)?.item;
  return typeof item === "number" && Number.isInteger(item) ? item : null;
}

const NOT_A_SQUARE: ServiceError = { code: "invalid", message: "That square isn't on this board." };

function fail(reply: FastifyReply, error: ServiceError): FastifyReply {
  return reply.code(STATUS[error.code]).send({ error });
}

/** The shell. The client renders from the state embedded in it. */
async function ogState(deps: Deps, id: string): Promise<OgState | null> {
  const game = await deps.repo.getGame(id);
  if (game === null) return null;
  const calls = await deps.repo.callsFor(id);
  const roster = await deps.repo.rosterFor(id);
  // The board shown is a canonical order, not any one player's shuffle.
  const calledCells: number[] = [];
  let cell = 0;
  for (let item = 0; item < ITEM_COUNT; item++) {
    if (cell === FREE_CELL) cell++;
    if (calls.has(item)) calledCells.push(cell);
    cell++;
  }
  return {
    id: game.id,
    title: game.title,
    players: roster.length,
    calls: calls.size,
    bingos: roster.filter((r) => r.bingoAt !== null).length,
    calledCells,
  };
}

function page(title: string, state: { theme?: Theme; [key: string]: unknown }, head?: string): string {
  // layout() escapes; escaping here too would double-encode an & in a title.
  const full = title === "Raid Bingo" ? title : `${title} — Raid Bingo`;
  return layout({
    title: full, body: '<div id="app"></div>', state, module: "app.js", head, theme: state.theme,
  });
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const service = new GameService(deps.repo, deps.clock, deps.rng);
  // Join attempts, per player. Guessing through any other route that takes an
  // id is held back by the lookup limiter below.
  const joinLimiter = new RateLimiter(deps.clock, 10, 60_000);
  const ogPng = ogCache();
  const lookupLimiter = new RateLimiter(deps.clock, LOOKUP_MISSES, LOOKUP_WINDOW_MS);

  /**
   * Every route that resolves a game id answers 404 for one that does not
   * exist, so each is a way to test guesses — not just join. Misses are
   * counted per client IP, and per player when signed in. Real use almost
   * never misses (links are pasted, not typed), so the limit is tight. Once a
   * key is over it, every lookup is refused, hits included, or the 429 itself
   * would tell a real id from a fake one.
   */
  const lookupKeys = async (request: FastifyRequest): Promise<string[]> => {
    // Fly's proxy sets this and overwrites any value a client sends.
    const ip = String(request.headers["fly-client-ip"] ?? request.ip);
    const pid = await currentPid(deps, request);
    return pid === null ? [`ip:${ip}`] : [`ip:${ip}`, `pid:${pid}`];
  };
  const resolvesId = (request: FastifyRequest) => request.routeOptions.url?.includes(":id") === true;

  app.addHook("onRequest", async (request, reply) => {
    if (!resolvesId(request)) return;
    for (const key of await lookupKeys(request)) {
      const wait = lookupLimiter.peek(key);
      if (wait === null) continue;
      reply.header("retry-after", String(wait));
      const message = "Too many links that don't lead anywhere. Try again in a few minutes.";
      return request.url.startsWith("/g/")
        ? reply.code(429).type("text/html").send(errorPage("Slow down", message, "/"))
        : reply.code(429).send({ error: { code: "rate_limited", message } });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!resolvesId(request) || reply.statusCode !== 404) return;
    for (const key of await lookupKeys(request)) lookupLimiter.check(key);
  });

  /**
   * Defence in depth against CSRF. SameSite=Lax already stops the session
   * cookie riding a cross-site POST, but `text/plain` is a CORS-simple content
   * type, so a cross-origin request can reach us without a preflight. Insisting
   * on application/json means anything cross-origin needs a preflight it will
   * not get, and CSRF no longer rests on a single control.
   */
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !request.url.startsWith("/api/")) return;
    const type = String(request.headers["content-type"] ?? "").split(";")[0]?.trim();
    if (type !== "application/json") {
      return reply.code(415).send({
        error: { code: "invalid", message: "Send application/json." },
      });
    }
  });

  const requirePid = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | null> => {
    const pid = await currentPid(deps, request);
    if (pid === null) {
      reply.code(401).send({ error: { code: "unauthenticated", message: "Sign in with Discord first." } });
      return null;
    }
    return pid;
  };

  // ---------------------------------------------------------------- pages

  app.get("/", async (request, reply) => {
    const pid = await currentPid(deps, request);
    if (pid === null) {
      return reply.type("text/html").send(page("Raid Bingo", { view: "login", returnTo: "/" }));
    }
    const player = await deps.repo.getPlayer(pid);
    const lobby = await service.lobby(pid);
    return reply.type("text/html").send(
      page("Your games", {
        view: "lobby", lastName: player?.lastNameUsed ?? null, theme: player?.theme ?? "auto", ...lobby,
      }),
    );
  });

  app.get("/new", async (request, reply) => {
    const pid = await currentPid(deps, request);
    if (pid === null) return reply.redirect("/auth/login?returnTo=%2Fnew", 302);
    const player = await deps.repo.getPlayer(pid);
    return reply.type("text/html").send(
      page("New game", {
        view: "create",
        lastName: player?.lastNameUsed ?? null,
        theme: player?.theme ?? "auto",
        itemCount: ITEM_COUNT,
        presets: await loadPresets(),
        previous: await service.previousItemSets(pid),
      }),
    );
  });

  app.get<{ Params: { id: string } }>("/g/:id", async (request, reply) => {
    const id = request.params.id;
    if (!isWellFormedId(id)) {
      return reply.code(404).type("text/html").send(
        errorPage("No such game", "That link doesn\u2019t point at a game. Check it was copied whole.", "/"),
      );
    }

    const pid = await currentPid(deps, request);
    const game = await deps.repo.getGame(id);

    // Resolve the game BEFORE the OAuth round trip, so nobody signs in only
    // to land on a 404 — and show which game they are joining.
    if (pid === null) {
      if (game === null) {
        return reply.code(404).type("text/html").send(
          errorPage("No such game", "That game doesn\u2019t exist, or it was never started.", "/"),
        );
      }
      const roster = await deps.repo.rosterFor(id);
      const og = await ogState(deps, id);
      return reply.type("text/html").send(
        page(game.title, {
          view: "login",
          returnTo: `/g/${id}`,
          invite: { id, title: game.title, players: roster.length, closed: game.closedAt !== null },
        }, og ? ogTags(og, deps.config.baseUrl) : undefined),
      );
    }

    const view = await service.view(pid, id);
    if (!view.ok) {
      return reply.code(STATUS[view.error.code]).type("text/html").send(
        errorPage("No such game", view.error.message, "/"),
      );
    }
    const player = await deps.repo.getPlayer(pid);
    const calls = await deps.repo.callsFor(id);
    return reply.type("text/html").send(
      page(view.value.title, {
        view: view.value.board === null ? "join" : "board",
        lastName: player?.lastNameUsed ?? null,
        theme: player?.theme ?? "auto",
        calledCount: calls.size,
        game: view.value,
      }, (await ogState(deps, id).then((s) => (s ? ogTags(s, deps.config.baseUrl) : undefined)))),
    );
  });

  // Public on purpose: Discord's unfurler arrives with no cookie.
  app.get<{ Params: { id: string } }>("/og/:id.png", async (request, reply) => {
    const id = request.params.id.replace(/\.png$/, "");
    if (!isWellFormedId(id)) return reply.code(404).send("not found");
    const state = await ogState(deps, id);
    if (state === null) return reply.code(404).send("not found");
    return reply
      .type("image/png")
      .header("cache-control", "public, max-age=300")
      .send(await ogPng(state));
  });

  // ------------------------------------------------------------------ api

  // Kept on the player, not the browser, so it follows them to a new device.
  app.post<{ Body: { theme?: unknown } }>("/api/me/theme", async (request, reply) => {
    const pid = await requirePid(request, reply);
    if (pid === null) return reply;
    const theme = request.body?.theme;
    if (!isTheme(theme)) {
      return fail(reply, { code: "invalid", message: "Pick auto, light or dark." });
    }
    await deps.repo.setTheme(pid, theme);
    return reply.send({ ok: true, theme });
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", async (request, reply) => {
    const pid = await requirePid(request, reply);
    if (pid === null) return reply;
    const view = await service.view(pid, request.params.id);
    return view.ok ? reply.send(view.value) : fail(reply, view.error);
  });

  app.post<{ Body: { title?: unknown; items?: unknown } }>("/api/games", async (request, reply) => {
    const pid = await requirePid(request, reply);
    if (pid === null) return reply;
    const { title, items } = request.body ?? {};
    if (typeof title !== "string" || !Array.isArray(items)) {
      return fail(reply, { code: "invalid", message: "A title and 24 squares are required." });
    }
    const created = await service.createGame(pid, title, items.map(String));
    return created.ok ? reply.send({ id: created.value }) : fail(reply, created.error);
  });

  app.post<{ Params: { id: string }; Body: { charName?: unknown } }>(
    "/api/games/:id/join",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const wait = joinLimiter.check(pid);
      if (wait !== null) {
        return fail(reply, {
          code: "rate_limited",
          message: `Too many attempts. Try again in ${wait} second${wait === 1 ? "" : "s"}.`,
        });
      }
      const name = (request.body ?? {}).charName;
      const joined = await service.joinGame(pid, request.params.id, typeof name === "string" ? name : "");
      if (joined.ok) notifyGame(request.params.id);
      return joined.ok ? reply.send(joined.value) : fail(reply, joined.error);
    },
  );

  app.post<{ Params: { id: string }; Body: { item?: unknown } }>(
    "/api/games/:id/call",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const item = squareFrom(request.body);
      if (item === null) return fail(reply, NOT_A_SQUARE);
      const called = await service.call(pid, request.params.id, item);
      if (!called.ok) return fail(reply, called.error);
      notifyGame(request.params.id);
      const view = await service.view(pid, request.params.id);
      return reply.send({ winners: called.value.winners, game: view.ok ? view.value : null });
    },
  );

  app.post<{ Params: { id: string }; Body: { item?: unknown } }>(
    "/api/games/:id/undo",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const item = squareFrom(request.body);
      if (item === null) return fail(reply, NOT_A_SQUARE);
      const undone = await service.undo(pid, request.params.id, item);
      if (!undone.ok) return fail(reply, undone.error);
      notifyGame(request.params.id);
      const view = await service.view(pid, request.params.id);
      return reply.send({ game: view.ok ? view.value : null });
    },
  );

  app.post<{ Params: { id: string }; Body: { title?: unknown } }>(
    "/api/games/:id/title",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const t = (request.body ?? {}).title;
      const r = await service.setTitle(pid, request.params.id, typeof t === "string" ? t : "");
      return r.ok ? reply.send({ title: r.value }) : fail(reply, r.error);
    },
  );

  app.post<{ Params: { id: string }; Body: { items?: unknown } }>(
    "/api/games/:id/items",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const raw = (request.body ?? {}).items;
      if (!Array.isArray(raw)) return fail(reply, { code: "invalid", message: "Squares are required." });
      const r = await service.setItems(pid, request.params.id, raw.map(String));
      return r.ok ? reply.send({ ok: true }) : fail(reply, r.error);
    },
  );

  app.post<{ Params: { id: string }; Body: { charName?: unknown; canCall?: unknown } }>(
    "/api/games/:id/callers",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const { charName, canCall } = request.body ?? {};
      if (typeof charName !== "string" || typeof canCall !== "boolean") {
        return fail(reply, { code: "invalid", message: "A character name and a true/false are required." });
      }
      const r = await service.setCaller(pid, request.params.id, charName, canCall);
      if (!r.ok) return fail(reply, r.error);
      notifyGame(request.params.id);
      return reply.send({ charName: r.value, canCall });
    },
  );

  // Refused before parsing: 300 characters is far under 4 KB even escaped.
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>(
    "/api/games/:id/chat",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      // The body carries only text; the sender is whoever the session says.
      const posted = await service.postMessage(request.params.id, pid, (request.body ?? {}).text);
      // An idle game closes lazily, on the post that finds it quiet. Nothing
      // else would tell the open boards, so tell them now.
      if (!posted.ok && posted.error.code === "closed") notifyGame(request.params.id);
      if (!posted.ok) return fail(reply, posted.error);
      notifyChat(request.params.id, posted.value);
      return reply.send({ message: posted.value });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { after?: unknown; before?: unknown } }>(
    "/api/games/:id/chat",
    async (request, reply) => {
      const pid = await requirePid(request, reply);
      if (pid === null) return reply;
      const after = cursor(request.query.after);
      const before = cursor(request.query.before);
      if (after === null || before === null || (after !== undefined && before !== undefined)) {
        return fail(reply, { code: "invalid", message: "Give one of after or before, as a whole number." });
      }
      const page = before !== undefined
        ? await service.messagesBefore(request.params.id, pid, before)
        : await service.messagesAfter(request.params.id, pid, after ?? 0);
      return page.ok ? reply.send({ messages: page.value }) : fail(reply, page.error);
    },
  );

  app.post<{ Params: { id: string } }>("/api/games/:id/close", async (request, reply) => {
    const pid = await requirePid(request, reply);
    if (pid === null) return reply;
    const r = await service.closeGame(pid, request.params.id);
    if (r.ok) notifyGame(request.params.id);
    return r.ok ? reply.send({ ok: true }) : fail(reply, r.error);
  });
}
