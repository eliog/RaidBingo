import type { Clock } from "../shared/seams.ts";

/**
 * A fixed-window limiter, in memory. Loses its state on restart, which is
 * acceptable: it exists to blunt an enumeration attempt, not to bill anyone.
 */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;

  constructor(clock: Clock, limit: number, windowMs: number) {
    this.#clock = clock;
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Records the attempt. Returns null when allowed, or seconds to wait. */
  check(key: string): number | null {
    const now = this.#clock.now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length >= this.#limit) {
      const oldest = recent[0] as number;
      this.#hits.set(key, recent);
      return Math.max(1, Math.ceil((this.#windowMs - (now - oldest)) / 1000));
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return null;
  }
}
