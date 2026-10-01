import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepository, openDatabase } from "../server/db.ts";
import { fixedClock } from "../shared/seams.ts";
import { runMaintenance, MAINTENANCE_EVERY_MS } from "../server/maintenance.ts";
import { SESSION_MS } from "../server/identity.ts";
import { T0 } from "./helpers.ts";

async function setup() {
  const repo = createRepository(openDatabase(":memory:"));
  const clock = fixedClock(T0);
  await repo.upsertPlayer("p", T0);
  await repo.createSession({ tokenHash: "old", pid: "p", createdAt: T0, expiresAt: T0 + 1000 });
  await repo.createSession({ tokenHash: "new", pid: "p", createdAt: T0, expiresAt: T0 + SESSION_MS });
  return { repo, clock };
}

test("maintenance purges sessions as the injected clock passes their expiry (#22)", async () => {
  const { repo, clock } = await setup();
  assert.deepEqual(await runMaintenance({ repo, clock }), { sessionsPurged: 0, socketsClosed: 0 });
  clock.advance(1000);
  assert.deepEqual(await runMaintenance({ repo, clock }), { sessionsPurged: 1, socketsClosed: 0 });
  assert.equal(await repo.findSession("old", T0), null);
  assert.notEqual(await repo.findSession("new", clock.now()), null);
  clock.advance(SESSION_MS);
  assert.equal((await runMaintenance({ repo, clock })).sessionsPurged, 1);
});

test("maintenance runs often enough to matter and rarely enough to be free (#22)", () => {
  assert.ok(MAINTENANCE_EVERY_MS >= 60_000 && MAINTENANCE_EVERY_MS <= 15 * 60_000);
});
