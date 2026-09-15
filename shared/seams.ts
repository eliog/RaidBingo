/**
 * Two of the four seams that must exist from the first commit: the clock and
 * the source of randomness. Injecting them is what lets tests advance time
 * instead of sleeping, and deal a reproducible board without production
 * losing real entropy.
 *
 * The other two seams — Discord and the data store — are interfaces in
 * server/ports.ts.
 */

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export interface Rng {
  /** A uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Production randomness. Boards are dealt from this, never from a seed. */
export const cryptoRng: Rng = {
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
      throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
    }
    // Rejection sampling over whole bytes, so every value is equally likely.
    const range = maxExclusive;
    const bytes = Math.ceil(Math.log2(range) / 8) || 1;
    const limit = Math.floor(256 ** bytes / range) * range;
    const buf = new Uint8Array(bytes);
    for (;;) {
      crypto.getRandomValues(buf);
      let v = 0;
      for (const b of buf) v = v * 256 + b;
      if (v < limit) return v % range;
    }
  },
};

/** Tests only. Deterministic, so a board can be asserted on. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
        throw new RangeError(`maxExclusive must be a positive integer, got ${maxExclusive}`);
      }
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      return Math.floor(r * maxExclusive);
    },
  };
}

/** Tests only. A clock the test moves by hand. */
export function fixedClock(startMs: number): Clock & { advance(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}
