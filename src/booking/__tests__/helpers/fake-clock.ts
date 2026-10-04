// An auto-advancing clock for throttle tests. `sleep(ms)` moves the clock
// forward by `ms` and resolves on the next microtask, so a burst of gated
// calls runs instantly and every start time is exact. No Jest fake timers:
// they do not cover AbortSignal.timeout and other runtime timers.

export interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Every sleep requested so far, in milliseconds, in order. */
  readonly sleeps: readonly number[];
  /** Sleeps requested but not yet resolved. */
  readonly pending: number;
}

/** A whole second, so HTTP dates built from it carry no lost milliseconds. */
export const FAKE_CLOCK_START_MS = 1_700_000_000_000;

export function createFakeClock(
  startMs: number = FAKE_CLOCK_START_MS
): FakeClock {
  let current = startMs;
  let pending = 0;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      current += Math.max(0, ms);
      pending += 1;
      await Promise.resolve();
      pending -= 1;
    },
    sleeps,
    get pending(): number {
      return pending;
    },
  };
}
