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
    this.#prune(now);
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

  /** Like check(), but records nothing: seconds to wait, or null if under. */
  peek(key: string): number | null {
    const now = this.#clock.now();
    const recent = (this.#hits.get(key) ?? []).filter((t) => now - t < this.#windowMs);
    if (recent.length < this.#limit) return null;
    return Math.max(1, Math.ceil((this.#windowMs - (now - (recent[0] as number))) / 1000));
  }

  #lastPrune = 0;

  /**
   * Keys are per player (and, for chat, per game), so without this every game
   * night would leave entries behind until the next restart. Once a window,
   * drop any key whose newest hit has aged out.
   */
  #prune(now: number): void {
    if (now - this.#lastPrune < this.#windowMs) return;
    this.#lastPrune = now;
    for (const [key, hits] of this.#hits) {
      const newest = hits.at(-1);
      if (newest === undefined || now - newest >= this.#windowMs) this.#hits.delete(key);
    }
  }

  get size(): number {
    return this.#hits.size;
  }
}
