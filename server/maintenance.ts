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

export async function runMaintenance(deps: { repo: Repository; clock: Clock }): Promise<MaintenanceResult> {
  // An expired session can never be used again, so keeping the row is only a
  // login history nobody needs.
  const sessionsPurged = await deps.repo.deleteExpiredSessions(deps.clock.now());
  return { sessionsPurged, socketsClosed: 0 };
}
