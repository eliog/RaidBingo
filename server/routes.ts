import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { notifyGame, type Deps } from "./app.ts";
import { GameService, type ServiceError } from "./game-service.ts";
import { currentPid } from "./auth.ts";
import { RateLimiter } from "./rate-limit.ts";
import { layout, errorPage } from "./html.ts";
import { isWellFormedId } from "../shared/ids.ts";
import { ITEM_COUNT } from "../shared/board.ts";

const STATUS: Record<ServiceError["code"], number> = {
  not_found: 404,
  forbidden: 403,
  closed: 409,
  frozen: 409,
  name_taken: 409,
  invalid: 400,
  rate_limited: 429,
  already_joined: 409,
};

function fail(reply: FastifyReply, error: ServiceError): FastifyReply {
  return reply.code(STATUS[error.code]).send({ error });
}

/** The shell. The client renders from the state embedded in it. */
function page(title: string, state: unknown): string {
  // layout() escapes; escaping here too would double-encode an & in a title.
  const full = title === "Raid Bingo" ? title : `${title} — Raid Bingo`;
  return layout({ title: full, body: '<div id="app"></div>', state, module: "app.js" });
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  const service = new GameService(deps.repo, deps.clock, deps.rng);
  // Join-by-id is the only place an id can be guessed at, so it is the only
  // thing that needs a limiter.
  const joinLimiter = new RateLimiter(deps.clock, 10, 60_000);

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
      page("Your games", { view: "lobby", lastName: player?.lastNameUsed ?? null, ...lobby }),
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
        itemCount: ITEM_COUNT,
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
      return reply.type("text/html").send(
        page(game.title, {
          view: "login",
          returnTo: `/g/${id}`,
          invite: { id, title: game.title, players: roster.length, closed: game.closedAt !== null },
        }),
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
        calledCount: calls.size,
        game: view.value,
      }),
    );
  });

  // ------------------------------------------------------------------ api

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
      const item = Number((request.body ?? {}).item);
      const called = await service.call(pid, request.params.id, item);
      if (!called.ok) return fail(reply, called.error);
      notifyGame(request.params.id);
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
      const item = Number((request.body ?? {}).item);
      const undone = await service.undo(pid, request.params.id, item);
      if (!undone.ok) return fail(reply, undone.error);
      notifyGame(request.params.id);
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

  app.post<{ Params: { id: string } }>("/api/games/:id/close", async (request, reply) => {
    const pid = await requirePid(request, reply);
    if (pid === null) return reply;
    const r = await service.closeGame(pid, request.params.id);
    if (r.ok) notifyGame(request.params.id);
    return r.ok ? reply.send({ ok: true }) : fail(reply, r.error);
  });
}
