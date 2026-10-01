/**
 * Housekeeping that no request triggers on its own. Run once at startup and
 * then on a timer from main.ts; tests call it directly with an injected clock.
 */

import type { Repository } from "./ports.ts";
import type { Clock } from "../shared/seams.ts";

export const MAINTENANCE_EVERY_MS = 10 * 60_000;

export interface MaintenanceResult {
  sessionsPurged: number;
  socketsClosed: number;
}

export interface MaintenanceDeps {
  repo: Repository;
  clock: Clock;
  /** The live hub, when there is one. */
  hub?: { recheckSessions(): Promise<number> } | undefined;
}

export async function runMaintenance(deps: MaintenanceDeps): Promise<MaintenanceResult> {
  // An expired session can never be used again, so keeping the row is only a
  // login history nobody needs. First, so trouble with sockets can't skip it.
  const sessionsPurged = await deps.repo.deleteExpiredSessions(deps.clock.now());
  // A purged session reads as gone, so the recheck closes its sockets too.
  const socketsClosed = (await deps.hub?.recheckSessions()) ?? 0;
  return { sessionsPurged, socketsClosed };
}
